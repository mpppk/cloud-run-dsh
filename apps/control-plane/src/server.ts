// Bun HTTP server (実装手順書 section 24: listen on 0.0.0.0:$PORT).
// No heavyweight framework — a small pattern router over Bun.serve.

import { authenticate } from "./auth.js";
import type { ControlPlaneDeps } from "./deps.js";
import { ApiError, badRequest, internalError, notFound } from "./errors.js";
import * as handlers from "./handlers.js";
import { handleSessionEvents } from "./sse.js";
import {
  AgentInputRefusedError,
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

/** Maps any thrown error to a typed JSON error response. No stack traces leak. */
export function toErrorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return errorResponse(e.status, e.code, e.message);
  }
  // T8 runtime state conflicts -> 409 (wrong state for open/stop/message/etc).
  if (e instanceof AgentInputRefusedError || e instanceof InvalidOperationError) {
    return errorResponse(409, "conflict", e.message);
  }
  // Unexpected errors -> generic 500 with no internals (仕様書 section 26 item 7).
  return errorResponse(500, "internal", "internal server error");
}

export function createFetchHandler(deps: ControlPlaneDeps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);

      // Health endpoint (実装手順書 section 24: health responsibility).
      // Not workspace-scoped and NOT meaningful activity (仕様書 section 11).
      if (url.pathname === "/healthz" && request.method === "GET") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      // Readiness endpoint: honestly reflects degraded capability (e.g. the
      // production runtime registry being a placeholder). Served before auth,
      // like /healthz — it must be probeable by the platform.
      if (url.pathname === "/readyz" && request.method === "GET") {
        const report = deps.readiness?.();
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
      const user = await authenticate(request.headers, deps);

      const found = match(request.method, pathSegments);
      if (!found) {
        throw notFound(`no route for ${request.method} ${url.pathname}`);
      }

      // 2. Handler performs membership + controller checks (仕様書 sections 20/26).
      return await found.handler({
        request,
        params: found.params,
        url,
        deps,
        user,
      });
    } catch (e) {
      return toErrorResponse(e);
    }
  };
}

export interface RunningControlPlane {
  readonly port: number;
  stop(): void;
}

/** Starts the control-plane server on 0.0.0.0:$PORT. */
export function startControlPlane(deps: ControlPlaneDeps, port: number): RunningControlPlane {
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch: createFetchHandler(deps),
  });
  return {
    port: server.port as number,
    stop: () => server.stop(true),
  };
}

export { internalError };
