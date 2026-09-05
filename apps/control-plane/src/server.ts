// Bun HTTP server (実装手順書 section 24: listen on 0.0.0.0:$PORT).
// No heavyweight framework — a small pattern router over Bun.serve.

import { authenticate } from "./auth.js";
import type { InternalUser } from "./auth.js";
import type { ControlPlaneDeps } from "./deps.js";
import { ApiError, badRequest, internalError, notFound } from "./errors.js";
import type { Logger } from "@cloud-run-dsh/observability";
import { describeError, newErrorId } from "@cloud-run-dsh/observability";
import * as handlers from "./handlers.js";
import { handleSessionEvents } from "./sse.js";
import {
  AgentInputRefusedError,
  IllegalTransitionError,
  InvalidOperationError,
} from "@cloud-run-dsh/workspace-runtime";

interface Route {
  readonly method: string;
  /** Segments; ":name" captures a parameter. */
  readonly segments: readonly string[];
  readonly handler: (ctx: handlers.RouteContext) => Promise<Response>;
}

const routes: Route[] = [
  { method: "POST", segments: ["v1", "workspaces"], handler: handlers.createWorkspace },
  { method: "GET", segments: ["v1", "workspaces", ":id"], handler: handlers.getWorkspace },
  { method: "DELETE", segments: ["v1", "workspaces", ":id"], handler: handlers.deleteWorkspace },
  { method: "POST", segments: ["v1", "workspaces", ":id", "open"], handler: handlers.openWorkspace },
  { method: "POST", segments: ["v1", "workspaces", ":id", "stop"], handler: handlers.stopWorkspace },
  { method: "GET", segments: ["v1", "workspaces", ":id", "sessions"], handler: handlers.listSessions },
  { method: "POST", segments: ["v1", "workspaces", ":id", "sessions"], handler: handlers.createSession },
  { method: "POST", segments: ["v1", "workspaces", ":id", "checkpoints"], handler: handlers.manualCheckpoint },
  { method: "POST", segments: ["v1", "workspaces", ":id", "controller", "acquire"], handler: handlers.acquireController },
  { method: "POST", segments: ["v1", "workspaces", ":id", "controller", "heartbeat"], handler: handlers.heartbeatController },
  { method: "POST", segments: ["v1", "workspaces", ":id", "controller", "release"], handler: handlers.releaseController },
  { method: "POST", segments: ["v1", "sessions", ":id", "messages"], handler: handlers.postMessage },
  { method: "GET", segments: ["v1", "sessions", ":id", "events"], handler: routeSessionEvents },
  { method: "POST", segments: ["v1", "sessions", ":id", "approvals", ":approvalId"], handler: handlers.postApproval },
  { method: "POST", segments: ["v1", "sessions", ":id", "cancel"], handler: handlers.postCancel },
];

async function routeSessionEvents(ctx: handlers.RouteContext): Promise<Response> {
  // The SSE handler manages auth context itself (needs the resolved user).
  return handleSessionEvents(ctx.request, ctx.params, ctx.url, ctx.deps, ctx.user.id);
}

function match(
  method: string,
  pathSegments: readonly string[],
): { handler: Route["handler"]; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== pathSegments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < route.segments.length; i++) {
      const pattern = route.segments[i]!;
      const actual = pathSegments[i]!;
      if (pattern.startsWith(":")) {
        // Malformed percent-encoding (e.g. /v1/workspaces/%zz) must yield a
        // typed 400, never a URIError -> 500 (deliverable 5).
        try {
          params[pattern.slice(1)] = decodeURIComponent(actual);
        } catch {
          throw badRequest("malformed path segment");
        }
      } else if (pattern !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: route.handler, params };
  }
  return null;
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Correlation context attached to the unexpected-error log (仕様書 section 25
 * keys, best-effort: whatever the catch site could recover). Never sent to
 * the client.
 */
export interface ErrorLogContext {
  readonly method?: string;
  readonly path?: string;
  readonly userId?: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
}

export interface ToErrorResponseOptions {
  /**
   * Structured logger for the unexpected-error path. The logger applies the
   * observability redactor to every value, but callers must still avoid
   * passing secret-carrying objects — only extracted strings (class name,
   * message, stack) plus correlation ids are logged (issue #42 lesson).
   * When absent the 500 mapping still applies, just without the log line.
   */
  readonly logger?: Logger;
  readonly context?: ErrorLogContext;
}

// Re-exported for backward compat: the implementation lives in
// @cloud-run-dsh/observability, shared with the agent host (PR #49 MINOR-1).
export { describeError };

/**
 * Maps any thrown error to a typed JSON error response. No stack traces leak.
 *
 * Unexpected errors -> generic 500 with no internals (仕様書 §26 の秘密保全の
 * 要請による。NOTE: §26 item 7 は workspace 所有権検証であり 500 の根拠では
 * ない — #48 の記載を引き継いだ誤引用だったので番号付けを外した。PR #49
 * MINOR-2) AND a structured server-side log line (issue #48). The 500 body
 * carries a random `errorId` that matches the log line so an operator can
 * correlate a client report with Cloud Logging without the response leaking
 * anything.
 */
export function toErrorResponse(e: unknown, opts: ToErrorResponseOptions = {}): Response {
  if (e instanceof ApiError) {
    return errorResponse(e.status, e.code, e.message);
  }
  // T8 runtime state conflicts -> 409 (wrong state for open/stop/message/etc).
  // IllegalTransitionError is listed explicitly rather than made a subclass
  // of InvalidOperationError (issue #88): it lives in the dependency-free
  // state.ts while InvalidOperationError lives in runtime.ts, and the two
  // are deliberately distinct (recordFailureStateBestEffort chains ONLY
  // IllegalTransitionError as `cause` because it carries nothing but state
  // names). Every escape to this layer is a lost compare-and-set race on
  // the shared row — the caller's view of the state conflicts with another
  // writer's — so 409, never 500.
  if (
    e instanceof AgentInputRefusedError ||
    e instanceof InvalidOperationError ||
    e instanceof IllegalTransitionError
  ) {
    return errorResponse(409, "conflict", e.message);
  }
  // Unexpected errors -> generic 500 with no internals (仕様書 §26; see the
  // MINOR-2 note on toErrorResponse — item 7 is NOT the 500 rule).
  // 16hex newErrorId (not a UUID). History: this was a WORKAROUND for issue
  // #51 (see newErrorId) — #51 is resolved since PR #54 (UUIDs now survive
  // redaction). 16hex is retained as-is (compact, tested via ERROR_ID_RE);
  // a follow-up may switch back to UUIDs.
  const errorId = newErrorId();
  opts.logger?.error("http.unexpected_error", {
    errorId,
    ...describeError(e),
    ...opts.context,
  });
  return new Response(
    JSON.stringify({ error: { code: "internal", message: "internal server error", errorId } }),
    {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

/**
 * Best-effort correlation ids for the unexpected-error log. Route params use
 * `:id` for both workspace and session scopes, so the pathname decides which
 * is which. Never throws (used on the failure path itself).
 *
 * NOTE (PR #49 MINOR-3): only the /v1/sessions/ and /v1/workspaces/ prefixes
 * are distinguished; a future top-level route falls back to method/path/user
 * only. Best-effort by design — the errorId (not these ids) is the
 * correlation key — so no logic change; recorded here instead.
 */
export function errorContextFromRequest(
  method: string,
  pathname: string | undefined,
  params: Record<string, string> | undefined,
  user: InternalUser | undefined,
): ErrorLogContext {
  const ctx: Record<string, string> = {};
  if (method) ctx["method"] = method;
  if (pathname) ctx["path"] = pathname;
  if (user) ctx["userId"] = user.id;
  const id = params?.["id"];
  if (id && pathname) {
    if (pathname.startsWith("/v1/sessions/")) ctx["sessionId"] = id;
    else if (pathname.startsWith("/v1/workspaces/")) ctx["workspaceId"] = id;
  }
  return ctx;
}

export function createFetchHandler(deps: ControlPlaneDeps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    // Recovered on the failure path for the unexpected-error log (issue #48).
    let pathname: string | undefined;
    let user: InternalUser | undefined;
    let params: Record<string, string> | undefined;
    try {
      const url = new URL(request.url);
      pathname = url.pathname;

      // Liveness endpoint (実装手順書 section 24: health responsibility).
      // Not workspace-scoped and NOT meaningful activity (仕様書 section 11).
      //
      // Served on "/livez", NOT "/healthz" (issue #68): Cloud Run's frontend
      // reserves the exact path "/healthz" and answers it with Google's own
      // 404 page without ever reaching the container (measured 2026-09-05:
      // only the exact "/healthz" was hijacked; "/healthz/", "/Healthz",
      // "/healthzz" and "/readyz" all reached the container). A "/healthz"
      // here would look probeable while being unreachable over HTTP from
      // outside — the old comment claiming "it must be probeable by the
      // platform" was wrong for HTTP (only the TCP startup probe, which is
      // a different path into the container, ever succeeded). The k8s
      // "/livez" (liveness) / "/readyz" (readiness) split below keeps the
      // standard vocabulary without the reserved path.
      if (url.pathname === "/livez" && request.method === "GET") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      // Readiness endpoint: honestly reflects degraded capability (e.g. the
      // database being unreachable — an earlier revision named "the
      // production runtime registry being a placeholder" here, but the
      // placeholder was removed in #23). Served before auth,
      // like /livez — it must be probeable by the platform (/readyz reaches
      // the container; only the exact "/healthz" is reserved, see above).
      //
      // Issue #97: the probe may be async — production checks the database
      // with a short-timeout SELECT 1 (createDbReadinessProbe) and the
      // server awaits it. A deployment that answers 200 here while its
      // database is unreachable sends operators down the wrong path (every
      // request 500s behind a "ready" badge), so the honest answer matters
      // more than a fast one. The probe itself caps its latency (timeout +
      // result cache), so awaiting it never hangs this endpoint.
      if (url.pathname === "/readyz" && request.method === "GET") {
        const report = await deps.readiness?.();
        if (report && !report.ready) {
          return new Response(
            JSON.stringify({ status: "not_ready", reason: report.reason }),
            { status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
          );
        }
        return new Response(JSON.stringify({ status: "ready" }), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      const pathSegments = url.pathname.split("/").filter((s) => s.length > 0);

      // 1. Authentication: IAP identity -> internal user (仕様書 section 21).
      user = await authenticate(request.headers, deps);

      const found = match(request.method, pathSegments);
      if (!found) {
        throw notFound(`no route for ${request.method} ${url.pathname}`);
      }
      params = found.params;

      // 2. Handler performs membership + controller checks (仕様書 sections 20/26).
      return await found.handler({
        request,
        params: found.params,
        url,
        deps,
        user,
      });
    } catch (e) {
      return toErrorResponse(e, {
        logger: deps.logger,
        context: errorContextFromRequest(request.method, pathname, params, user),
      });
    }
  };
}

export interface RunningControlPlane {
  readonly port: number;
  stop(): void;
}

/**
 * Bun's maximum `idleTimeout` (seconds). See the note at the Bun.serve call:
 * the 10s default kills long lifecycle requests such as open/stop.
 */
export const SERVER_IDLE_TIMEOUT_SECONDS = 255;

/** Starts the control-plane server on 0.0.0.0:$PORT. */
export function startControlPlane(deps: ControlPlaneDeps, port: number): RunningControlPlane {
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port,
    // Bun.serve defaults idleTimeout to 10 SECONDS and closes the connection
    // when it elapses. POST /v1/workspaces/:id/open legitimately runs for
    // ~60s (Instance create + start + agent-host readiness poll), so with the
    // default every open died mid-flight and Cloud Run turned the truncated
    // response into a bare-text 503 ("The request failed because either the
    // HTTP response was malformed or connection to the instance had an
    // error") — measured on GCP 2026-09-05. 255 is Bun's maximum and sits
    // under Cloud Run's own 300s request timeout, which stays the real bound.
    idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
    fetch: createFetchHandler(deps),
  });
  return {
    port: server.port as number,
    stop: () => server.stop(true),
  };
}

export { internalError };
