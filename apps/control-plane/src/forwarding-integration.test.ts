// Integration proof for issue #22: a real control-plane HTTP server forwards
// to a real agent-host gateway HTTP server over localhost (no GCP, no real
// DB — both sides use their in-memory fakes, but every byte crosses real
// HTTP via the production HttpAgentHostForwarder).
//
// The host's TurnStarter is a recording fake that NEVER appends to the repo,
// so this file proves the single-writer invariant across the wire: exactly
// one `user_message` exists (on the control-plane DB) and the host started
// its turn from the same seq.

import { describe, expect, test } from "bun:test";
import { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import { InMemoryLeaseStore } from "@cloud-run-dsh/controller-lease/testing";
import { InMemoryLogger } from "@cloud-run-dsh/observability";
import { PostgresSessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import type { ActivityKind } from "@cloud-run-dsh/workspace-runtime";
import { composeTestHost, seedWorkspace } from "../../agent-host/src/fakes.js";
import type { AgentTurnInput, TurnStarter } from "../../agent-host/src/gateway.js";
import {
  createControlPlaneDeps,
  createFetchHandler,
  InMemoryMembershipStore,
  RuntimeRegistry,
  SystemClock,
  type WorkspaceRuntimeHandle,
} from "./index.js";
import { HttpAgentHostForwarder } from "./forwarding.js";

class RecordingTurnStarter implements TurnStarter {
  inputs: AgentTurnInput[] = [];
  cancelled: (string | undefined)[] = [];
  approvals: { approvalId: string; decision: string }[] = [];
  async startTurn(input: AgentTurnInput): Promise<void> {
    this.inputs.push(input);
  }
  async cancelTurn(sessionId?: string): Promise<number> {
    this.cancelled.push(sessionId);
    return 1;
  }
  async resolveApproval(approvalId: string, decision: "approved" | "rejected"): Promise<boolean> {
    this.approvals.push({ approvalId, decision });
    return true;
  }
}

/** Minimal READY handle whose Instance is the test agent-host server. */
class TestInstanceHandle implements WorkspaceRuntimeHandle {
  readonly activities: ActivityKind[] = [];
  constructor(private readonly instanceUrl: string) {}
  async open(): Promise<string> {
    return "READY";
  }
  async stop(): Promise<string> {
    return "STOPPED";
  }
  getState(): string {
    return "READY";
  }
  recordActivity(kind: ActivityKind): void {
    this.activities.push(kind);
  }
  async assertAgentInputAllowed(): Promise<void> {}
  async runManualCheckpoint(): Promise<{ skipped: boolean }> {
    return { skipped: false };
  }
  async deleteInstance(): Promise<void> {}
  async getInstanceUrl(): Promise<string | null> {
    return this.instanceUrl;
  }
}

describe("control-plane -> agent-host forwarding over HTTP (issue #22)", () => {
  test("POST /v1/sessions/:id/messages reaches the host and starts the turn exactly once", async () => {
    // ---- control-plane side (real HTTP + production forwarder) ----
    // (Booted first: the workspace id is server-assigned, and the
    // agent-host test instance below is created FOR that workspace —
    // the production shape where one Instance serves one workspace.)
    const executor = new InMemoryFakeExecutor();
    const repo = new PostgresSessionPersistenceRepository(executor);
    const clock = new SystemClock();
    const leases = new ControllerLeaseService({
      store: new InMemoryLeaseStore(),
      clock,
    });
    const membership = new InMemoryMembershipStore();
    const runtimes = new RuntimeRegistry(() => {
      throw new Error("test presets its handle");
    });
    const logger = new InMemoryLogger();
    const deps = createControlPlaneDeps({
      resolveUser: async (identity) =>
        identity.subject === "alice"
          ? { id: "alice", email: "alice@example.com" }
          : null,
      repo,
      leases,
      membership,
      runtimes,
      clock,
      logger,
      messageForwarder: new HttpAgentHostForwarder({
        // No metadata server in tests: the audience-bound mint is stubbed.
        idTokenProvider: async () => "test-id-token",
        logger,
      }),
    });
    const cpServer = Bun.serve({ port: 0, fetch: createFetchHandler(deps) });

    let ahServer: { stop: (closeActiveConnections?: boolean) => void; url: URL } | null =
      null;
    try {
      const cpFetch = (user: string, path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("x-goog-authenticated-user-id", `accounts.google.com:${user}`);
        headers.set("x-goog-authenticated-user-email", `${user}@example.com`);
        return fetch(`${cpServer.url.origin}${path}`, { ...init, headers });
      };

      const created = await cpFetch("alice", "/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo" }),
      });
      expect(created.status).toBe(201);
      const workspaceId = ((await created.json()) as { id: string }).id;

      // ---- agent-host side (real gateway, recording turn starter) ----
      const starter = new RecordingTurnStarter();
      const th = await composeTestHost({ workspaceId }, { turnStarter: starter });
      await seedWorkspace(th);
      await th.host.recover();

      const seenHeaders: Array<{
        authorization: string | null;
        email: string | null;
        userId: string | null;
      }> = [];
      ahServer = Bun.serve({
        port: 0,
        fetch: (req) => {
          seenHeaders.push({
            authorization: req.headers.get("authorization"),
            email: req.headers.get("x-goog-authenticated-user-email"),
            userId: req.headers.get("x-goog-authenticated-user-id"),
          });
          return th.host.gateway.handle(req);
        },
      });

      // The control-plane handle points at the live test Instance.
      runtimes.set(workspaceId, new TestInstanceHandle(ahServer.url.origin));

      const sessionRes = await cpFetch("alice", `/v1/workspaces/${workspaceId}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(sessionRes.status).toBe(201);
      const sessionId = ((await sessionRes.json()) as { id: string }).id;

      const acquire = await cpFetch("alice", `/v1/workspaces/${workspaceId}/controller/acquire`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(acquire.status).toBe(200);

      // ---- the forwarded message ----
      const res = await cpFetch("alice", `/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "read README and summarize" }),
      });
      expect(res.status).toBe(201);
      const event = (await res.json()) as { seq: number; eventType: string };

      // Single writer: exactly one user_message on the control-plane DB …
      const persisted = await repo.readEvents(sessionId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.eventType).toBe("user_message");
      expect(event.seq).toBe(0);

      // … and the host started its turn from THAT event (same seq/content),
      // without appending anything itself (the starter never touches a repo;
      // the host DB holds no session events at all).
      expect(starter.inputs).toHaveLength(1);
      expect(starter.inputs[0]).toEqual({
        workspaceId,
        sessionId,
        seq: 0,
        content: "read README and summarize",
      });
      expect(await th.repository.listSessions(workspaceId)).toHaveLength(0);

      // Auth crossed the wire: invoker ID token + caller identity.
      expect(seenHeaders).toHaveLength(1);
      expect(seenHeaders[0]!.authorization).toBe("Bearer test-id-token");
      expect(seenHeaders[0]!.email).toBe("alice@example.com");
      expect(seenHeaders[0]!.userId).toBe("accounts.google.com:alice");

      // Delivery is traceable in the control-plane log (no secrets).
      expect(
        logger.parsed.some((e) => e["event"] === "control-plane.forward.delivered"),
      ).toBe(true);
    } finally {
      cpServer.stop(true);
      ahServer?.stop(true);
    }
  });

  test("POST /v1/sessions/:id/cancel + /approvals/:approvalId reach the host seams", async () => {
    // Same production shape as the message test: real HTTP on both sides,
    // production HttpAgentHostForwarder, recording starter that never touches
    // a repo (single-writer proof for approval/cancel too).
    const executor = new InMemoryFakeExecutor();
    const repo = new PostgresSessionPersistenceRepository(executor);
    const clock = new SystemClock();
    const leases = new ControllerLeaseService({
      store: new InMemoryLeaseStore(),
      clock,
    });
    const membership = new InMemoryMembershipStore();
    const runtimes = new RuntimeRegistry(() => {
      throw new Error("test presets its handle");
    });
    const logger = new InMemoryLogger();
    const deps = createControlPlaneDeps({
      resolveUser: async (identity) =>
        identity.subject === "alice"
          ? { id: "alice", email: "alice@example.com" }
          : null,
      repo,
      leases,
      membership,
      runtimes,
      clock,
      logger,
      messageForwarder: new HttpAgentHostForwarder({
        idTokenProvider: async () => "test-id-token",
        logger,
      }),
    });
    const cpServer = Bun.serve({ port: 0, fetch: createFetchHandler(deps) });

    let ahServer: { stop: (closeActiveConnections?: boolean) => void; url: URL } | null =
      null;
    try {
      const cpFetch = (user: string, path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("x-goog-authenticated-user-id", `accounts.google.com:${user}`);
        headers.set("x-goog-authenticated-user-email", `${user}@example.com`);
        return fetch(`${cpServer.url.origin}${path}`, { ...init, headers });
      };

      const created = await cpFetch("alice", "/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo" }),
      });
      expect(created.status).toBe(201);
      const workspaceId = ((await created.json()) as { id: string }).id;

      const starter = new RecordingTurnStarter();
      const th = await composeTestHost({ workspaceId }, { turnStarter: starter });
      await seedWorkspace(th);
      await th.host.recover();

      ahServer = Bun.serve({
        port: 0,
        fetch: (req) => th.host.gateway.handle(req),
      });
      runtimes.set(workspaceId, new TestInstanceHandle(ahServer.url.origin));

      const sessionRes = await cpFetch("alice", `/v1/workspaces/${workspaceId}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(sessionRes.status).toBe(201);
      const sessionId = ((await sessionRes.json()) as { id: string }).id;

      const acquire = await cpFetch("alice", `/v1/workspaces/${workspaceId}/controller/acquire`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(acquire.status).toBe(200);

      // ---- the forwarded approval ----
      const approvalRes = await cpFetch("alice", `/v1/sessions/${sessionId}/approvals/ask-7`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });
      expect(approvalRes.status).toBe(201);

      // ---- the forwarded cancel ----
      const cancelRes = await cpFetch("alice", `/v1/sessions/${sessionId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(cancelRes.status).toBe(201);

      // Both reached the host's TurnStarter seams with the right payloads.
      expect(starter.approvals).toEqual([{ approvalId: "ask-7", decision: "rejected" }]);
      expect(starter.cancelled).toEqual([sessionId]);
      // Neither started a turn.
      expect(starter.inputs).toHaveLength(0);

      // Single writer: the control-plane DB holds exactly the two events …
      const persisted = await repo.readEvents(sessionId);
      expect(persisted.map((e) => e.eventType)).toEqual(["approval", "cancel"]);

      // … and the host appended nothing itself (its repo never saw the session).
      expect(await th.repository.readEvents(sessionId)).toHaveLength(0);

      // Both deliveries are traceable by kind.
      const kinds = logger.parsed
        .filter((e) => e["event"] === "control-plane.forward.delivered")
        .map((e) => e["kind"]);
      expect(kinds).toEqual(["approval", "cancel"]);
    } finally {
      cpServer.stop(true);
      ahServer?.stop(true);
    }
  });
});
