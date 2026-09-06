// Route-level tests for the control-plane HTTP surface.
// Every collaborator is faked — no real GCP, DB or network.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ERROR_ID_RE, InMemoryLogger } from "@cloud-run-dsh/observability";
import {
  AgentHostConflictError,
  AgentHostForwardError,
  type ForwardApprovalArgs,
  type ForwardCancelArgs,
  type ForwardCheckpointArgs,
  type ForwardMessageArgs,
  type ForwardPrepareStopArgs,
  type MessageForwarder,
} from "./forwarding.js";
import {
  AgentInputRefusedError,
  IdleManager,
  IllegalTransitionError,
  InMemoryTransactionalStore,
  InvalidOperationError,
  WorkspaceRuntime,
} from "@cloud-run-dsh/workspace-runtime";
import type { ActivityKind } from "@cloud-run-dsh/workspace-runtime";
import type { InstanceRuntime } from "@cloud-run-dsh/cloud-run-instance-client";
import { ControllerLeaseService, LEASE_EXPIRY_MS } from "@cloud-run-dsh/controller-lease";
import { FakeClock, InMemoryLeaseStore } from "@cloud-run-dsh/controller-lease/testing";
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
import { listWorkspaces } from "./handlers.js";
import type { Clock } from "@cloud-run-dsh/workspace-checkpoint";
import { createDbReadinessProbe } from "./prod-adapters.js";
import { STALE_STARTING_THRESHOLD_MS } from "./handlers.js";
import {
  badRequest,
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
    if (sql.startsWith("SELECT * FROM workspaces WHERE id IN (")) {
      // listWorkspacesByIds (issue #137): exactly the requested rows, one
      // bound scalar per id (NOT `= ANY($1)` — Bun.SQL cannot bind a JS
      // array; see repository.ts). Checked BEFORE the single-row `WHERE id`
      // branch below, whose prefix this SQL shares.
      const ids = new Set(params as string[]);
      return [...this.workspaces.values()]
        .filter((w) => ids.has(w["id"] as string))
        .map((w) => structuredClone(w));
    }
    if (sql.startsWith("SELECT * FROM workspaces WHERE id")) {
      const w = this.workspaces.get(params[0] as string);
      return w ? [structuredClone(w)] : [];
    }
    if (sql.startsWith("SELECT * FROM workspaces")) {
      // listWorkspaces (issue #85): no WHERE clause — every row.
      return [...this.workspaces.values()].map((w) => structuredClone(w));
    }
    if (sql.startsWith("SELECT * FROM sessions WHERE workspace_id")) {
      return [...this.sessions.values()]
        .filter((s) => s["workspace_id"] === params[0])
        .sort((a, b) => String(a["created_at"]).localeCompare(String(b["created_at"])))
        .map((s) => structuredClone(s));
    }
    if (sql.startsWith("SELECT id FROM sessions WHERE id")) {
      // Parent-row lock for gapless append (issue #70): the lock itself is
      // a no-op in the fake (transactions run inline here), but the row is
      // returned so the existence check behaves identically.
      const s = this.sessions.get(params[0] as string);
      return s ? [structuredClone(s)] : [];
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
      // Generic SET-clause parsing for `col = $N` pairs (`updated_at = now()`
      // carries no placeholder and is applied implicitly below).
      const setClause = sql.slice("UPDATE workspaces SET".length, sql.lastIndexOf("WHERE"));
      for (const assign of setClause.split(",")) {
        const m = assign.trim().match(/^([a-z_]+)\s*=\s*\$(\d+)$/i);
        if (!m) continue;
        w[m[1]!.toLowerCase()] = params[Number(m[2]) - 1];
      }
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
    // Issue #85 deleteWorkspace cascade.
    if (
      sql.startsWith(
        "DELETE FROM session_events WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id",
      )
    ) {
      const workspaceId = params[0] as string;
      const sessionIds = new Set(
        [...this.sessions.values()]
          .filter((s) => s["workspace_id"] === workspaceId)
          .map((s) => s["id"] as string),
      );
      for (const sessionId of sessionIds) this.events.delete(sessionId);
      return;
    }
    if (sql.startsWith("DELETE FROM sessions WHERE workspace_id")) {
      const workspaceId = params[0] as string;
      for (const [id, s] of [...this.sessions]) {
        if (s["workspace_id"] === workspaceId) {
          this.sessions.delete(id);
          this.events.delete(id);
        }
      }
      return;
    }
    if (sql.startsWith("DELETE FROM workspace_checkpoints WHERE workspace_id")) return;
    if (sql.startsWith("DELETE FROM controller_leases WHERE workspace_id")) return;
    if (sql.startsWith("DELETE FROM workspaces WHERE id")) {
      this.workspaces.delete(params[0] as string);
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
  /** What open() answers (production answers STARTING, then the agent-host drives READY). */
  openState = "READY";
  activities: ActivityKind[] = [];
  openCalls = 0;
  stopCalls = 0;
  checkpointCalls = 0;
  deleteCalls = 0;
  deleteBehavior: "ok" | "fail" = "ok";
  inputAllowed = true;

  async open(): Promise<string> {
    this.openCalls++;
    this.state = this.openState;
    return this.state;
  }

  stopIdentities: { id: string; email: string }[] = [];

  async stop(identity?: { id: string; email: string }): Promise<string> {
    this.stopCalls++;
    if (identity) this.stopIdentities.push(identity);
    this.state = "STOPPED";
    return this.state;
  }

  getState(): string {
    return this.state;
  }

  recordActivity(kind: ActivityKind): void {
    this.activities.push(kind);
  }

  async assertAgentInputAllowed(): Promise<void> {
    if (!this.inputAllowed) throw new AgentInputRefusedError("RESTORE_FAILED");
  }

  checkpointIdentities: { id: string; email: string }[] = [];
  checkpointSkipped = false;

  async runManualCheckpoint(identity?: { id: string; email: string }): Promise<{ skipped: boolean }> {
    this.checkpointCalls++;
    if (identity) this.checkpointIdentities.push(identity);
    this.recordActivity("checkpoint");
    return { skipped: this.checkpointSkipped };
  }

  instanceUrl: string | null = null;

  async getInstanceUrl(): Promise<string | null> {
    return this.instanceUrl;
  }

  async deleteInstance(): Promise<void> {
    this.deleteCalls++;
    if (this.deleteBehavior === "fail") {
      throw new Error("Instances API delete failed (boom)");
    }
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
  /** The in-memory executor behind repo — tests backdate updated_at through it. */
  executor: FakeExecutor;
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
  const executor = new FakeExecutor();
  const repo = new PostgresSessionPersistenceRepository(executor);
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
    executor,
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

  test("liveness endpoint needs no auth (issue #68: /livez, never /healthz)", async () => {
    const res = await fetch(h.url("/livez"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("issue #68: /healthz is not served (Cloud Run reserves it)", async () => {
    // Cloud Run's frontend answers the exact path /healthz itself, so
    // serving it here would advertise an endpoint that is unreachable over
    // HTTP from outside. Liveness lives on /livez instead: an authenticated
    // GET /healthz must 404 (no route), while /livez answers 200.
    expect((await h.fetchAs("alice", "/healthz")).status).toBe(404);
    expect((await h.fetchAs("alice", "/livez")).status).toBe(200);
  });
});

describe("readiness endpoint", () => {
  test("no readiness probe in deps -> ready", async () => {
    const h = startHarness();
    try {
      const res = await fetch(h.url("/readyz"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ready" });
    } finally {
      h.stop();
    }
  });

  test("honest readiness: a not-ready probe -> 503 with reason", async () => {
    const h = startHarness({
      readiness: () => ({
        ready: false,
        reason: "workspace runtime operations are unavailable: RuntimeRegistry is not wired",
      }),
    });
    try {
      const res = await fetch(h.url("/readyz"));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe("not_ready");
      expect(body.reason).toContain("RuntimeRegistry is not wired");
    } finally {
      h.stop();
    }
  });

  test("a ready probe -> 200", async () => {
    const h = startHarness({ readiness: () => ({ ready: true }) });
    try {
      const res = await fetch(h.url("/readyz"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ready" });
    } finally {
      h.stop();
    }
  });

  test("issue #97: async probe is awaited — unreachable DB -> 503, never 200", async () => {
    const h = startHarness({
      readiness: createDbReadinessProbe({
        async query() {
          // The measured production shape: the database is gone entirely.
          throw new Error("Connection timeout after 30s");
        },
        async exec() {},
        async transaction(fn) {
          throw new Error("unreachable");
        },
      } satisfies QueryExecutor),
    });
    try {
      const res = await fetch(h.url("/readyz"));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe("not_ready");
      expect(typeof body.reason).toBe("string");
    } finally {
      h.stop();
    }
  });

  test("issue #97: async probe is awaited — reachable DB -> 200, one SELECT 1 for two checks", async () => {
    let queries = 0;
    const h = startHarness({
      readiness: createDbReadinessProbe({
        async query() {
          queries++;
          return [{ "?column?": 1 }];
        },
        async exec() {},
        async transaction(fn) {
          throw new Error("unused");
        },
      } satisfies QueryExecutor),
    });
    try {
      expect((await fetch(h.url("/readyz"))).status).toBe(200);
      expect((await fetch(h.url("/readyz"))).status).toBe(200);
      // Result cache: steady-state health checks cost no extra queries.
      expect(queries).toBe(1);
    } finally {
      h.stop();
    }
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
      () => h.fetchAs("carol", `/v1/workspaces/${workspaceId}`, { method: "DELETE" }),
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
      () => h.fetchAs("carol", `/v1/workspaces/${workspaceId}/controller`, { method: "GET" }),
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
// Workspace listing (issue #137)
// ---------------------------------------------------------------------------

describe("GET /v1/workspaces (issue #137)", () => {
  let h: TestHarness;
  let aliceIds: string[];
  let bobId: string;

  beforeAll(async () => {
    h = startHarness();
    const a1 = await h.createWorkspace("alice");
    const a2 = await h.createWorkspace("alice");
    const b1 = await h.createWorkspace("bob");
    aliceIds = [a1.id, a2.id];
    bobId = b1.id;
  });
  afterAll(() => h.stop());

  test("returns only the caller's own workspaces", async () => {
    const aliceRes = await h.fetchAs("alice", "/v1/workspaces", { method: "GET" });
    expect(aliceRes.status).toBe(200);
    const aliceBody = (await aliceRes.json()) as { workspaces: Array<{ id: string }> };
    expect(aliceBody.workspaces.map((w) => w.id).sort()).toEqual([...aliceIds].sort());

    const bobRes = await h.fetchAs("bob", "/v1/workspaces", { method: "GET" });
    expect(bobRes.status).toBe(200);
    const bobBody = (await bobRes.json()) as { workspaces: Array<{ id: string }> };
    expect(bobBody.workspaces.map((w) => w.id)).toEqual([bobId]);
  });

  test("a shared (non-owner) member also sees the workspace", async () => {
    await h.membership.addMember(aliceIds[0]!, "bob");
    const res = await h.fetchAs("bob", "/v1/workspaces", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ id: string }> };
    expect(body.workspaces.map((w) => w.id).sort()).toEqual([aliceIds[0]!, bobId].sort());
  });

  test("a user with no workspaces gets { workspaces: [] }", async () => {
    // carol owns nothing yet (she creates one in the coexistence test below,
    // which runs last) — the empty shape is pinned here.
    const res = await h.fetchAs("carol", "/v1/workspaces", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaces: [] });
  });

  test("no auth headers -> 401, never 404", async () => {
    const res = await fetch(h.url("/v1/workspaces"), { method: "GET" });
    expect(res.status).toBe(401);
  });

  test("list entries use the same DTO as GET /v1/workspaces/:id", async () => {
    const single = await h.fetchAs("alice", `/v1/workspaces/${aliceIds[0]}`, { method: "GET" });
    expect(single.status).toBe(200);
    const singleBody = await single.json();
    const list = await h.fetchAs("alice", "/v1/workspaces", { method: "GET" });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { workspaces: Array<Record<string, unknown>> };
    expect(listBody.workspaces.find((w) => w["id"] === aliceIds[0])).toEqual(singleBody);
  });

  test("listing never calls recordActivity (idle timer untouched)", async () => {
    const spy = new FakeHandle();
    h.deps.runtimes.set(aliceIds[0]!, spy);
    const res = await h.fetchAs("alice", "/v1/workspaces", { method: "GET" });
    expect(res.status).toBe(200);
    expect(spy.activities).toEqual([]);
  });

  test("POST /v1/workspaces (create) still coexists with the new GET route", async () => {
    const res = await h.fetchAs("carol", "/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo", baseBranch: "main" }),
    });
    expect(res.status).toBe(201);
    // ...and carol now lists exactly that one workspace.
    const list = await h.fetchAs("carol", "/v1/workspaces", { method: "GET" });
    const body = (await list.json()) as { workspaces: Array<{ id: string }> };
    expect(body.workspaces).toHaveLength(1);
  });
});

/** Counts SELECTs to pin the no-N+1 property of the list route. */
class CountingFakeExecutor extends FakeExecutor {
  queryCount = 0;
  override async query<T>(
    sql: string,
    params: readonly unknown[],
  ): Promise<Record<string, unknown>[]> {
    this.queryCount++;
    return super.query(sql, params);
  }
}

describe("listWorkspaces query shape (issue #137, no N+1)", () => {
  function listCtx(
    membership: InMemoryMembershipStore,
    repo: SessionPersistenceRepository,
    userId: string,
  ) {
    return {
      request: new Request("http://x/v1/workspaces"),
      params: {} as Record<string, string>,
      url: new URL("http://x/v1/workspaces"),
      deps: { membership, repo } as unknown as ControlPlaneDeps,
      user: { id: userId, email: `${userId}@example.com` },
    };
  }

  test("N visible workspaces load in a single workspace-table query", async () => {
    const exec = new CountingFakeExecutor();
    const repo = new PostgresSessionPersistenceRepository(exec);
    const membership = new InMemoryMembershipStore();
    for (let i = 0; i < 5; i++) {
      const id = `ws-list-${i}`;
      await repo.createWorkspace({
        id,
        ownerId: "alice",
        repositoryOwner: "mpppk",
        repositoryName: "demo",
        baseBranch: "main",
      });
      await membership.addMember(id, "alice");
    }
    // A decoy owned by someone else: visible ids resolve first, so its row
    // must never be fetched.
    await repo.createWorkspace({
      id: "ws-list-decoy",
      ownerId: "bob",
      repositoryOwner: "mpppk",
      repositoryName: "demo",
      baseBranch: "main",
    });
    await membership.addMember("ws-list-decoy", "bob");

    exec.queryCount = 0;
    const res = await listWorkspaces(listCtx(membership, repo, "alice"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ id: string; ownerId: string }> };
    expect(body.workspaces).toHaveLength(5);
    expect(body.workspaces.every((w) => w.ownerId === "alice")).toBe(true);
    // Exactly 1 query (WHERE id IN (...)) — independent of the count.
    expect(exec.queryCount).toBe(1);
  });

  test("empty membership answers without touching the workspace table", async () => {
    const exec = new CountingFakeExecutor();
    const repo = new PostgresSessionPersistenceRepository(exec);
    const membership = new InMemoryMembershipStore();
    const res = await listWorkspaces(listCtx(membership, repo, "carol"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaces: [] });
    expect(exec.queryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Workspace deletion (issue #85 案B)
// ---------------------------------------------------------------------------

describe("DELETE /v1/workspaces/:id (issue #85)", () => {
  test("owner deletes: Instance deleted, row + sessions + events gone", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      const sessionRes = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const sessionId = ((await sessionRes.json()) as { id: string }).id;
      await h.repo.append(sessionId, [{ eventType: "a", eventTime: 1, data: {} }]);
      const handle = new FakeHandle();
      h.deps.runtimes.set(ws.id, handle);

      const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ workspaceId: ws.id, deleted: true });

      // Instance deletion went through the workspace's own handle.
      expect(handle.deleteCalls).toBe(1);
      // Row and children are gone.
      expect(await h.repo.getWorkspace(ws.id)).toBeNull();
      expect(await h.repo.getSession(sessionId)).toBeNull();
      expect(await h.repo.readEvents(sessionId)).toEqual([]);
      // Reading the deleted workspace is 404, not 403.
      expect((await h.fetchAs("alice", `/v1/workspaces/${ws.id}`, { method: "GET" })).status).toBe(
        404,
      );
    } finally {
      h.stop();
    }
  });

  test("non-member gets 403 and nothing is deleted", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      const handle = new FakeHandle();
      h.deps.runtimes.set(ws.id, handle);

      const res = await h.fetchAs("carol", `/v1/workspaces/${ws.id}`, { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");

      expect(handle.deleteCalls).toBe(0);
      expect(await h.repo.getWorkspace(ws.id)).not.toBeNull();
    } finally {
      h.stop();
    }
  });

  test("unknown workspace -> 404", async () => {
    const h = startHarness();
    try {
      const res = await h.fetchAs(
        "alice",
        "/v1/workspaces/00000000-0000-0000-0000-000000000000",
        { method: "DELETE" },
      );
      expect(res.status).toBe(404);
    } finally {
      h.stop();
    }
  });

  test("Instance delete failure -> 502 and the workspace row is kept (retryable)", async () => {
    const logger = new InMemoryLogger();
    const h = startHarness({ logger });
    try {
      const ws = await h.createWorkspace("alice");
      const handle = new FakeHandle();
      handle.deleteBehavior = "fail";
      h.deps.runtimes.set(ws.id, handle);

      const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}`, { method: "DELETE" });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "bad_gateway",
      );

      // Row kept for retry; the failure is a structured log with ids.
      expect(await h.repo.getWorkspace(ws.id)).not.toBeNull();
      const failed = logger.parsed.find(
        (e) => e["event"] === "control-plane.workspace-delete.instance-failed",
      );
      expect(failed).toBeTruthy();
      expect(failed!["workspaceId"]).toBe(ws.id);
    } finally {
      h.stop();
    }
  });

  test("successful delete is a structured log with workspaceId", async () => {
    const logger = new InMemoryLogger();
    const h = startHarness({ logger });
    try {
      const ws = await h.createWorkspace("alice");
      h.deps.runtimes.set(ws.id, new FakeHandle());

      expect((await h.fetchAs("alice", `/v1/workspaces/${ws.id}`, { method: "DELETE" })).status).toBe(
        200,
      );
      const line = logger.parsed.find((e) => e["event"] === "control-plane.workspace-deleted");
      expect(line).toBeTruthy();
      expect(line!["workspaceId"]).toBe(ws.id);
    } finally {
      h.stop();
    }
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
    // Issue #75: the REAL caller reaches the handle for the host forward.
    expect(h.handles.get(workspaceId)!.checkpointIdentities).toEqual([
      { id: "alice", email: "alice@example.com" },
    ]);
    // Issue #89: the response carries the host's skip flag so callers can
    // tell a real snapshot (skipped: false) from a clean-tree skip.
    expect(await res.json()).toEqual({ workspaceId, checkpointed: true, skipped: false });
  });

  test("manual checkpoint response reports a clean-tree host skip (issue #89)", async () => {
    h.handles.get(workspaceId)!.checkpointSkipped = true;
    try {
      const res = await h.fetchAs("alice", `/v1/workspaces/${workspaceId}/checkpoints`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceId, checkpointed: true, skipped: true });
    } finally {
      h.handles.get(workspaceId)!.checkpointSkipped = false;
    }
  });

  test("stop passes the real caller identity to the runtime handle (issue #72)", async () => {
    const res = await h.fetchAs("alice", `/v1/workspaces/${workspaceId}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(h.handles.get(workspaceId)!.stopCalls).toBe(1);
    expect(h.handles.get(workspaceId)!.stopIdentities).toEqual([
      { id: "alice", email: "alice@example.com" },
    ]);
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
// Controller status read route (issue #133)
// ---------------------------------------------------------------------------

describe("controller status read route", () => {
  let h: TestHarness;
  beforeAll(() => {
    h = startHarness();
  });
  afterAll(() => h.stop());

  async function acquireAsAlice(workspaceId: string): Promise<string> {
    const res = await h.fetchAs("alice", `/v1/workspaces/${workspaceId}/controller/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { controllerId: string }).controllerId;
  }

  test("no lease -> {held:false, mine:false, expiresAt:null}", async () => {
    const ws = await h.createWorkspace("alice");
    const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ held: false, mine: false, expiresAt: null });
  });

  test("own lease -> {held:true, mine:true, expiresAt:<ISO>}", async () => {
    const ws = await h.createWorkspace("alice");
    await acquireAsAlice(ws.id);
    const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { held: boolean; mine: boolean; expiresAt: string };
    expect(body.held).toBe(true);
    expect(body.mine).toBe(true);
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
  });

  test("another member's lease -> held:true, mine:false; controllerId and userIds never leak", async () => {
    const ws = await h.createWorkspace("alice");
    await h.membership.addMember(ws.id, "bob");
    const controllerId = await acquireAsAlice(ws.id);
    const res = await h.fetchAs("bob", `/v1/workspaces/${ws.id}/controller`, { method: "GET" });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body["held"]).toBe(true);
    expect(body["mine"]).toBe(false);
    expect(typeof body["expiresAt"]).toBe("string");
    // The capability (controllerId) and both user ids must not appear —
    // not as values, not as substrings anywhere in the body.
    expect(body).not.toHaveProperty("controllerId");
    expect(body).not.toHaveProperty("userId");
    expect(raw).not.toContain(controllerId);
    expect(raw).not.toContain("alice");
    expect(raw).not.toContain("bob");
  });

  test("expired lease reads as unheld (fake clock past LEASE_EXPIRY_MS)", async () => {
    const leaseClock = new FakeClock(new Date("2026-09-06T00:00:00.000Z"));
    const h2 = startHarness({
      leases: new ControllerLeaseService({ store: new InMemoryLeaseStore(), clock: leaseClock }),
    });
    try {
      const ws = await h2.createWorkspace("alice");
      const acquire = await h2.fetchAs("alice", `/v1/workspaces/${ws.id}/controller/acquire`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(acquire.status).toBe(200);
      const before = await h2.fetchAs("alice", `/v1/workspaces/${ws.id}/controller`, {
        method: "GET",
      });
      expect(((await before.json()) as { held: boolean }).held).toBe(true);
      leaseClock.advance(LEASE_EXPIRY_MS + 1_000);
      const after = await h2.fetchAs("alice", `/v1/workspaces/${ws.id}/controller`, {
        method: "GET",
      });
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual({ held: false, mine: false, expiresAt: null });
    } finally {
      h2.stop();
    }
  });

  test("non-member -> 403; unknown workspace -> 404", async () => {
    const ws = await h.createWorkspace("alice");
    const forbidden = await h.fetchAs("carol", `/v1/workspaces/${ws.id}/controller`, {
      method: "GET",
    });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    const missing = await h.fetchAs("alice", `/v1/workspaces/00000000-0000-0000-0000-000000000000/controller`, {
      method: "GET",
    });
    expect(missing.status).toBe(404);
  });

  test("reading status never calls recordActivity (仕様書 section 11)", async () => {
    const ws = await h.createWorkspace("alice");
    await h.fetchAs("alice", `/v1/workspaces/${ws.id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const handle = h.handles.get(ws.id)!;
    const seeded = handle.activities.length;
    const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(handle.activities.length).toBe(seeded);
  });

  test("open's implicit lease reads as mine:true without any acquire (issue #133本体)", async () => {
    const ws = await h.createWorkspace("alice");
    const open = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(open.status).toBe(200);
    // ensureControllerLeaseForOpen took the lease for the opener — the
    // badge must agree with requireController without an explicit acquire.
    expect((await h.deps.leases.getActive(ws.id))?.userId).toBe("alice");
    const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { held: boolean; mine: boolean; expiresAt: string };
    expect(body.held).toBe(true);
    expect(body.mine).toBe(true);
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
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
      h.deps.runtimes.set(ws.id, new WorkspaceRuntimeHandleAdapter(runtime, async () => ({ skipped: false })));

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

      expect(r1.status).toBe(202);
      expect(r2.status).toBe(202);
      expect(r3.status).toBe(202);
      const body = await r1.json();
      // Issue #60 案C: the control plane stops at STARTING (one shared
      // start); the agent-host phase completes the row to READY. Issue #136:
      // all three opens answer 202 without waiting for that phase.
      expect(body.state).toBe("STARTING");
      expect(startCalls()).toBe(1);
      // The opener holds the controller lease, so it can message right away.
      const lease = await h.leases.getActive(ws.id);
      expect(lease?.userId).toBe("alice");
      // Agent-host phase on the same runtime object (same shared store).
      expect(await runtime.completeRestore()).toBe("READY");
      const reread = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(reread.status).toBe(200);
      expect((await reread.json()).state).toBe("READY");
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
      h.deps.runtimes.set(ws.id, new WorkspaceRuntimeHandleAdapter(runtime, async () => ({ skipped: false })));
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
      h.deps.runtimes.set(ws.id, new WorkspaceRuntimeHandleAdapter(runtime, async () => ({ skipped: false })));
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

  test("issue #88: IllegalTransitionError maps to 409, not 500", async () => {
    // A lost compare-and-set race on the shared row (concurrent stops from
    // two runtimes) is a caller-visible state conflict — retryable — so it
    // must read as a conflict, never as an internal server error.
    const res = toErrorResponse(new IllegalTransitionError("STOPPING", "STOPPING"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("conflict");
  });

  test("issue #88 end-to-end: concurrent-stop loser gets 409 from POST /stop", async () => {
    // The reviewer's repro at the HTTP layer: the handle's stop() rejects
    // with the exact error the losing runtime throws (IllegalTransitionError
    // from the shared-row compare-and-set), and the route must answer 409.
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      const losing: WorkspaceRuntimeHandle = {
        open: async () => "READY",
        stop: async () => {
          throw new IllegalTransitionError("STOPPING", "STOPPING");
        },
        getState: () => "STOPPING",
        recordActivity: () => {},
        assertAgentInputAllowed: async () => {},
        runManualCheckpoint: async () => ({ skipped: false }),
        getInstanceUrl: async () => null,
        deleteInstance: async () => {},
      };
      h.deps.runtimes.set(ws.id, losing);

      const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("conflict");
    } finally {
      h.stop();
    }
  });

  test("unexpected errors map to a generic 500 without internals", () => {
    const res = toErrorResponse(new Error("secret database DSN leaked"));
    expect(res.status).toBe(500);
  });

  test("real system clock: open() reaching nowMs does not throw (MINOR-2 regression)", async () => {
    // A real T8 WorkspaceRuntime + IdleManager constructed with the real
    // SystemClock must reach clock.nowMs() inside the open success path
    // (recordActivity -> IdleManager). A T6 one-method clock would throw
    // "clock.nowMs is not a function" here. Issue #60: the activity tick
    // lives in the agent-host restore phase now, so both phases run.
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      const runtime = makeRealRuntime(ws.id).runtime;
      h.deps.runtimes.set(ws.id, new WorkspaceRuntimeHandleAdapter(runtime, async () => ({ skipped: false })));

      const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.state).toBe("STARTING");
      expect(await runtime.completeRestore()).toBe("READY");
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
// Issue #136 — async open (202 + GET polling, lazy stale failure 案A)
// ---------------------------------------------------------------------------

describe("async open (issue #136)", () => {
  /** Ages the workspace row's updated_at (simulates a generation nobody advances). */
  function backdateUpdatedAt(h: TestHarness, workspaceId: string, ageMs: number): void {
    const row = h.executor.workspaces.get(workspaceId);
    if (!row) throw new Error(`workspace missing: ${workspaceId}`);
    row["updated_at"] = new Date(Date.now() - ageMs).toISOString();
  }

  function postOpen(h: TestHarness, workspaceId: string): Promise<Response> {
    return h.fetchAs("alice", `/v1/workspaces/${workspaceId}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  function pinStartingHandle(h: TestHarness, workspaceId: string): FakeHandle {
    const handle = new FakeHandle();
    handle.openState = "STARTING";
    h.deps.runtimes.set(workspaceId, handle);
    return handle;
  }

  test("open answers 202 STARTING without waiting for the agent-host phase", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      pinStartingHandle(h, ws.id);
      const res = await postOpen(h, ws.id);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ workspaceId: ws.id, state: "STARTING" });
    } finally {
      h.stop();
    }
  });

  test("re-open of an already-READY workspace is a 200 no-op", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      // Default FakeHandle opens straight to READY (single-process shape).
      const res = await postOpen(h, ws.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ workspaceId: ws.id, state: "READY" });
    } finally {
      h.stop();
    }
  });

  test("open while STARTING coalesces to 202 without touching the runtime", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      const handle = pinStartingHandle(h, ws.id);
      // An in-flight generation: the row is STARTING, fresh.
      await h.repo.updateWorkspace(ws.id, { runtimeState: "STARTING" });
      const res = await postOpen(h, ws.id);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ state: "STARTING" });
      // Coalesced at the HTTP layer — no second instance start was issued.
      expect(handle.openCalls).toBe(0);
    } finally {
      h.stop();
    }
  });

  test("fresh STARTING / RESTORING rows keep reading as preparing (never a #121 false failure)", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      // #121: stop-then-open observably takes ~3 min — far below the stale
      // threshold, so it must read as "preparing", never as failed.
      await h.repo.updateWorkspace(ws.id, { runtimeState: "STARTING" });
      backdateUpdatedAt(h, ws.id, STALE_STARTING_THRESHOLD_MS - 60_000);
      const starting = await h.fetchAs("alice", `/v1/workspaces/${ws.id}`);
      expect(starting.status).toBe(200);
      expect(((await starting.json()) as { runtimeState: string }).runtimeState).toBe("STARTING");

      await h.repo.updateWorkspace(ws.id, { runtimeState: "RESTORING" });
      const restoring = await h.fetchAs("alice", `/v1/workspaces/${ws.id}`);
      expect((((await restoring.json()) as { runtimeState: string }).runtimeState)).toBe(
        "RESTORING",
      );
    } finally {
      h.stop();
    }
  });

  test("stale STARTING row reads as RESTORE_FAILED on GET (finite failure, 案A)", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      await h.repo.updateWorkspace(ws.id, { runtimeState: "STARTING" });
      backdateUpdatedAt(h, ws.id, STALE_STARTING_THRESHOLD_MS + 60_000);
      const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { runtimeState: string }).runtimeState).toBe("RESTORE_FAILED");
      // Persisted: every later reader agrees, and the failure is stable
      // (the mark bumps updated_at, so it is not re-marked in a loop).
      expect((await h.repo.getWorkspace(ws.id))!.runtimeState).toBe("RESTORE_FAILED");
      const again = await h.fetchAs("alice", `/v1/workspaces/${ws.id}`);
      expect(((await again.json()) as { runtimeState: string }).runtimeState).toBe(
        "RESTORE_FAILED",
      );
    } finally {
      h.stop();
    }
  });

  test("stale RESTORING row reads as RESTORE_FAILED on GET", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      await h.repo.updateWorkspace(ws.id, { runtimeState: "RESTORING" });
      backdateUpdatedAt(h, ws.id, STALE_STARTING_THRESHOLD_MS + 60_000);
      const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}`);
      expect(((await res.json()) as { runtimeState: string }).runtimeState).toBe("RESTORE_FAILED");
    } finally {
      h.stop();
    }
  });

  test("open on a stale STARTING row fails it first, then retries into STARTING", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      const handle = pinStartingHandle(h, ws.id);
      await h.repo.updateWorkspace(ws.id, { runtimeState: "STARTING" });
      backdateUpdatedAt(h, ws.id, STALE_STARTING_THRESHOLD_MS + 60_000);
      const res = await postOpen(h, ws.id);
      // The dead generation was failed (RESTORE_FAILED is re-openable), and
      // this open started a fresh one — 202, not a 409 against the corpse.
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ state: "STARTING" });
      expect(handle.openCalls).toBe(1);
    } finally {
      h.stop();
    }
  });

  test("late agent-host READY is visible via GET with no re-open (#122 shape)", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      pinStartingHandle(h, ws.id);
      expect((await (await postOpen(h, ws.id)).json()) as { state: string }).toMatchObject({
        state: "STARTING",
      });
      // The agent-host completes on the shared row (what completeRestore()
      // persists in production); the control plane was never re-invoked.
      await h.repo.updateWorkspace(ws.id, { runtimeState: "READY" });
      const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}`);
      expect(((await res.json()) as { runtimeState: string }).runtimeState).toBe("READY");
    } finally {
      h.stop();
    }
  });

  test("事実2: message after async open + late READY never 409s on a missing instance_url", async () => {
    // The regression this pins: the old readiness poll wrote
    // workspaces.instance_url after /readyz ok. With the poll gone, the row
    // stays null — and message forwarding must still work once the Instance
    // is reachable, via the live Instances API lookup (instanceUrlProvider),
    // never 409 "open the workspace first" for a workspace that IS open.
    const forwarder = new RecordingForwarder();
    const h = startHarness({ messageForwarder: forwarder });
    try {
      const ws = await h.createWorkspace("alice");
      const handle = pinStartingHandle(h, ws.id);
      // FakeHandle.instanceUrl stands in for the production
      // instanceUrlProvider live lookup; inputAllowed stands in for the T8
      // assertAgentInputAllowed row reload.
      handle.instanceUrl = null;
      handle.inputAllowed = false;

      // 1. open answers 202 while NO health check ran: the row has no URL.
      expect((await (await postOpen(h, ws.id)).json()) as { state: string }).toMatchObject({
        state: "STARTING",
      });
      expect((await h.repo.getWorkspace(ws.id))!.instanceUrl).toBeNull();

      // 2. While STARTING, a message is refused as "preparing" (409) — the
      // pre-existing T8 gate, unchanged by this issue.
      const sessionRes = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(sessionRes.status).toBe(201);
      const sessionId = ((await sessionRes.json()) as { id: string }).id;
      const early = await h.fetchAs("alice", `/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "too early" }),
      });
      expect(early.status).toBe(409);

      // 3. The Instance becomes reachable (live API now reports a URL) and
      // the agent-host persists READY — still nobody wrote instance_url.
      handle.instanceUrl = "https://ah.test";
      handle.inputAllowed = true;
      await h.repo.updateWorkspace(ws.id, { runtimeState: "READY" });
      expect((await h.repo.getWorkspace(ws.id))!.instanceUrl).toBeNull();

      // 4. The message goes through (201), forwarded to the live URL.
      const res = await h.fetchAs("alice", `/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello after ready" }),
      });
      expect(res.status).toBe(201);
      expect(forwarder.calls).toHaveLength(1);
      expect(forwarder.calls[0]!.instanceUrl).toBe("https://ah.test");
    } finally {
      h.stop();
    }
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

// ---------------------------------------------------------------------------
// Message forwarding to agent-host (issue #22)
//
// The control plane stays the SOLE writer of `user_message`: it appends
// first, then forwards the appended seq/content. The fake forwarder below
// records the payload but never touches the repo — mirroring the agent-host
// gateway, which must not append the event again.
// ---------------------------------------------------------------------------

/** Recording MessageForwarder fake with switchable failure modes. */
class RecordingForwarder implements MessageForwarder {
  calls: ForwardMessageArgs[] = [];
  approvalCalls: ForwardApprovalArgs[] = [];
  cancelCalls: ForwardCancelArgs[] = [];
  prepareCalls: ForwardPrepareStopArgs[] = [];
  checkpointCalls: ForwardCheckpointArgs[] = [];
  behavior: "ok" | "conflict" | "forward-error" = "ok";

  async forward(args: ForwardMessageArgs): Promise<{ status: number; turnStarted: boolean }> {
    this.calls.push(args);
    if (this.behavior === "conflict") {
      throw new AgentHostConflictError(
        "agent-host refused the message (status 409): controller lease not held by this host",
      );
    }
    if (this.behavior === "forward-error") {
      throw new AgentHostForwardError("workspace instance unreachable at https://ah.test (boom)");
    }
    return { status: 202, turnStarted: true };
  }

  async forwardApproval(
    args: ForwardApprovalArgs,
  ): Promise<{ status: number; turnStarted: boolean }> {
    this.approvalCalls.push(args);
    if (this.behavior === "conflict") {
      throw new AgentHostConflictError(
        "agent-host refused the request (status 409): controller lease not held by this host",
      );
    }
    if (this.behavior === "forward-error") {
      throw new AgentHostForwardError("workspace instance unreachable at https://ah.test (boom)");
    }
    return { status: 202, turnStarted: true };
  }

  async forwardCancel(args: ForwardCancelArgs): Promise<{ status: number; turnStarted: boolean }> {
    this.cancelCalls.push(args);
    if (this.behavior === "conflict") {
      throw new AgentHostConflictError(
        "agent-host refused the request (status 409): controller lease not held by this host",
      );
    }
    if (this.behavior === "forward-error") {
      throw new AgentHostForwardError("workspace instance unreachable at https://ah.test (boom)");
    }
    return { status: 202, turnStarted: true };
  }

  async forwardPrepareStop(
    args: ForwardPrepareStopArgs,
  ): Promise<{ status: number; prepared: boolean; state: string }> {
    this.prepareCalls.push(args);
    if (this.behavior === "conflict") {
      throw new AgentHostConflictError(
        "agent-host refused the request (status 409): controller lease not held by this host",
      );
    }
    if (this.behavior === "forward-error") {
      throw new AgentHostForwardError("workspace instance unreachable at https://ah.test (boom)");
    }
    return { status: 200, prepared: true, state: "STOPPING" };
  }

  async forwardCheckpoint(
    args: ForwardCheckpointArgs,
  ): Promise<{ status: number; checkpointed: boolean; skipped: boolean; state: string }> {
    this.checkpointCalls.push(args);
    if (this.behavior === "conflict") {
      throw new AgentHostConflictError(
        "agent-host refused the request (status 409): controller lease not held by this host",
      );
    }
    if (this.behavior === "forward-error") {
      throw new AgentHostForwardError("workspace instance unreachable at https://ah.test (boom)");
    }
    return { status: 200, checkpointed: true, skipped: false, state: "READY" };
  }
}

describe("message forwarding to agent-host (issue #22)", () => {
  interface ForwardingSetup {
    h: TestHarness;
    workspaceId: string;
    sessionId: string;
    handle: FakeHandle;
    forwarder: RecordingForwarder;
    logger: InMemoryLogger;
  }

  async function setupForwarding(instanceUrl: string | null): Promise<ForwardingSetup> {
    const forwarder = new RecordingForwarder();
    const logger = new InMemoryLogger();
    const h = startHarness({ messageForwarder: forwarder, logger });
    const ws = await h.createWorkspace("alice");
    const handle = new FakeHandle();
    handle.instanceUrl = instanceUrl;
    h.deps.runtimes.set(ws.id, handle);
    const sessionRes = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(sessionRes.status).toBe(201);
    const sessionId = ((await sessionRes.json()) as { id: string }).id;
    const acquire = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(acquire.status).toBe(200);
    return { h, workspaceId: ws.id, sessionId, handle, forwarder, logger };
  }

  async function postAsAlice(h: TestHarness, sessionId: string, content: string): Promise<Response> {
    return h.fetchAs("alice", `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  }

  test("running instance: appends once, forwards seq/content, returns 201", async () => {
    const { h, sessionId, forwarder } = await setupForwarding("https://ah.test");
    try {
      const res = await postAsAlice(h, sessionId, "fix the flaky test");
      expect(res.status).toBe(201);
      const event = await res.json();
      expect(event.eventType).toBe("user_message");
      expect(event.seq).toBe(0);

      // Single writer: exactly one user_message in the DB …
      const persisted = await h.repo.readEvents(sessionId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.eventType).toBe("user_message");

      // … and the forwarder carried the SAME appended seq (a reference, not
      // a second append — the fake has no repo access, like the gateway).
      expect(forwarder.calls).toHaveLength(1);
      expect(forwarder.calls[0]).toMatchObject({
        instanceUrl: "https://ah.test",
        sessionId,
        seq: event.seq,
        content: "fix the flaky test",
        identity: { id: "alice", email: "alice@example.com" },
      });
      // No duplicate: the DB still holds exactly the one event.
      expect(await h.repo.readEvents(sessionId)).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("stopped / never-opened instance (no URL): 409 WITHOUT writing an orphan event", async () => {
    const { h, sessionId, forwarder } = await setupForwarding(null);
    try {
      const res = await postAsAlice(h, sessionId, "hello?");
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("conflict");
      expect(body.error.message).toContain("not running");

      // No orphan: nothing was appended, nothing was forwarded to.
      expect(await h.repo.readEvents(sessionId)).toHaveLength(0);
      expect(forwarder.calls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("forward failure after the append: 502 (never a fake 201), orphan is traceable", async () => {
    const { h, sessionId, forwarder, logger } = await setupForwarding("https://ah.test");
    forwarder.behavior = "forward-error";
    try {
      const res = await postAsAlice(h, sessionId, "are you there?");
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.code).toBe("bad_gateway");

      // The event WAS recorded (append happens before the forward) but the
      // client is told the turn did not start — and the log shows why.
      // (The observability redactor masks string identifiers, so only the
      // event name, the numeric seq and the error text are asserted here.)
      expect(await h.repo.readEvents(sessionId)).toHaveLength(1);
      const failed = logger.parsed.find((e) => e["event"] === "control-plane.forward.failed");
      expect(failed).toBeTruthy();
      expect(failed!["seq"]).toBe(0);
      expect(typeof failed!["error"]).toBe("string");
    } finally {
      h.stop();
    }
  });

  test("agent-host conflict (lease/state) propagates as 409, not 502", async () => {
    const { h, sessionId, forwarder } = await setupForwarding("https://ah.test");
    forwarder.behavior = "conflict";
    try {
      const res = await postAsAlice(h, sessionId, "hello?");
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("conflict");
    } finally {
      h.stop();
    }
  });

  test("no forwarder configured (dev/tests): append-only 201, nothing forwarded", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      const sessionRes = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const sessionId = ((await sessionRes.json()) as { id: string }).id;
      const acquire = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller/acquire`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(acquire.status).toBe(200);

      const res = await postAsAlice(h, sessionId, "local dev message");
      expect(res.status).toBe(201);
      expect(await h.repo.readEvents(sessionId)).toHaveLength(1);
    } finally {
      h.stop();
    }
  });
});

describe("approval/cancel forwarding to agent-host (issue #39)", () => {
  async function setupApprovalForwarding(instanceUrl: string | null): Promise<{
    h: TestHarness;
    workspaceId: string;
    sessionId: string;
    forwarder: RecordingForwarder;
    logger: InMemoryLogger;
  }> {
    const forwarder = new RecordingForwarder();
    const logger = new InMemoryLogger();
    const h = startHarness({ messageForwarder: forwarder, logger });
    const ws = await h.createWorkspace("alice");
    const handle = new FakeHandle();
    handle.instanceUrl = instanceUrl;
    h.deps.runtimes.set(ws.id, handle);
    const sessionRes = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(sessionRes.status).toBe(201);
    const sessionId = ((await sessionRes.json()) as { id: string }).id;
    const acquire = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(acquire.status).toBe(200);
    return { h, workspaceId: ws.id, sessionId, forwarder, logger };
  }

  const postApprovalAsAlice = (h: TestHarness, sessionId: string, approvalId: string) =>
    h.fetchAs("alice", `/v1/sessions/${sessionId}/approvals/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected" }),
    });

  const postCancelAsAlice = (h: TestHarness, sessionId: string) =>
    h.fetchAs("alice", `/v1/sessions/${sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

  test("running instance: approval appends once and forwards id/decision, 201", async () => {
    const { h, sessionId, forwarder } = await setupApprovalForwarding("https://ah.test");
    try {
      const res = await postApprovalAsAlice(h, sessionId, "ap-1");
      expect(res.status).toBe(201);
      const event = await res.json();
      expect(event.eventType).toBe("approval");
      expect(event.data).toEqual({ approvalId: "ap-1", decision: "rejected" });

      // Single writer: exactly one approval in the DB …
      const persisted = await h.repo.readEvents(sessionId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.eventType).toBe("approval");

      // … and the forwarder carried the SAME decision (a reference, not a
      // second append — the fake has no repo access, like the gateway).
      expect(forwarder.approvalCalls).toHaveLength(1);
      expect(forwarder.approvalCalls[0]).toMatchObject({
        instanceUrl: "https://ah.test",
        sessionId,
        approvalId: "ap-1",
        decision: "rejected",
        identity: { id: "alice", email: "alice@example.com" },
      });
      expect(await h.repo.readEvents(sessionId)).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("running instance: cancel appends once and forwards the session, 201", async () => {
    const { h, sessionId, forwarder } = await setupApprovalForwarding("https://ah.test");
    try {
      const res = await postCancelAsAlice(h, sessionId);
      expect(res.status).toBe(201);
      const event = await res.json();
      expect(event.eventType).toBe("cancel");

      const persisted = await h.repo.readEvents(sessionId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.eventType).toBe("cancel");

      expect(forwarder.cancelCalls).toHaveLength(1);
      expect(forwarder.cancelCalls[0]).toMatchObject({
        instanceUrl: "https://ah.test",
        sessionId,
        identity: { id: "alice", email: "alice@example.com" },
      });
      expect(await h.repo.readEvents(sessionId)).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("stopped instance (no URL): approval/cancel 409 WITHOUT writing orphans", async () => {
    const { h, sessionId, forwarder } = await setupApprovalForwarding(null);
    try {
      const approvalRes = await postApprovalAsAlice(h, sessionId, "ap-1");
      expect(approvalRes.status).toBe(409);
      expect(((await approvalRes.json()) as { error: { code: string } }).error.code).toBe(
        "conflict",
      );

      const cancelRes = await postCancelAsAlice(h, sessionId);
      expect(cancelRes.status).toBe(409);

      // No orphans: nothing appended, nothing forwarded to.
      expect(await h.repo.readEvents(sessionId)).toHaveLength(0);
      expect(forwarder.approvalCalls).toHaveLength(0);
      expect(forwarder.cancelCalls).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("forward failure: 502 (never a fake 201), orphan is traceable", async () => {
    const { h, sessionId, forwarder, logger } = await setupApprovalForwarding("https://ah.test");
    forwarder.behavior = "forward-error";
    try {
      const approvalRes = await postApprovalAsAlice(h, sessionId, "ap-9");
      expect(approvalRes.status).toBe(502);
      expect(((await approvalRes.json()) as { error: { code: string } }).error.code).toBe(
        "bad_gateway",
      );

      const cancelRes = await postCancelAsAlice(h, sessionId);
      expect(cancelRes.status).toBe(502);

      // Both events WERE recorded but the client is told they did not land —
      // and the log shows why.
      expect(await h.repo.readEvents(sessionId)).toHaveLength(2);
      const failed = logger.parsed.filter((e) => e["event"] === "control-plane.forward.failed");
      expect(failed).toHaveLength(2);
      expect(failed.map((e) => e["kind"]).sort()).toEqual(["approval", "cancel"]);
    } finally {
      h.stop();
    }
  });

  test("agent-host conflict: approval/cancel 409, not 502", async () => {
    const { h, sessionId, forwarder } = await setupApprovalForwarding("https://ah.test");
    forwarder.behavior = "conflict";
    try {
      const approvalRes = await postApprovalAsAlice(h, sessionId, "ap-1");
      expect(approvalRes.status).toBe(409);
      expect(((await approvalRes.json()) as { error: { code: string } }).error.code).toBe(
        "conflict",
      );
      const cancelRes = await postCancelAsAlice(h, sessionId);
      expect(cancelRes.status).toBe(409);
    } finally {
      h.stop();
    }
  });

  test("no forwarder configured (dev/tests): append-only 201, nothing forwarded", async () => {
    const h = startHarness();
    try {
      const ws = await h.createWorkspace("alice");
      const sessionRes = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const sessionId = ((await sessionRes.json()) as { id: string }).id;
      const acquire = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/controller/acquire`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(acquire.status).toBe(200);

      expect((await postApprovalAsAlice(h, sessionId, "ap-1")).status).toBe(201);
      expect((await postCancelAsAlice(h, sessionId)).status).toBe(201);
      expect(await h.repo.readEvents(sessionId)).toHaveLength(2);
    } finally {
      h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Unexpected-error observability (issue #48)
//
// A 500 must leave a redacted structured log line carrying the same errorId
// the client receives, while the response itself stays generic.
// ---------------------------------------------------------------------------

describe("unexpected error observability (issue #48)", () => {
  test("toErrorResponse logs class/message/stack + context; response stays generic with matching errorId", async () => {
    const logger = new InMemoryLogger();
    const res = toErrorResponse(new TypeError("boom details here"), {
      logger,
      context: {
        method: "POST",
        path: "/v1/workspaces/ws-1/open",
        userId: "alice",
        workspaceId: "ws-1",
      },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string; errorId: string };
    };
    expect(body.error.code).toBe("internal");
    expect(body.error.message).toBe("internal server error");
    // 16 hex chars by design (not a UUID). History: this was a WORKAROUND for
    // issue #51 — a UUID-shaped ID would have been masked by the entropy
    // redactor in the very log line meant to carry it. #51 is resolved since
    // PR #54 (UUIDs now survive redaction); 16hex is retained as-is. See
    // newErrorId in @cloud-run-dsh/observability. The shape lives there
    // (ERROR_ID_RE), not here, so a follow-up return to UUIDs touches one place.
    expect(body.error.errorId).toMatch(ERROR_ID_RE);

    // The response carries no internals.
    expect(JSON.stringify(body)).not.toContain("boom details here");

    const line = logger.parsed.find((e) => e["event"] === "http.unexpected_error");
    expect(line).toBeTruthy();
    expect(line!["errorId"]).toBe(body.error.errorId);
    expect(line!["errorClass"]).toBe("TypeError");
    expect(line!["errorMessage"]).toBe("boom details here");
    expect(typeof line!["errorStack"]).toBe("string");
    expect(line!["errorStack"] as string).toContain("TypeError");
    expect(line!["method"]).toBe("POST");
    expect(line!["path"]).toBe("/v1/workspaces/ws-1/open");
    expect(line!["userId"]).toBe("alice");
    expect(line!["workspaceId"]).toBe("ws-1");
  });

  test("typed errors (4xx/409) stay silent: no ERROR log for expected failures", () => {
    const logger = new InMemoryLogger();
    expect(toErrorResponse(badRequest("missing field"), { logger }).status).toBe(400);
    expect(toErrorResponse(new InvalidOperationError("open", "BUSY"), { logger }).status).toBe(
      409,
    );
    expect(logger.lines).toHaveLength(0);
  });

  test("secret-bearing exceptions are redacted in the log (#42 regression)", async () => {
    const logger = new InMemoryLogger();
    // Shapes mirroring the real #42 leak: a Bun.SQL-style message carrying a
    // postgres connection string plus a GitHub token.
    const secretUrl = "postgres://dsh_app:Sup3rS3cretDbPassw0rd@10.0.0.1:5432/dsh";
    const token = "ghp_1234567890abcdefghij1234567890abcd";
    const err = new Error(`Bun.SQL connection failed using ${secretUrl} with token ${token}`);
    const res = toErrorResponse(err, { logger });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { errorId: string } };

    const rawLogs = logger.lines.join("\n");
    expect(rawLogs).not.toContain("Sup3rS3cretDbPassw0rd");
    expect(rawLogs).not.toContain(token);
    expect(rawLogs).not.toContain(secretUrl);
    // …but the line exists and is correlatable.
    expect(rawLogs).toContain(body.error.errorId);
    expect(rawLogs).toContain("http.unexpected_error");
  });

  test("end-to-end: throwing open() -> generic 500 + redacted log with matching errorId", async () => {
    const logger = new InMemoryLogger();
    const h = startHarness({ logger });
    try {
      const ws = await h.createWorkspace("alice");
      const secret = "postgres://dsh_app:An0therS3cretPass@10.0.0.2:5432/dsh";
      const throwing: WorkspaceRuntimeHandle = {
        open: async () => {
          throw new Error(`Instance start failed: ${secret}`);
        },
        stop: async () => "STOPPED",
        getState: () => "STOPPED",
        recordActivity: () => {},
        assertAgentInputAllowed: async () => {},
        runManualCheckpoint: async () => ({ skipped: false }),
        getInstanceUrl: async () => null,
        deleteInstance: async () => {},
      };
      h.deps.runtimes.set(ws.id, throwing);

      const res = await h.fetchAs("alice", `/v1/workspaces/${ws.id}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(500);
      const rawBody = await res.text();
      const body = JSON.parse(rawBody) as {
        error: { code: string; message: string; errorId: string };
      };
      expect(body.error.code).toBe("internal");
      expect(body.error.message).toBe("internal server error");
      expect(rawBody).not.toContain("An0therS3cretPass");
      expect(rawBody).not.toContain("Instance start failed");

      const line = logger.parsed.find((e) => e["event"] === "http.unexpected_error");
      expect(line).toBeTruthy();
      expect(line!["errorId"]).toBe(body.error.errorId);
      // NOTE: workspace UUIDs used to be masked to [REDACTED] by the
      // high-entropy net (issue #51; #52 was closed as its duplicate). #51 is
      // resolved since PR #54, so the raw UUID survives and 仕様書 §25
      // correlation works. The errorId remains an additional correlation key.
      // The field is passed to the logger per 仕様書 §25.
      expect(line!["workspaceId"]).toBe(ws.id);
      expect(line!["userId"]).toBe("alice");
      expect(line!["method"]).toBe("POST");
      expect(line!["path"]).toContain("/v1/workspaces/");
      expect(logger.lines.join("\n")).not.toContain("An0therS3cretPass");
    } finally {
      h.stop();
    }
  });
});
