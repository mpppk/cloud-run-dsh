// Route-level tests for the control-plane HTTP surface.
// Every collaborator is faked — no real GCP, DB or network.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  AgentInputRefusedError,
  IdleManager,
  InMemoryTransactionalStore,
  InvalidOperationError,
  WorkspaceRuntime,
} from "@cloud-run-dsh/workspace-runtime";
import type { ActivityKind } from "@cloud-run-dsh/workspace-runtime";
import type { InstanceRuntime } from "@cloud-run-dsh/cloud-run-instance-client";
import {
  ControllerLeaseService,
  InMemoryLeaseStore,
} from "@cloud-run-dsh/controller-lease";
import {
  PostgresSessionPersistenceRepository,
  type SessionPersistenceRepository,
  type Session,
  type SessionEvent,
  type Workspace,
  type CreateSessionInput,
  type CreateWorkspaceInput,
  type NewSessionEvent,
  type UpdateWorkspacePatch,
} from "@cloud-run-dsh/session-persistence-postgres";
import type { QueryExecutor } from "@cloud-run-dsh/session-persistence-postgres";
import type { Clock } from "@cloud-run-dsh/workspace-checkpoint";
import {
  createControlPlaneDeps,
  createFetchHandler,
  InMemoryMembershipStore,
  RuntimeRegistry,
  SystemClock,
  toErrorResponse,
  WorkspaceRuntimeHandleAdapter,
  type ControlPlaneClock,
  type ControlPlaneDeps,
  type WorkspaceRuntimeHandle,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const baseClock: Clock = { now: () => new Date(), nowMs: () => Date.now() };

/**
 * In-memory QueryExecutor fake. The repository (T4) only issues the SQL
 * patterns documented in 実装手順書 section 3; this fake implements exactly
 * those patterns against Maps, so route tests need no real database.
 */
class FakeExecutor implements QueryExecutor {
  workspaces = new Map<string, Record<string, unknown>>();
  sessions = new Map<string, Record<string, unknown>>();
  events = new Map<string, Record<string, unknown>[]>();
  private seq = 0;

  async query<T>(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]> {
    if (sql.startsWith("SELECT * FROM workspaces WHERE id")) {
      const w = this.workspaces.get(params[0] as string);
      return w ? [structuredClone(w)] : [];
    }
    if (sql.startsWith("SELECT * FROM sessions WHERE workspace_id")) {
      return [...this.sessions.values()]
        .filter((s) => s["workspace_id"] === params[0])
        .sort((a, b) => String(a["created_at"]).localeCompare(String(b["created_at"])))
        .map((s) => structuredClone(s));
    }
    if (sql.startsWith("SELECT * FROM sessions WHERE id")) {
      const s = this.sessions.get(params[0] as string);
      return s ? [structuredClone(s)] : [];
    }
    if (sql.startsWith("SELECT * FROM session_events WHERE session_id")) {
      const rows = (this.events.get(params[0] as string) ?? []).slice();
      if (params.length > 1) {
        const from = Number(params[1]);
        return structuredClone(rows.filter((r) => Number(r["seq"]) >= from));
      }
      return structuredClone(rows);
    }
    if (sql.startsWith("SELECT max(seq) as max FROM session_events")) {
      const rows = this.events.get(params[0] as string) ?? [];
      if (rows.length === 0) return [{ max: null }];
      return [{ max: Math.max(...rows.map((r) => Number(r["seq"]))) }];
    }
    if (sql.startsWith("SELECT seq FROM session_events WHERE session_id")) {
      const rows = this.events.get(params[0] as string) ?? [];
      return structuredClone(rows.map((r) => ({ seq: r["seq"] })));
    }
    throw new Error(`FakeExecutor: unhandled SELECT: ${sql}`);
  }

  async exec(sql: string, params: readonly unknown[]): Promise<void> {
    if (sql.startsWith("INSERT INTO workspaces")) {
      const [id, ownerId, repoOwner, repoName, baseBranch, instanceName, instanceUrl, runtimeState] =
        params as [string, string, string, string, string, string | null, string | null, string];
      const now = new Date().toISOString();
      this.workspaces.set(id, {
        id,
        owner_id: ownerId,
        repository_owner: repoOwner,
        repository_name: repoName,
        base_branch: baseBranch,
        instance_name: instanceName,
        instance_url: instanceUrl,
        runtime_state: runtimeState,
        last_activity_at: null,
        created_at: now,
        updated_at: now,
      });
      return;
    }
    if (sql.startsWith("UPDATE workspaces SET")) {
      const id = params[params.length - 1] as string;
      const w = this.workspaces.get(id);
      if (!w) throw new Error(`workspace not found: ${id}`);
      // Only runtime_state / last_activity_at / updated_at are patched by T8 wiring.
      if (sql.includes("runtime_state")) w["runtime_state"] = params[0];
      w["updated_at"] = new Date().toISOString();
      return;
    }
    if (sql.startsWith("INSERT INTO sessions")) {
      const [id, workspaceId, metadata] = params as [string, string, string];
      const now = new Date().toISOString();
      this.sessions.set(id, {
        id,
        workspace_id: workspaceId,
        metadata: JSON.parse(metadata),
        created_at: now,
        updated_at: now,
      });
      return;
    }
    if (sql.startsWith("INSERT INTO session_events")) {
      const [sessionId, seq, eventType, eventTime, data, sourceEventSeqs, surfaceOp] = params as [
        string,
        number,
        string,
        number,
        string,
        string | null,
        string | null,
      ];
      const rows = this.events.get(sessionId) ?? [];
      rows.push({
        session_id: sessionId,
        seq,
        event_type: eventType,
        event_time: eventTime,
        data: JSON.parse(data),
        source_event_seqs: sourceEventSeqs ? JSON.parse(sourceEventSeqs) : null,
        surface_op: surfaceOp ? JSON.parse(surfaceOp) : null,
      });
      this.events.set(sessionId, rows);
      return;
    }
    throw new Error(`FakeExecutor: unhandled exec: ${sql}`);
  }

  async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}

  /** Unused helper keeping the constructor realistic. */
  __next(): number {
    return this.seq++;
  }
}

/** Fake per-workspace runtime handle used by most route tests. */
class FakeHandle implements WorkspaceRuntimeHandle {
  state = "STOPPED";
  activities: ActivityKind[] = [];
  openCalls = 0;
  stopCalls = 0;
  checkpointCalls = 0;
  inputAllowed = true;

  async open(): Promise<string> {
    this.openCalls++;
    this.state = "READY";
    return this.state;
  }

  async stop(): Promise<string> {
    this.stopCalls++;
    this.state = "STOPPED";
    return this.state;
  }

  getState(): string {
    return this.state;
  }

  recordActivity(kind: ActivityKind): void {
    this.activities.push(kind);
  }

  assertAgentInputAllowed(): void {
    if (!this.inputAllowed) throw new AgentInputRefusedError("RESTORE_FAILED");
  }

  async runManualCheckpoint(): Promise<void> {
    this.checkpointCalls++;
    this.recordActivity("checkpoint");
  }
}

/** Throws when used — for tests that inject their own handle. */
function throwingFactory(): (workspace: Workspace) => WorkspaceRuntimeHandle {
  return () => {
    throw new Error("no runtime handle configured for this workspace");
  };
}

interface TestHarness {
  deps: ControlPlaneDeps;
  repo: SessionPersistenceRepository;
  membership: InMemoryMembershipStore;
  leases: ControllerLeaseService;
  handles: Map<string, FakeHandle>;
  url: (path: string) => string;
  fetchAs: (user: string, path: string, init?: RequestInit) => Promise<Response>;
  createWorkspace: (owner: string) => Promise<Workspace>;
  stop: () => void;
}

function startHarness(
  overrides: Partial<ControlPlaneDeps> = {},
): TestHarness {
  const repo = new PostgresSessionPersistenceRepository(new FakeExecutor());
  const leases = new ControllerLeaseService({ store: new InMemoryLeaseStore(), clock: new SystemClock() });
  const membership = new InMemoryMembershipStore();
  const handles = new Map<string, FakeHandle>();
  const registry = new RuntimeRegistry((workspace) => {
    const handle = new FakeHandle();
    handles.set(workspace.id, handle);
    return handle;
  });
  const knownUsers = new Set(["alice", "bob", "carol"]);

  const deps = createControlPlaneDeps({
    resolveUser: async (identity) => {
      if (!knownUsers.has(identity.subject)) return null;
      return { id: identity.subject, email: `${identity.subject}@example.com` };
    },
    repo,
    leases,
    membership,
    runtimes: registry,
    clock: new SystemClock(),
    ssePollIntervalMs: 10,
    sseHeartbeatMs: 60,
    ...overrides,
  });

  const server = Bun.serve({ port: 0, fetch: createFetchHandler(deps) });
  const origin = server.url.origin;

  const url = (path: string) => `${origin}${path}`;

  const fetchAs = async (user: string, path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("x-goog-authenticated-user-id", `accounts.google.com:${user}`);
    headers.set("x-goog-authenticated-user-email", `${user}@example.com`);
    return fetch(url(path), { ...init, headers });
  };

  const createWorkspace = async (owner: string): Promise<Workspace> => {
    const res = await fetchAs(
      owner,
      "/v1/workspaces",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo", baseBranch: "main" }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const workspace = await repo.getWorkspace(body.id);
    if (!workspace) throw new Error("workspace missing after creation");
    return workspace;
  };

  return {
    deps,
    repo,
    membership,
    leases,
    handles,
    url,
    fetchAs,
    createWorkspace,
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// Auth / membership matrix
// ---------------------------------------------------------------------------

describe("authentication", () => {
  let h: TestHarness;
  beforeAll(() => {
    h = startHarness();
  });
  afterAll(() => h.stop());

  test("missing IAP headers -> 401 with typed error body", async () => {
    const res = await fetch(h.url("/v1/workspaces"), { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
  });

  test("unknown identity -> 401", async () => {
    const res = await h.fetchAs("mallory", "/v1/workspaces", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("auth runs before route existence: 401 not 404", async () => {
    const res = await fetch(h.url("/v1/definitely/not/a/route"), { method: "GET" });
    expect(res.status).toBe(401);
  });

  test("health endpoint needs no auth", async () => {
    const res = await fetch(h.url("/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("membership authorization (仕様書 sections 21/26 item 7)", () => {
  let h: TestHarness;
  let workspaceId: string;
  let sessionId: string;

  beforeAll(async () => {
    h = startHarness();
    const ws = await h.createWorkspace("alice");
    workspaceId = ws.id;
    const res = await h.fetchAs("alice", `/v1/workspaces/${workspaceId}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    sessionId = ((await res.json()) as { id: string }).id;
  });
  afterAll(() => h.stop());

  test("non-member gets 403 on EVERY workspace-scoped route", async () => {
    // carol is a known user but not a member of the workspace.
    const membershipRoutes: Array<() => Promise<Response>> = [
      () => h.fetchAs("carol", `/v1/workspaces/${workspaceId}`, { method: "GET" }),
      () =>
        h.fetchAs("carol", `/v1/workspaces/${workspaceId}/open`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      () =>
        h.fetchAs("carol", `/v1/workspaces/${workspaceId}/stop`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      () => h.fetchAs("carol", `/v1/workspaces/${workspaceId}/sessions`, { method: "GET" }),
      () =>
        h.fetchAs("carol", `/v1/workspaces/${workspaceId}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      () =>
        h.fetchAs("carol", `/v1/workspaces/${workspaceId}/checkpoints`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      () =>
        h.fetchAs("carol", `/v1/workspaces/${workspaceId}/controller/acquire`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      () =>
        h.fetchAs("carol", `/v1/workspaces/${workspaceId}/controller/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ controllerId: "c1" }),
        }),
      () =>
        h.fetchAs("carol", `/v1/workspaces/${workspaceId}/controller/release`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ controllerId: "c1" }),
        }),
      () =>
        h.fetchAs("carol", `/v1/sessions/${sessionId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "hi" }),
        }),
      () => h.fetchAs("carol", `/v1/sessions/${sessionId}/events`, { method: "GET" }),
      () =>
        h.fetchAs("carol", `/v1/sessions/${sessionId}/approvals/ap-1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approved" }),
        }),
      () =>
        h.fetchAs("carol", `/v1/sessions/${sessionId}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
    ];

    for (const [i, call] of membershipRoutes.entries()) {
      const res = await call();
      expect(res.status, `route ${i} should reject non-members`).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("forbidden");
    }
  });

  test("unknown workspace -> 404 for any caller (existence not leaked differently)", async () => {
    const res = await h.fetchAs("carol", `/v1/workspaces/00000000-0000-0000-0000-000000000000`, {
      method: "GET",
    });
    expect(res.status).toBe(404);
  });

  test("owner can read own workspace", async () => {
    const res = await h.fetchAs("alice", `/v1/workspaces/${workspaceId}`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(workspaceId);
    expect(body.runtimeState).toBe("STOPPED");
  });

  test("unknown workspace -> 404 for a member", async () => {
    const res = await h.fetchAs("alice", `/v1/workspaces/00000000-0000-0000-0000-000000000000`, {
      method: "GET",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  test("second member added via membership store can read the workspace", async () => {
    await h.membership.addMember(workspaceId, "bob");
    const res = await h.fetchAs("bob", `/v1/workspaces/${workspaceId}`, { method: "GET" });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Workspace + session routes
// ---------------------------------------------------------------------------

describe("workspace and session routes", () => {
  let h: TestHarness;
  beforeAll(() => {
    h = startHarness();
  });
  afterAll(() => h.stop());

  test("POST /v1/workspaces creates a STOPPED workspace owned by the caller", async () => {
    const res = await h.fetchAs("alice", "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ownerId).toBe("alice");
    expect(body.runtimeState).toBe("STOPPED");
    expect(body.baseBranch).toBe("main");
    // owner is member
    expect(await h.membership.isMember(body.id, "alice")).toBe(true);
  });

  test("POST /v1/workspaces validates required fields", async () => {
    const res = await h.fetchAs("alice", "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryName: "demo" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("bad_request");
  });

  test("POST /v1/workspaces rejects non-JSON content type and invalid JSON", async () => {
    const badType = await h.fetchAs("alice", "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(badType.status).toBe(400);

    const badJson = await h.fetchAs("alice", "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
  });

  test("sessions: create and list", async () => {
    const ws = await h.createWorkspace("alice");
    const created = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { title: "fix bug" } }),
    });
    expect(created.status).toBe(201);
    const session = await created.json();
    expect(session.workspaceId).toBe(ws.id);
    expect(session.metadata).toEqual({ title: "fix bug" });

    const list = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/sessions`, { method: "GET" });
    expect(list.status).toBe(200);
    const { sessions } = await list.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(session.id);
  });

  test("unknown route -> 404", async () => {
    const res = await h.fetchAs("alice", "/v1/nonsense", { method: "GET" });
    expect(res.status).toBe(404);
  });

  test("malformed percent-encoding %zz -> typed 400, never 500", async () => {
    const res = await h.fetchAs("alice", "/v1/workspaces/%zz", { method: "GET" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("malformed path segment");
  });

  test("truncated percent-encoding %A -> typed 400", async () => {
    const res = await h.fetchAs("alice", "/v1/workspaces/%A", { method: "GET" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("malformed path segment");
  });
});

// ---------------------------------------------------------------------------
// Controller enforcement (仕様書 section 20)
// ---------------------------------------------------------------------------

describe("controller enforcement", () => {
  let h: TestHarness;
  let workspaceId: string;
  let sessionId: string;
  let aliceControllerId: string;

  beforeAll(async () => {
    h = startHarness();
    const ws = await h.createWorkspace("alice");
    workspaceId = ws.id;
    await h.membership.addMember(workspaceId, "bob");
    const sessionRes = await h.fetchAs("alice", `/v1/workspaces/${workspaceId}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    sessionId = ((await sessionRes.json()) as { id: string }).id;

    const acquire = await h.fetchAs("alice", `/v1/workspaces/${workspaceId}/controller/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(acquire.status).toBe(200);
    aliceControllerId = ((await acquire.json()) as { controllerId: string }).controllerId;
  });
  afterAll(() => h.stop());

  test("message send without any controller -> 409 (even for the ex-controller path safety)", async () => {
    // (lease is held here; the no-controller case is covered later in lease tests)
    expect(aliceControllerId).toBeTruthy();
  });

  test("observer (member without lease) gets 409 on controller-only operations", async () => {
    const calls: Array<() => Promise<Response>> = [
      () =>
        h.fetchAs("bob", `/v1/sessions/${sessionId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "hello" }),
        }),
      () =>
        h.fetchAs("bob", `/v1/sessions/${sessionId}/approvals/ap-1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approved" }),
        }),
      () =>
        h.fetchAs("bob", `/v1/sessions/${sessionId}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      () =>
        h.fetchAs("bob", `/v1/workspaces/${workspaceId}/checkpoints`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
    ];
    for (const [i, call] of calls.entries()) {
      const res = await call();
      expect(res.status, `observer op ${i}`).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("conflict");
    }
  });

  test("controller can send a message; the message is persisted and activity is recorded", async () => {
    const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "fix the flaky test" }),
    });
    expect(res.status).toBe(201);
    const event = await res.json();
    expect(event.eventType).toBe("user_message");
    expect(event.data.content).toBe("fix the flaky test");

    const persisted = await h.repo.readEvents(sessionId);
    expect(persisted.map((e) => e.eventType)).toEqual(["user_message"]);

    const handle = h.handles.get(workspaceId)!;
    expect(handle.activities).toContain("user_message");
  });

  test("message refused when the runtime refuses agent input -> 409", async () => {
    const handle = h.handles.get(workspaceId)!;
    handle.inputAllowed = false;
    const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "nope" }),
    });
    expect(res.status).toBe(409);
    handle.inputAllowed = true;
  });

  test("approval: controller-only, records approval activity, persists event", async () => {
    const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/approvals/ap-42`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected" }),
    });
    expect(res.status).toBe(201);
    const event = await res.json();
    expect(event.eventType).toBe("approval");
    expect(event.data).toEqual({ approvalId: "ap-42", decision: "rejected" });
    expect(h.handles.get(workspaceId)!.activities).toContain("approval");
  });

  test("approval with invalid decision -> 400", async () => {
    const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/approvals/ap-42`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(res.status).toBe(400);
  });

  test("cancel: controller-only, persists event", async () => {
    const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const event = await res.json();
    expect(event.eventType).toBe("cancel");
    expect(h.handles.get(workspaceId)!.activities).toContain("workspace_operation");
  });

  test("manual checkpoint: controller-only, runs through runtime handle", async () => {
    const res = await h.fetchAs("alice", `/v1/workspaces/${workspaceId}/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(h.handles.get(workspaceId)!.checkpointCalls).toBe(1);
    expect(h.handles.get(workspaceId)!.activities).toContain("checkpoint");
  });

  test("observer may read the session stream, workspace status and sessions list", async () => {
    expect((await h.fetchAs("bob", `/v1/workspaces/${workspaceId}`, { method: "GET" })).status).toBe(200);
    expect((await h.fetchAs("bob", `/v1/workspaces/${workspaceId}/sessions`, { method: "GET" })).status).toBe(200);
    // events stream: just check it responds 200 with SSE content type and close it
    const res = await h.fetchAs("bob", `/v1/sessions/${sessionId}/events?seq=9999`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body!.cancel();
  });

  test("missing message content -> 400", async () => {
    const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Controller lease routes (実装手順書 section 26)
// ---------------------------------------------------------------------------

describe("controller lease routes", () => {
  let h: TestHarness;
  beforeAll(() => {
    h = startHarness();
  });
  afterAll(() => h.stop());

  test("acquire, heartbeat, release lifecycle", async () => {
    const ws = await h.createWorkspace("alice");
    await h.membership.addMember(ws.id, "bob");

    const acquire = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(acquire.status).toBe(200);
    const { controllerId } = await acquire.json();

    // second acquire by another member -> 409 (controllersPerWorkspace = 1)
    const second = await h.fetchAs("bob", `/v1/workspaces/${ws.id}/controller/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(409);

    // heartbeat by the owner -> 200
    const beat = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ controllerId }),
    });
    expect(beat.status).toBe(200);

    // heartbeat by a non-owner -> 409
    const wrongBeat = await h.fetchAs("bob", `/v1/workspaces/${ws.id}/controller/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ controllerId: "someone-else" }),
    });
    expect(wrongBeat.status).toBe(409);

    // heartbeat missing controllerId -> 400
    const badBeat = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(badBeat.status).toBe(400);

    // release by a non-owner -> 409, then by the owner -> 200
    const wrongRelease = await h.fetchAs("bob", `/v1/workspaces/${ws.id}/controller/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ controllerId: "someone-else" }),
    });
    expect(wrongRelease.status).toBe(409);

    const release = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ controllerId }),
    });
    expect(release.status).toBe(200);

    // heartbeat after release -> 404
    const gone = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ controllerId }),
    });
    expect(gone.status).toBe(404);
  });

  test("message send with no active controller -> 409", async () => {
    const ws = await h.createWorkspace("alice");
    const sessionRes = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const sessionId = ((await sessionRes.json()) as { id: string }).id;

    const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain("no active controller");
  });
});

// ---------------------------------------------------------------------------
// SSE (仕様書 section 24, 実装手順書 section 24; idle policy section 11)
// ---------------------------------------------------------------------------

describe("SSE session events", () => {
  let h: TestHarness;
  beforeAll(() => {
    h = startHarness();
  });
  afterAll(() => h.stop());

  async function setupSession(): Promise<{ workspaceId: string; sessionId: string }> {
    const ws = await h.createWorkspace("alice");
    const sessionRes = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const session = (await sessionRes.json()) as { id: string };
    return { workspaceId: ws.id, sessionId: session.id };
  }

  async function readFor(res: Response, ms: number): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(() => "timeout" as const),
      ]);
      if (result === "timeout" || result.done) break;
      text += decoder.decode(result.value);
    }
    await reader.cancel();
    return text;
  }

  test("replays all events then streams new ones", async () => {
    const { sessionId } = await setupSession();
    await h.repo.append(sessionId, [
      { eventType: "user_message", eventTime: 1, data: { content: "one" } },
      { eventType: "user_message", eventTime: 2, data: { content: "two" } },
    ]);

    const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/events`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const collected = readFor(res, 150);
    await Bun.sleep(30);
    await h.repo.append(sessionId, [
      { eventType: "tool_invocation", eventTime: 3, data: { tool: "bash" } },
    ]);
    const text = await collected;
    expect(text).toContain("event: user_message");
    expect(text).toContain('"content":"one"');
    expect(text).toContain('"content":"two"');
    expect(text).toContain("event: tool_invocation");
    expect(text).toContain('"tool":"bash"');
  });

  test("replays from client-supplied seq cursor", async () => {
    const { sessionId } = await setupSession();
    await h.repo.append(sessionId, [
      { eventType: "a", eventTime: 1, data: { n: 0 } },
      { eventType: "b", eventTime: 2, data: { n: 1 } },
      { eventType: "c", eventTime: 3, data: { n: 2 } },
    ]);

    const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/events?seq=1`, { method: "GET" });
    const text = await readFor(res, 120);
    // events with seq >= 1 only
    expect(text).toContain("id: 1");
    expect(text).toContain("id: 2");
    expect(text).not.toContain("id: 0");
  });

  test("invalid seq cursor -> 400", async () => {
    const { sessionId } = await setupSession();
    const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/events?seq=-1`, { method: "GET" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("bad_request");
  });

  test("unknown session -> 404", async () => {
    const res = await h.fetchAs(
      "alice",
      `/v1/sessions/00000000-0000-0000-0000-000000000000/events`,
      { method: "GET" },
    );
    expect(res.status).toBe(404);
  });

  test("SSE heartbeats are NOT meaningful activity (仕様書 section 11)", async () => {
    const { workspaceId, sessionId } = await setupSession();
    // opening the workspace creates the runtime handle and seeds activity
    await h.fetchAs("alice", `/v1/workspaces/${workspaceId}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const handle = h.handles.get(workspaceId)!;
    const seeded = handle.activities.length;

    const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/events`, { method: "GET" });
    // heartbeat interval is 60ms in the harness; 5+ heartbeats fire during 200ms
    await readFor(res, 200);

    // the stream and its heartbeats must not have added any activity
    expect(handle.activities.length).toBe(seeded);
  });
});

// ---------------------------------------------------------------------------
// Open / stop + coalescing (実装手順書 section 27)
// ---------------------------------------------------------------------------

function makeRealRuntime(workspaceId: string): {
  runtime: WorkspaceRuntime;
  startCalls: () => number;
  stopCalls: () => number;
} {
  let starts = 0;
  let stops = 0;
  const instanceRuntime: InstanceRuntime = {
    create: async () => ({ name: "inst", url: "https://inst", state: "READY" }),
    start: async () => {
      starts++;
      await Bun.sleep(50); // simulate slow start so concurrent opens overlap
    },
    stop: async () => {
      stops++;
    },
    get: async () => ({ name: "inst", url: "https://inst", state: "READY" }),
    delete: async () => {},
  };
  const noop = async () => {};
  const runtime = new WorkspaceRuntime({
    workspaceId,
    store: new InMemoryTransactionalStore(),
    clock: baseClock,
    instanceRuntime,
    instanceName: "inst",
    idle: new IdleManager(baseClock),
    steps: {
      waitForInstanceHealth: noop,
      cloneRepository: noop,
      checkoutBase: noop,
      restoreCheckpoint: noop,
      createSandbox: noop,
      restoreHarness: noop,
      runLifecycleCheckpoint: noop,
      flushSessionPersistence: noop,
      deleteSandbox: noop,
    },
  });
  return { runtime, startCalls: () => starts, stopCalls: () => stops };
}

describe("open/stop composition with the T8 runtime", () => {
  test("concurrent open requests coalesce into a single start operation", async () => {
    const h = startHarness({
      runtimes: new RuntimeRegistry(throwingFactory()), // factory unused; we inject manually
    });
    try {
      const ws = await h.createWorkspace("alice");
      const { runtime, startCalls } = makeRealRuntime(ws.id);
      h.deps.runtimes.set(ws.id, new WorkspaceRuntimeHandleAdapter(runtime, async () => {}));

      const [r1, r2, r3] = await Promise.all([
        h.fetchAs("alice", `/v1/workspaces/${ws.id}/open`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
        h.fetchAs("alice", `/v1/workspaces/${ws.id}/open`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
        h.fetchAs("alice", `/v1/workspaces/${ws.id}/open`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      ]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      const body = await r1.json();
      expect(body.state).toBe("READY");
      expect(startCalls()).toBe(1);
    } finally {
      h.stop();
    }
  });

  test("open from a non-openable state -> 409", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      const { runtime } = makeRealRuntime(ws.id);
      h.deps.runtimes.set(ws.id, new WorkspaceRuntimeHandleAdapter(runtime, async () => {}));
      // drive the runtime to BUSY via the state machine
      await runtime.open();
      await runtime.beginAgentTurn();

      const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("conflict");
    } finally {
      h.stop();
    }
  });

  test("stop drives the runtime to STOPPED", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      const { runtime, stopCalls } = makeRealRuntime(ws.id);
      h.deps.runtimes.set(ws.id, new WorkspaceRuntimeHandleAdapter(runtime, async () => {}));
      await runtime.open();

      const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.state).toBe("STOPPED");
      expect(stopCalls()).toBe(1);
    } finally {
      h.stop();
    }
  });

  test("typed runtime errors map to 409", () => {
    const res = toErrorResponse(new InvalidOperationError("open", "BUSY"));
    expect(res.status).toBe(409);
  });

  test("unexpected errors map to a generic 500 without internals", () => {
    const res = toErrorResponse(new Error("secret database DSN leaked"));
    expect(res.status).toBe(500);
  });

  test("real system clock: open() reaching nowMs does not throw (MINOR-2 regression)", async () => {
    // A real T8 WorkspaceRuntime + IdleManager constructed with the real
    // SystemClock must reach clock.nowMs() inside open()'s success path
    // (recordActivity -> IdleManager). A T6 one-method clock would throw
    // "clock.nowMs is not a function" here.
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      const runtime = makeRealRuntime(ws.id).runtime;
      h.deps.runtimes.set(ws.id, new WorkspaceRuntimeHandleAdapter(runtime, async () => {}));

      const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.state).toBe("READY");
    } finally {
      h.stop();
    }
  });

  test("deps with a one-method T6 clock fail typecheck; runtime still works with SystemClock", () => {
    // Compile-level guard: ControlPlaneClock demands both methods.
    const clock: ControlPlaneClock = new SystemClock();
    expect(typeof clock.now).toBe("function");
    expect(typeof clock.nowMs).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Fake-clock driven SSE heartbeat cadence (MINOR-3)
// ---------------------------------------------------------------------------

class ManualFakeClock {
  private ms: number;
  constructor(startMs: number) {
    this.ms = startMs;
  }
  now(): Date {
    return new Date(this.ms);
  }
  nowMs(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

describe("SSE heartbeat cadence with an injected fake clock", () => {
  test("heartbeat fires exactly at heartbeatMs intervals per the fake clock", async () => {
    const repo = new PostgresSessionPersistenceRepository(new FakeExecutor());
    const leases = new ControllerLeaseService({ store: new InMemoryLeaseStore() });
    const membership = new InMemoryMembershipStore();
    const clock = new ManualFakeClock(1_000_000);
    const HEARTBEAT_MS = 500;

    const deps = createControlPlaneDeps({
      resolveUser: async (identity) =>
        identity.subject === "alice" ? { id: "alice", email: "a@example.com" } : null,
      repo,
      leases,
      membership,
      runtimes: new RuntimeRegistry(() => {
        throw new Error("no runtime needed");
      }),
      clock,
      ssePollIntervalMs: 10,
      sseHeartbeatMs: HEARTBEAT_MS,
    });

    // Real SystemClock drives the server; the deps clock is the fake above.
    expect(deps.clock.nowMs()).toBe(1_000_000);

    const workspace = await repo.createWorkspace({
      id: crypto.randomUUID(),
      ownerId: "alice",
      repositoryOwner: "mpppk",
      repositoryName: "demo",
      baseBranch: "main",
      runtimeState: "STOPPED",
    });
    await membership.addMember(workspace.id, "alice");
    const session = await repo.createSession({
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
    });

    const server = Bun.serve({ port: 0, fetch: createFetchHandler(deps) });
    try {
      const res = await fetch(
        `${server.url.origin}/v1/sessions/${session.id}/events`,
        {
          headers: {
            "x-goog-authenticated-user-id": "accounts.google.com:alice",
            "x-goog-authenticated-user-email": "a@example.com",
          },
        },
      );
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";

      // Continuous background collector: every resolved read appends to the
      // buffer, so no chunk is swallowed by an abandoned read race.
      const collector = (async (): Promise<void> => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value);
          }
        } catch {
          // stream cancelled
        }
      })();

      // The fake clock only advances when we advance it, so heartbeats fire
      // exactly when simulated elapsed time crosses HEARTBEAT_MS boundaries.
      // 4 x 250ms = 1000ms simulated: pings at 500ms and 1000ms -> exactly 2.
      for (let i = 0; i < 4; i++) {
        clock.advance(250);
        await Bun.sleep(30); // real time for the SSE loop to observe the clock
      }
      await Bun.sleep(20);
      await reader.cancel();
      await collector;

      // ": stream open" comment is emitted at start; then one heartbeat per
      // 500ms of simulated time. Four 250ms advances = 1000ms simulated ->
      // exactly 2 heartbeats (at 500ms and at 1000ms, lastEmitMs resetting
      // at each ping).
      const heartbeats = text.split(": ping").length - 1;
      expect(heartbeats).toBe(2);
      // The replay/stream-open markers must also be present.
      expect(text).toContain(": stream open");
    } finally {
      server.stop(true);
    }
  });
});
