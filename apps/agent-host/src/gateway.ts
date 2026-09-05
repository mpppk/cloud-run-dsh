// Agent Gateway (実装手順書 section 24) — listens on 0.0.0.0:$PORT.
// Responsibilities wired here: request validation, controller check,
// session/agent-input gating, health, SSE heartbeat, activity recording.
// Meaningful activity only for user message / approval / cancel; SSE
// heartbeats and health checks never reset the idle timer (仕様書 section 11).

import type { WorkspaceRuntime } from "@cloud-run-dsh/workspace-runtime";
import { AgentInputRefusedError, IllegalTransitionError, InvalidOperationError } from "@cloud-run-dsh/workspace-runtime";
import { AGENT_HOST_HEALTH_PATH } from "@cloud-run-dsh/workspace-runtime";
import type { LifecycleResult } from "@cloud-run-dsh/workspace-checkpoint";
import type { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import type { Logger } from "@cloud-run-dsh/observability";
import { describeError, newErrorId } from "@cloud-run-dsh/observability";
import type { AgentHostConfig } from "./config.js";
import type { HealthService } from "./health.js";
import { healthResponse } from "./health.js";

const IAP_IDENTITY_HEADER = "x-goog-authenticated-user-email";

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export interface AgentGatewayDeps {
  readonly config: AgentHostConfig;
  readonly health: HealthService;
  readonly runtime: WorkspaceRuntime;
  readonly lease: ControllerLeaseService;
  readonly logger: Logger;
  /**
   * Starts the agent turn for a forwarded user message (issue #22 seam for
   * issue #21: the LLM turn plugs in here).
   *
   * The input is deliberately narrow — workspace/session identity plus the
   * ALREADY-persisted event reference (seq) and its content. Harness and LLM
   * types must NOT leak into this signature (#21 owns them).
   *
   * The implementation MUST return quickly (enqueue the turn, not run it to
   * completion): the control plane awaits this call inside its own request.
   *
   * When absent the gateway answers 503 (turn_not_implemented) so a missing
   * turn never looks delivered. The control plane maps that to its 502.
   */
  readonly turnStarter?: TurnStarter;
  /**
   * Runs one lifecycle checkpoint (issue #72/#75 seam for the manual
   * `checkpoint` route). Wired to the checkpoint scheduler's
   * runLifecycleCheckpoint in production; the gateway runs it inside
   * runtime.runCheckpoint() so a concurrent stop drains it instead of
   * racing it, and the clean-tree skip surfaces as `skipped: true`
   * (still success — the durable snapshot already covers the tree).
   *
   * When absent the gateway answers 503 (checkpoint_not_implemented) so a
   * missing checkpoint never looks taken. The control plane maps that to
   * its 502.
   */
  readonly manualCheckpoint?: () => Promise<LifecycleResult>;
}

/**
 * Narrow turn-start seam (issue #22 -> #21 handoff).
 *
 * `seq` references the `user_message` event the control plane already
 * appended to the shared DB — the host MUST NOT append it again
 * (single-writer invariant: the control plane is the sole writer).
 * `seq` is -1 and `content` is "" only for direct calls that carry no
 * forwarded body (backward compatibility); control-plane forwards always
 * send both.
 */
export interface AgentTurnInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly content: string;
}

export interface TurnStarter {
  startTurn(input: AgentTurnInput): Promise<void>;
  /**
   * Cancels the live turn for one session (issue #21 gateway /cancel seam).
   * With no sessionId, cancels every live turn on this host. Returns how many
   * live turns were cancelled. Optional so message-only starters keep
   * compiling; when absent the gateway keeps its historical accept-only
   * behavior.
   */
  cancelTurn?(sessionId?: string): Promise<number>;
  /**
   * Resolves one pending approval ask (issue #21 gateway /approvals seam).
   * Accepts the DSH-issued `approval/asked` id or the tool call id.
   * Returns true when a known ask was settled.
   */
  resolveApproval?(approvalId: string, decision: ApprovalDecision): Promise<boolean>;
  /**
   * Rehydrates one live agent per persisted session id (issue #39 recovery
   * seam, driven by restoreHarness — NOT by the gateway). Returns the ids
   * actually resumed. Rejects on failure: the caller surfaces it instead of
   * falling back to create, so unrestorable history can never look like a
   * fresh session. Optional so message-only starters keep compiling; when
   * absent the recovery restores harness metadata only (logged).
   */
  resumeSessions?(sessionIds: readonly string[]): Promise<{ resumed: string[] }>;
}

/** HTTP-facing approval decision vocabulary (matches the control plane). */
export type ApprovalDecision = "approved" | "rejected";

/**
 * Historic alias kept for backward compat: the implementation lives in
 * @cloud-run-dsh/observability, shared with the control plane's
 * describeError (PR #49 MINOR-1).
 */
export const describeGatewayError = describeError;

const GATEWAY_ROUTE_RE =
  /^\/workspaces\/([^/]+)(?:\/sessions\/([^/]+))?\/(messages|approvals|cancel|events|prepare-stop|checkpoint)$/;

/**
 * Best-effort route correlation ids for the unexpected-error log. Never
 * throws (it runs on the failure path itself); yields {} when the URL or
 * path cannot be parsed.
 */
export function tryParseRouteIds(request: Request): {
  workspaceId?: string;
  sessionId?: string;
  userId?: string;
} {
  try {
    const url = new URL(request.url);
    const out: { workspaceId?: string; sessionId?: string; userId?: string } = {};
    const match = url.pathname.match(GATEWAY_ROUTE_RE);
    if (match?.[1]) out.workspaceId = match[1];
    if (match?.[2]) out.sessionId = match[2];
    const identity = request.headers.get(IAP_IDENTITY_HEADER);
    if (identity) out.userId = identity;
    return out;
  } catch {
    return {};
  }
}

export class AgentGateway {
  constructor(private readonly deps: AgentGatewayDeps) {}

  /**
   * Entry point for the HTTP server (Bun.serve fetch handler).
   *
   * Unexpected throws anywhere below used to escape to the runtime with no
   * structured log (issue #48, same defect as the control plane): the client
   * saw a bare 500 and Cloud Logging showed nothing. They are now logged
   * (redacted, with class/message/stack + correlation ids) and answered with
   * a generic 500 carrying the matching errorId.
   */
  async handle(request: Request): Promise<Response> {
    const preParsed = tryParseRouteIds(request);
    try {
      return await this.route(request);
    } catch (e) {
      const errorId = newErrorId();
      this.deps.logger.error("gateway.unexpected_error", {
        errorId,
        ...describeGatewayError(e),
        ...preParsed,
      });
      return this.json(500, { error: "internal server error", errorId });
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // External health (issue #68): served on AGENT_HOST_HEALTH_PATH, NOT
    // "/healthz". Cloud Run's frontend reserves the exact path "/healthz"
    // and answers it with Google's own 404 page without ever reaching this
    // container, so polling "/healthz" can never succeed no matter how
    // healthy the host is. See AGENT_HOST_HEALTH_PATH for the measurement.
    if (url.pathname === AGENT_HOST_HEALTH_PATH) {
      if (request.method !== "GET") return this.methodNotAllowed();
      // Health checks are NOT meaningful activity (仕様書 section 11).
      return healthResponse(this.deps.health.snapshot());
    }

    // TRUST ASSUMPTION (仕様書 section 21 / 実装手順書 section 25, updated
    // for issue #22): identity is accepted from the IAP-set headers on
    // presence alone. The host is NO LONGER only reachable behind IAP: the
    // control plane calls this gateway directly (service-to-service) and
    // sets these headers itself when forwarding.
    //
    // The trust root for forwarded identity is therefore NOT "IAP
    // strips/overwrites this header" — it is the Instance's INVOKER IAM,
    // which admits only the control-plane service account. A forged header
    // from any other caller cannot reach this container because the
    // platform edge rejects it first. Consequently the invoker IAM binding
    // is the SOLE foundation of this trust: loosening it to any other
    // caller immediately enables identity spoofing.
    //
    // (No IAP brand / load balancer exists in this milestone — see issue
    // #31 user tasks. The only thing guarding this host today is invoker
    // IAM. Resolving the authenticated identity to an internal user and
    // authorizing it (user → workspace membership → authorization) remains
    // the CONTROL PLANE's responsibility (T9); this host deliberately does
    // not duplicate membership resolution, and the workspace-id match below
    // is the only host-side authorization.)
    const identity = request.headers.get(IAP_IDENTITY_HEADER);
    if (!identity) {
      return this.json(401, { error: "unauthenticated: missing IAP identity" });
    }

    const match = url.pathname.match(GATEWAY_ROUTE_RE);
    if (!match) return this.json(404, { error: "not found" });
    const [, workspaceId, sessionId, action] = match as unknown as [
      string,
      string,
      string | undefined,
      string,
    ];

    // Workspace authorization: the host serves exactly one workspace.
    if (workspaceId !== this.deps.config.workspaceId) {
      return this.json(403, { error: "workspace mismatch" });
    }

    if (request.method === "GET" && action === "events") {
      return this.sseStream(sessionId ?? "default", identity);
    }
    if (request.method !== "POST") return this.methodNotAllowed();

    // Controller-lease decision (issue #72): the check STAYS for the two
    // lifecycle routes below. It is NOT caller authorization — the control
    // plane already authenticated the caller and checked workspace
    // membership before forwarding. It is generation fencing (仕様書
    // section 26 item 8): this host adopted the open-established lease, so
    // a request arriving while another controller holds the lease comes
    // from a stale generation (or a second host) and must NOT mutate
    // checkpoint/sandbox state. A fenced-out prepare-stop fails the
    // control-plane stop with 409 instead of silently checkpointing the
    // wrong generation's workspace.
    const leaseRefused = await this.assertControllerLease();
    if (leaseRefused) return leaseRefused;

    switch (action) {
      case "messages":
        return this.agentInput(request, workspaceId, sessionId, identity, "user_message");
      case "approvals":
        return this.agentInput(request, workspaceId, sessionId, identity, "approval");
      case "cancel":
        return this.agentInput(request, workspaceId, sessionId, identity, "workspace_operation");
      case "prepare-stop":
        // Lifecycle (issue #72): deliberately NOT via agentInput() — that
        // path is for user input and assertAgentInputAllowed() refuses
        // STOPPING, which is exactly the state a stop preparation runs in.
        return this.prepareStop(workspaceId, identity);
      case "checkpoint":
        return this.manualCheckpoint(workspaceId, identity);
      default:
        return this.json(404, { error: "not found" });
    }
  }

  private async assertControllerLease(): Promise<Response | null> {
    const lease = await this.deps.lease.getActive(this.deps.config.workspaceId);
    if (!lease || lease.controllerId !== this.deps.config.controllerId) {
      return this.json(409, { error: "controller lease not held by this host" });
    }
    return null;
  }

  /**
   * Stop preparation for the control plane (issue #72:
   * `POST /workspaces/:id/prepare-stop`): drains in-flight turns, runs the
   * lifecycle checkpoint, flushes session persistence and deletes the
   * sandbox via runtime.prepareStop(). Leaves STOPPING — the caller owns
   * the instance stop that follows.
   *
   * Status contract the control plane branches on: 200 prepared:true means
   * "safe to stop the instance"; 502 prepared:false with
   * state CHECKPOINT_FAILED means "do NOT stop — the workspace was never
   * saved"; 409 means "wrong state/generation, operator action needed".
   */
  private async prepareStop(workspaceId: string, identity: string): Promise<Response> {
    let state: string;
    try {
      state = await this.deps.runtime.prepareStop();
    } catch (e) {
      // Issue #88: a lost compare-and-set race on the shared row surfaces
      // as IllegalTransitionError (another stop won the transition while
      // this one was in flight). That is a caller-visible state conflict,
      // not an internal failure, so it joins InvalidOperationError at 409 —
      // matching this route's contract ("wrong state/generation, operator
      // action needed"). Anything else still throws through to the generic
      // 500 path in handle().
      if (e instanceof InvalidOperationError || e instanceof IllegalTransitionError) {
        return this.json(409, {
          prepared: false,
          state: this.deps.runtime.getState(),
          error: e.message,
        });
      }
      throw e;
    }
    if (state === "CHECKPOINT_FAILED") {
      this.deps.logger.error("gateway.prepare_stop.checkpoint_failed", {
        userId: identity,
        workspaceId,
        state,
      });
      return this.json(502, {
        prepared: false,
        state,
        error: "lifecycle checkpoint failed — the workspace was not saved, instance stop refused",
      });
    }
    this.deps.logger.info("gateway.prepare_stop.prepared", {
      userId: identity,
      workspaceId,
      state,
    });
    return this.json(200, { prepared: true, state });
  }

  /**
   * Manual checkpoint trigger (issue #75:
   * `POST /workspaces/:id/checkpoint`): runs one lifecycle checkpoint as a
   * tracked operation so a concurrent stop drains it instead of racing it.
   * `skipped: true` (clean tree, nothing written) is still success — the
   * durable snapshot already covers the tree (issue #72 bathwater rule).
   */
  private async manualCheckpoint(workspaceId: string, identity: string): Promise<Response> {
    const trigger = this.deps.manualCheckpoint;
    if (!trigger) {
      this.deps.logger.error("gateway.checkpoint.not_implemented", {
        userId: identity,
        workspaceId,
      });
      return this.json(503, {
        error: "checkpoint not implemented: no checkpoint trigger is wired",
        code: "checkpoint_not_implemented",
        checkpointed: false,
      });
    }
    let result: LifecycleResult;
    try {
      result = await this.deps.runtime.runCheckpoint(trigger);
    } catch (e) {
      if (e instanceof AgentInputRefusedError) {
        return this.json(409, {
          checkpointed: false,
          state: this.deps.runtime.getState(),
          error: e.message,
        });
      }
      throw e;
    }
    const state = this.deps.runtime.getState();
    if (!result.ok) {
      this.deps.logger.error("gateway.checkpoint.failed", {
        userId: identity,
        workspaceId,
        state,
        error: result.error.message,
        ...describeGatewayError(result.error),
      });
      return this.json(502, {
        checkpointed: false,
        state,
        error: "lifecycle checkpoint failed — no durable snapshot was written",
      });
    }
    this.deps.logger.info("gateway.checkpoint.completed", {
      userId: identity,
      workspaceId,
      state,
      skipped: result.skipped,
    });
    return this.json(200, { checkpointed: true, skipped: result.skipped, state });
  }

  private async agentInput(
    request: Request,
    workspaceId: string,
    sessionId: string | undefined,
    identity: string,
    activity: "user_message" | "approval" | "workspace_operation",
  ): Promise<Response> {
    if (!sessionId && activity !== "workspace_operation") {
      return this.json(400, { error: "sessionId required" });
    }
    try {
      // Issue #122: awaited — the gate reloads the persisted row, so it
      // agrees with what the control plane's GET serves from the same row.
      await this.deps.runtime.assertAgentInputAllowed();
    } catch (e) {
      if (e instanceof AgentInputRefusedError) {
        return this.json(409, { error: `agent input refused in state ${e.state}` });
      }
      throw e;
    }
    if (activity === "user_message") {
      return this.startTurn(request, workspaceId, sessionId!, identity);
    }
    // Meaningful activity (仕様書 section 11).
    this.deps.runtime.recordActivity(activity);
    // Issue #21 turn effects (cancel / approval decision): additive to the
    // historical accept-only behavior — routes, methods, and status codes are
    // unchanged. Without a capable starter the response is exactly the old
    // `{accepted, sessionId, activity}` 202.
    const turnEffect = await this.applyTurnEffect(request, workspaceId, sessionId, activity);
    this.deps.logger.info("gateway.request.accepted", {
      userId: identity,
      sessionId,
      event_detail: activity,
      ...turnEffect,
    });
    return this.json(202, { accepted: true, sessionId, activity, ...turnEffect });
  }

  /**
   * Applies the issue #21 turn effect for approval/cancel inputs. Never
   * throws: a failing effect is logged and the acceptance stands (the
   * operation itself was recorded).
   */
  private async applyTurnEffect(
    request: Request,
    workspaceId: string,
    sessionId: string | undefined,
    activity: "approval" | "workspace_operation",
  ): Promise<Record<string, unknown>> {
    const starter = this.deps.turnStarter;
    try {
      if (activity === "approval" && sessionId !== undefined) {
        const resolve = starter?.resolveApproval;
        if (!resolve) return {};
        const body = await readApprovalBody(request);
        if (!body) {
          this.deps.logger.warn("gateway.approval.ignored", {
            workspaceId,
            sessionId,
            reason: "missing or malformed approval body (want {approvalId, decision})",
          });
          return {};
        }
        const approvalResolved = await resolve.call(starter, body.approvalId, body.decision);
        return { approvalResolved };
      }
      if (activity === "workspace_operation") {
        const cancel = starter?.cancelTurn;
        if (!cancel) return {};
        const turnsCancelled = await cancel.call(starter, sessionId);
        return { turnsCancelled };
      }
    } catch (e) {
      this.deps.logger.error("gateway.turn_effect.failed", {
        workspaceId,
        sessionId,
        event_detail: activity,
        error: e instanceof Error ? e.message : String(e),
        ...describeGatewayError(e),
      });
    }
    return {};
  }

  /**
   * Starts the agent turn for a forwarded user message via the TurnStarter
   * seam (issue #22 -> #21). The `user_message` event itself is NEVER
   * appended here — the control plane already wrote it (single writer).
   */
  private async startTurn(
    request: Request,
    workspaceId: string,
    sessionId: string,
    identity: string,
  ): Promise<Response> {
    const starter = this.deps.turnStarter;
    let seq = -1;
    let content = "";
    try {
      const parsed = await readForwardedBody(request);
      if (parsed) {
        if (parsed.sessionId !== undefined && parsed.sessionId !== sessionId) {
          return this.json(400, { error: "sessionId mismatch between path and body" });
        }
        seq = parsed.seq;
        content = parsed.content;
      }
    } catch (e) {
      return this.json(400, {
        error: e instanceof Error ? e.message : "invalid request body",
      });
    }
    if (!starter) {
      // No turn implementation is wired (issue #21 landed in PR #38 and
      // production always wires HarnessTurnStarter in index.ts, so this is
      // now a defensive path for starter-less compositions such as unit
      // tests): say so OUT LOUD (503 + explicit code + structured log)
      // instead of 202.
      // A 202 here would re-create the exact "looks delivered but nothing
      // runs" failure the control-plane forwarding exists to remove.
      this.deps.logger.error("gateway.turn.not_implemented", {
        userId: identity,
        workspaceId,
        sessionId,
        seq,
      });
      return this.json(503, {
        error: "turn not implemented: no TurnStarter is wired (issue #21)",
        code: "turn_not_implemented",
        sessionId,
      });
    }
    try {
      await starter.startTurn({ workspaceId, sessionId, seq, content });
    } catch (e) {
      // Logged (not just counted): the control plane maps this to its 502,
      // so without this line the turn failure would be untraceable (issue #48).
      const errorId = newErrorId();
      this.deps.logger.error("gateway.turn.failed", {
        errorId,
        userId: identity,
        workspaceId,
        sessionId,
        seq,
        error: e instanceof Error ? e.message : String(e),
        ...describeGatewayError(e),
      });
      return this.json(500, { error: "turn failed to start", errorId });
    }
    // Meaningful activity (仕様書 section 11).
    this.deps.runtime.recordActivity("user_message");
    this.deps.logger.info("gateway.request.accepted", {
      userId: identity,
      sessionId,
      event_detail: "user_message",
      turn_started: true,
      seq,
    });
    return this.json(202, {
      accepted: true,
      sessionId,
      activity: "user_message",
      turnStarted: true,
      seq,
    });
  }

  private sseStream(sessionId: string, identity: string): Response {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue(encoder.encode(`event: open\ndata: ${sessionId}\n\n`));
        timer = setInterval(() => {
          // SSE heartbeat — recorded but NOT meaningful (仕様書 section 11).
          this.deps.runtime.recordActivity("sse_heartbeat");
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            if (timer) clearInterval(timer);
          }
        }, SSE_HEARTBEAT_INTERVAL_MS);
      },
      cancel: () => {
        if (timer) clearInterval(timer);
      },
    });
    this.deps.logger.info("gateway.sse.opened", { userId: identity, sessionId });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private methodNotAllowed(): Response {
    return this.json(405, { error: "method not allowed" });
  }

  private json(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Reads the control-plane forward payload. Empty bodies (direct callers,
 * older tests) yield null and the turn starts with unknown seq/content.
 * A present-but-malformed body is a 400 — silently ignoring it would
 * start a turn for the wrong event.
 */
async function readForwardedBody(
  request: Request,
): Promise<{ sessionId?: string; seq: number; content: string } | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new Error("unreadable request body");
  }
  if (!text.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("request body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("request body must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record["seq"] === undefined || record["content"] === undefined) {
    throw new Error("request body must carry the forwarded event ('seq' and 'content')");
  }
  if (typeof record["seq"] !== "number" || !Number.isInteger(record["seq"])) {
    throw new Error("field 'seq' must be an integer");
  }
  if (typeof record["content"] !== "string") {
    throw new Error("field 'content' must be a string");
  }
  const sessionId = record["sessionId"];
  if (sessionId !== undefined && typeof sessionId !== "string") {
    throw new Error("field 'sessionId' must be a string");
  }
  return {
    sessionId,
    seq: record["seq"] as number,
    content: record["content"] as string,
  };
}

/**
 * Reads the approval-decision body (`{approvalId, decision?}`). Empty bodies
 * and malformed payloads yield null — the gateway keeps its historical
 * accept-only 202 in that case (logged by the caller) instead of failing an
 * operation it already recorded.
 */
async function readApprovalBody(
  request: Request,
): Promise<{ approvalId: string; decision: ApprovalDecision } | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record["approvalId"] !== "string" || record["approvalId"] === "") return null;
  const decision = record["decision"] === undefined ? "approved" : record["decision"];
  if (decision !== "approved" && decision !== "rejected") return null;
  return { approvalId: record["approvalId"] as string, decision };
}

export type { InvalidOperationError };
