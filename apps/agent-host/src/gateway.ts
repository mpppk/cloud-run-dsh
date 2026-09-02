// Agent Gateway (実装手順書 section 24) — listens on 0.0.0.0:$PORT.
// Responsibilities wired here: request validation, controller check,
// session/agent-input gating, health, SSE heartbeat, activity recording.
// Meaningful activity only for user message / approval / cancel; SSE
// heartbeats and health checks never reset the idle timer (仕様書 section 11).

import type { WorkspaceRuntime } from "@cloud-run-dsh/workspace-runtime";
import { AgentInputRefusedError } from "@cloud-run-dsh/workspace-runtime";
import type { InvalidOperationError } from "@cloud-run-dsh/workspace-runtime";
import type { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import type { Logger } from "@cloud-run-dsh/observability";
import type { AgentHostConfig } from "./config.js";
import type { HealthService } from "./health.js";
import { healthzResponse } from "./health.js";

const IAP_IDENTITY_HEADER = "x-goog-authenticated-user-email";

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export interface AgentGatewayDeps {
  readonly config: AgentHostConfig;
  readonly health: HealthService;
  readonly runtime: WorkspaceRuntime;
  readonly lease: ControllerLeaseService;
  readonly logger: Logger;
}

export class AgentGateway {
  constructor(private readonly deps: AgentGatewayDeps) {}

  /** Entry point for the HTTP server (Bun.serve fetch handler). */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      if (request.method !== "GET") return this.methodNotAllowed();
      // Health checks are NOT meaningful activity (仕様書 section 11).
      return healthzResponse(this.deps.health.snapshot());
    }

    const identity = request.headers.get(IAP_IDENTITY_HEADER);
    if (!identity) {
      return this.json(401, { error: "unauthenticated: missing IAP identity" });
    }

    const match = url.pathname.match(/^\/workspaces\/([^/]+)(?:\/sessions\/([^/]+))?\/(messages|approvals|cancel|events)$/);
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

    const leaseRefused = await this.assertControllerLease();
    if (leaseRefused) return leaseRefused;

    switch (action) {
      case "messages":
        return this.agentInput(sessionId, identity, "user_message");
      case "approvals":
        return this.agentInput(sessionId, identity, "approval");
      case "cancel":
        return this.agentInput(sessionId, identity, "workspace_operation");
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

  private async agentInput(
    sessionId: string | undefined,
    identity: string,
    activity: "user_message" | "approval" | "workspace_operation",
  ): Promise<Response> {
    if (!sessionId && activity !== "workspace_operation") {
      return this.json(400, { error: "sessionId required" });
    }
    try {
      this.deps.runtime.assertAgentInputAllowed();
    } catch (e) {
      if (e instanceof AgentInputRefusedError) {
        return this.json(409, { error: `agent input refused in state ${e.state}` });
      }
      throw e;
    }
    // Meaningful activity (仕様書 section 11).
    this.deps.runtime.recordActivity(activity);
    this.deps.logger.info("gateway.request.accepted", {
      userId: identity,
      sessionId,
      event_detail: activity,
    });
    return this.json(202, { accepted: true, sessionId, activity });
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

export type { InvalidOperationError };
