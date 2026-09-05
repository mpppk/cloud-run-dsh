// Issue #60: control-plane and agent-host share ONE workspace row (state)
// and ONE lease row (controller identity). Unit tests cannot see this
// pairing by construction — each side used its own store — which is why the
// collision only surfaced on real GCP. These tests wire the REAL production
// compositions from both apps against the SAME stores and drive a full open:
//
//   control plane: production RuntimeRegistry (Instances API fake) +
//                  handlers.openWorkspace (real lease handover)
//   agent-host:    composed host (composeTestHost) with shared lease/state/
//                  repository stores, booting with the injected CONTROLLER_ID
//
// Collision 1 (lease): the Instance env CONTROLLER_ID must equal the active
// lease the opener established — never a second random id — or the host's
// adopt 409s against the user's lease (the old deadlock).
// Collision 2 (state machine): the control plane stops at STARTING; only the
// agent-host drives RESTORING -> READY. A full open() from the agent side is
// refused, and a second host generation is fenced off (§26-8).

import { describe, expect, test } from "bun:test";
import { FakeTransport } from "../../packages/cloud-run-instance-client/src/testing.js";
import { ControllerLeaseService } from "../../packages/controller-lease/src/index.js";
import { LeaseAlreadyHeldError } from "../../packages/controller-lease/src/index.js";
import { InMemoryLeaseStore } from "../../packages/controller-lease/src/testing.js";
import type {
  TransactionalStateStore,
  WorkspaceStateTransaction,
} from "../../packages/workspace-runtime/src/index.js";
import { IllegalTransitionError } from "../../packages/workspace-runtime/src/index.js";
import { PostgresSessionPersistenceRepository } from "../../packages/session-persistence-postgres/src/index.js";
import { InMemoryFakeExecutor } from "../../packages/session-persistence-postgres/src/testing.js";
import { SqlTransactionalStateStore } from "../../apps/control-plane/src/prod-adapters.js";
import type { GcsClient } from "../../packages/workspace-checkpoint/src/index.js";
import {
  createControlPlaneDeps,
  InMemoryMembershipStore,
  openWorkspace,
  postMessage,
  requireController,
  SystemClock,
  type ControlPlaneDeps,
} from "../../apps/control-plane/src/index.js";
import {
  createProductionRuntimeRegistry,
  type HealthFetch,
} from "../../apps/control-plane/src/runtime-factory.js";
import type { ControlPlaneConfig } from "../../apps/control-plane/src/config.js";
import { ensureControllerLeaseForOpen } from "../../apps/control-plane/src/handlers.js";
import {
  composeTestHost,
  FakeClock,
  type TestHost,
} from "../../apps/agent-host/src/fakes.js";

const BASE_PATH = "https://run.googleapis.com/v2/projects/test-proj/locations/test-region";
const INSTANCE_URL = "https://dsh-ws-1.run.app";

const ALICE = { id: "alice", email: "alice@example.com" };
const BOB = { id: "bob", email: "bob@example.com" };

function testConfig(): ControlPlaneConfig {
  return {
    port: 8080,
    databaseUrl: "postgresql://dsh_app:pw@/dsh?host=/cloudsql/test-proj:test-region:main",
    gcpProjectId: "test-proj",
    gcpRegion: "test-region",
    instancesApiBaseUrl: "https://run.googleapis.com/v2",
    agentHostImage: "test-region-docker.pkg.dev/test-proj/agent-host/agent-host:v1",
    agentHostServiceAccount: "agent-host@test-proj.iam.gserviceaccount.com",
    checkpointBucket: "test-checkpoints",
    agentHostDatabaseUrl: "postgresql://dsh_app:pw@/dsh?host=/cloudsql/test-proj:test-region:main",
    githubAppId: "12345",
    githubAppPrivateKeyPem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
    openrouterApiKey: "sk-or-v1-test-sentinel-key-0001",
    cloudSqlConnectionName: "test-proj:test-region:main",
  };
}

class MapGcsClient implements GcsClient {
  readonly objects = new Map<string, Uint8Array>();
  async getObject(_bucket: string, key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }
  async uploadObject(_bucket: string, key: string, data: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(data));
  }
  async objectExists(_bucket: string, key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

function instanceBody(name: string, url: string) {
  return {
    name: `${BASE_PATH}/instances/${name}`,
    terminalCondition: { state: "CONDITION_SUCCEEDED" },
    urls: [url],
  };
}

/** Stateful Instances API fake: nothing exists until POST create. */
function openFlowHandler(instanceName: string, url: string) {
  let created = false;
  return async (req: { method: string; url: string }) => {
    if (req.method === "GET") {
      if (!created) return { status: 404, body: { message: "not found" } };
      return { status: 200, body: instanceBody(instanceName, url) };
    }
    if (req.method === "POST" && req.url.includes("/instances?instanceId=")) {
      created = true;
      return {
        status: 200,
        body: {
          name: `${BASE_PATH}/operations/op-1`,
          done: true,
          response: instanceBody(instanceName, url),
        },
      };
    }
    if (req.method === "POST") return { status: 200, body: {} };
    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };
}

export interface RecordedTransition {
  readonly from: string;
  readonly to: string;
}

/**
 * Totally-ordered log of every committed state transition, shared by both
 * sides' stores. Lets the test prove the control plane never moved the row
 * past STARTING (issue #60 案C): exactly STOPPED->STARTING (control plane)
 * then STARTING->RESTORING->READY (agent-host), nothing else.
 */
export class RecordingStateStore implements TransactionalStateStore {
  constructor(
    private readonly inner: TransactionalStateStore,
    readonly log: RecordedTransition[] = [],
  ) {}

  load(workspaceId: string) {
    return this.inner.load(workspaceId);
  }

  async apply(
    workspaceId: string,
    from: Parameters<TransactionalStateStore["apply"]>[1],
    to: Parameters<TransactionalStateStore["apply"]>[2],
    reason: string | undefined,
    persist?: (tx: WorkspaceStateTransaction) => Promise<void>,
  ): Promise<void> {
    await this.inner.apply(workspaceId, from, to, reason, persist);
    // Logged only on commit: a CAS rejection throws above and leaves no trace.
    this.log.push({ from, to });
  }
}

interface SharedWorld {
  repo: PostgresSessionPersistenceRepository;
  leaseStore: InMemoryLeaseStore;
  /** Every committed transition on the shared row, both processes. */
  transitions: RecordedTransition[];
  clock: FakeClock;
  cpLeases: ControllerLeaseService;
  transport: FakeTransport;
  deps: ControlPlaneDeps;
  agentHealthCalls: string[];
  agent: TestHost | null;
  agentStateStore: TransactionalStateStore;
}

/** Shared rows + control-plane composition. The agent joins later (needs the established id). */
async function buildSharedWorld(workspaceId: string): Promise<SharedWorld> {
  // ONE clock for both lease services: "active" must agree across the two
  // processes (issue #60). Aligned with wall time; nothing advances it here,
  // so nothing expires mid-test.
  const clock = new FakeClock();
  clock.advance(Date.now() - clock.nowMs());

  // ONE executor = ONE database: both processes' SQL state stores CAS on the
  // same workspaces.runtime_state row, exactly as in production.
  const executor = new InMemoryFakeExecutor();
  const repo = new PostgresSessionPersistenceRepository(executor);
  const leaseStore = new InMemoryLeaseStore();
  const transitions: RecordedTransition[] = [];
  const cpStateStore = new RecordingStateStore(new SqlTransactionalStateStore(executor), transitions);
  const agentStateStore = new RecordingStateStore(
    // The agent-host SqlTransactionalStore is the same shape (a documented
    // mirror); one class serves both sides here.
    new SqlTransactionalStateStore(executor),
    transitions,
  );
  const membership = new InMemoryMembershipStore();
  const transport = new FakeTransport();
  const gcs = new MapGcsClient();
  transport.setHandler(openFlowHandler(`dsh-${workspaceId}`, INSTANCE_URL));

  await repo.createWorkspace({
    id: workspaceId,
    ownerId: "alice",
    repositoryOwner: "mpppk",
    repositoryName: "demo",
    baseBranch: "main",
    runtimeState: "STOPPED",
  });
  await membership.addMember(workspaceId, "alice");
  await membership.addMember(workspaceId, "bob");

  const cpLeases = new ControllerLeaseService({ store: leaseStore, clock });

  // Placeholder: replaced by composeAgent() once the lease id is established.
  const world: SharedWorld = {
    repo,
    leaseStore,
    transitions,
    clock,
    cpLeases,
    transport,
    deps: null as unknown as ControlPlaneDeps,
    agentHealthCalls: [],
    agent: null,
    agentStateStore,
  };

  // The agent-health poll observes the REAL agent health: the control-plane
  // open only completes once the host's recovery reports READY — the
  // production ordering, not a stubbed one.
  const healthFetch: HealthFetch = async (url: string) => {
    world.agentHealthCalls.push(url);
    return world.agent?.host.health.snapshot().status === "READY"
      ? { ok: true, status: 200 }
      : { ok: false, status: 503 };
  };

  const runtimes = createProductionRuntimeRegistry({
    config: testConfig(),
    repo,
    stateStore: cpStateStore,
    clock: new SystemClock(),
    instanceTransport: transport,
    gcsClient: gcs,
    healthFetch,
    instancePoll: { maxAttempts: 5, intervalMs: 0 },
    agentHealthPoll: { maxAttempts: 500, intervalMs: 0 },
    // Macrotask sleeps so the concurrently-running host recovery interleaves
    // with the health poll, exactly as two processes would.
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  });
  world.deps = createControlPlaneDeps({
    repo,
    leases: cpLeases,
    membership,
    runtimes,
    clock: new SystemClock(),
  });
  return world;
}

/**
 * Boots the agent-host against the shared rows with the given CONTROLLER_ID
 * (what the platform injects from the open-established lease).
 */
async function composeAgent(
  world: SharedWorld,
  workspaceId: string,
  controllerId: string,
): Promise<TestHost> {
  const agent = await composeTestHost(
    { workspaceId, controllerId, userId: "alice" },
    {
      clock: world.clock,
      leaseStore: world.leaseStore,
      stateStore: world.agentStateStore,
      repository: world.repo,
    },
  );
  world.agent = agent;
  return agent;
}

function openCtx(
  world: SharedWorld,
  workspaceId: string,
  user: { id: string; email: string },
) {
  return {
    request: new Request(`http://test/v1/workspaces/${workspaceId}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    params: { id: workspaceId },
    url: new URL(`http://test/v1/workspaces/${workspaceId}/open`),
    deps: world.deps,
    user,
  };
}

/**
 * Production ordering: the host process cannot run before the platform
 * starts its instance, and the control plane moves STOPPED -> STARTING
 * before that start. So the test boots the host only after the control
 * plane has taken the shared row to STARTING — otherwise the host's
 * completeRestore correctly refuses a STOPPED row it must never resurrect.
 */
async function openAndRecover(
  world: SharedWorld,
  workspaceId: string,
  user: { id: string; email: string },
  agent: TestHost,
): Promise<Response> {
  const openP = openWorkspace(openCtx(world, workspaceId, user));
  for (let i = 0; i < 1000; i++) {
    const history = world.transitions.map((r) => `${r.from}->${r.to}`);
    if (history.includes("STOPPED->STARTING")) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  const recoverP = agent.host.recover();
  const [openRes] = await Promise.all([openP, recoverP]);
  return openRes;
}

function createEnvOf(transport: FakeTransport): Record<string, string> {
  const createReq = transport.requests.find(
    (r) => r.method === "POST" && r.url.includes("/instances?instanceId="),
  )!;
  const containers = (createReq.body as Record<string, unknown>)["containers"] as Array<
    Record<string, unknown>
  >;
  return Object.fromEntries(
    (containers[0]!["env"] as Array<{ name: string; value: string }>).map((e) => [
      e.name,
      e.value,
    ]),
  );
}

describe("issue #60 — shared-row open, end to end", () => {
  test("POST open succeeds to READY with ONE lease identity shared by both sides", async () => {
    const world = await buildSharedWorld("ws-1");
    // The open establishes the lease for the opener; the platform injects
    // that id into the Instance env, so the host boots with it here.
    const established = await ensureControllerLeaseForOpen(world.cpLeases, "ws-1", "alice");
    const agent = await composeAgent(world, "ws-1", established);

    // Both sides run on the shared rows, host booting after the instance
    // start (production ordering), as in production.
    const openRes = await openAndRecover(world, "ws-1", ALICE, agent);

    expect(openRes.status).toBe(200);
    expect((await openRes.json()).state).toBe("READY");
    expect(agent.host.runtime.getState()).toBe("READY");
    expect((await world.repo.getWorkspace("ws-1"))!.runtimeState).toBe("READY");

    // Collision 1 proof: the Instance env, the active lease, and the adopted
    // identity are ONE id — established once, never re-acquired.
    const env = createEnvOf(world.transport);
    const active = await world.cpLeases.getActive("ws-1");
    expect(env["CONTROLLER_ID"]).toBe(established);
    expect(active?.controllerId).toBe(established);
    expect(active?.userId).toBe("alice");
    // The agent-health poll actually observed the host (not a stubbed 200).
    expect(world.agentHealthCalls.length).toBeGreaterThan(0);

    // Collision 2 proof: the control plane never moved the row past STARTING
    // itself — the only RESTORING->READY edge came from the host phase.
    expect(world.transitions.map((r) => `${r.from}->${r.to}`)).toEqual([
      "STOPPED->STARTING",
      "STARTING->RESTORING",
      "RESTORING->READY",
    ]);

    // ... and a repeated open() once READY is a harmless no-op (no new
    // transitions, no instance start). The refusal that matters — a full
    // open() from STARTING re-running the instance start — is pinned at the
    // factory level, where the agent side runs against the shared row.
    const transitionsBefore = world.transitions.length;
    await expect(agent.host.runtime.open()).resolves.toBe("READY");
    expect(world.transitions.length).toBe(transitionsBefore);
  });

  test("§20: only the lease-holding controller can send messages", async () => {
    const world = await buildSharedWorld("ws-1");
    const established = await ensureControllerLeaseForOpen(world.cpLeases, "ws-1", "alice");
    const agent = await composeAgent(world, "ws-1", established);
    const openRes = await openAndRecover(world, "ws-1", ALICE, agent);
    expect(openRes.status).toBe(200);

    const session = await world.repo.createSession({ id: "sess-1", workspaceId: "ws-1" });
    const messageCtx = (user: { id: string; email: string }) => ({
      request: new Request(`http://test/v1/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      }),
      params: { id: session.id },
      url: new URL(`http://test/v1/sessions/${session.id}/messages`),
      deps: world.deps,
      user,
    });

    // The opener holds the lease: its message is accepted...
    const ok = await postMessage(messageCtx(ALICE));
    expect(ok.status).toBe(201);
    // ...a member without the lease is refused with 409, and nothing is appended.
    await expect(postMessage(messageCtx(BOB))).rejects.toMatchObject({ status: 409 });
    expect(await world.repo.readEvents(session.id)).toHaveLength(1);

    // Direct contract: requireController passes the holder, refuses others.
    await requireController(world.cpLeases, "ws-1", "alice");
    await expect(requireController(world.cpLeases, "ws-1", "bob")).rejects.toThrow();
  });

  test("§26-8: a second host generation with a stale id is refused", async () => {
    const world = await buildSharedWorld("ws-1");
    const established = await ensureControllerLeaseForOpen(world.cpLeases, "ws-1", "alice");
    const agent = await composeAgent(world, "ws-1", established);
    await openAndRecover(world, "ws-1", ALICE, agent);
    expect((await world.cpLeases.getActive("ws-1"))?.controllerId).toBe(established);

    // A duplicate/second host boots against the SAME rows with another id.
    // (Composed directly so world.agent keeps pointing at the winner.)
    const second = await composeTestHost(
      { workspaceId: "ws-1", controllerId: "ctrl-stale", userId: "alice" },
      {
        clock: world.clock,
        leaseStore: world.leaseStore,
        stateStore: world.agentStateStore,
        repository: world.repo,
      },
    );
    await expect(second.host.recover()).rejects.toThrow(LeaseAlreadyHeldError);
    expect(second.host.health.snapshot().status).toBe("RESTORE_FAILED");
    // The winner's lease and READY state are untouched.
    expect((await world.cpLeases.getActive("ws-1"))?.controllerId).toBe(established);
    expect((await world.repo.getWorkspace("ws-1"))!.runtimeState).toBe("READY");
  });

  test("lease handover: fresh acquire for the opener; concurrent opens converge on one id", async () => {    const world = await buildSharedWorld("ws-2");
    // No lease exists: the first open acquires it fresh for the opener.
    const first = await ensureControllerLeaseForOpen(world.cpLeases, "ws-2", "alice");
    expect(typeof first).toBe("string");
    expect((await world.cpLeases.getActive("ws-2"))?.userId).toBe("alice");

    // Two more opens race the acquire CAS: both converge on the winner.
    const [a, b] = await Promise.all([
      ensureControllerLeaseForOpen(world.cpLeases, "ws-2", "alice"),
      ensureControllerLeaseForOpen(world.cpLeases, "ws-2", "alice"),
    ]);
    expect(a).toBe(first);
    expect(b).toBe(first);
  });

  test("issue #63: agent git-clone failure surfaces the health error, not IllegalTransitionError", async () => {
    // The GCP incident, end to end on the shared rows: the agent-host fails
    // git clone and commits RESTORE_FAILED while the control-plane open is
    // still polling /healthz in STARTING. open() must reject with the health
    // observation error (downstream of the clone failure) — the old code
    // replaced it with
    // "illegal state transition: STARTING -> RESTORE_FAILED", hiding the
    // real cause behind a state-machine error.
    const world = await buildSharedWorld("ws-1");
    const established = await ensureControllerLeaseForOpen(world.cpLeases, "ws-1", "alice");
    const agent = await composeAgent(world, "ws-1", established);
    const originalRun = agent.git.run.bind(agent.git);
    agent.git.run = async (args, opts) => {
      if (args.includes("clone")) throw new Error("git clone failed: connection refused");
      return originalRun(args, opts);
    };

    const openP = openWorkspace(openCtx(world, "ws-1", ALICE));
    for (let i = 0; i < 1000; i++) {
      const history = world.transitions.map((r) => `${r.from}->${r.to}`);
      if (history.includes("STOPPED->STARTING")) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    const recoverP = agent.host.recover();
    const [openSettled, recoverSettled] = await Promise.allSettled([openP, recoverP]);

    // The agent-host surfaces the clone failure and records RESTORE_FAILED.
    expect(recoverSettled.status).toBe("rejected");
    expect(String((recoverSettled as PromiseRejectedResult).reason)).toMatch(/clone failed/);
    expect(agent.host.health.snapshot().status).toBe("RESTORE_FAILED");

    // The control-plane open rejects with the health observation error —
    // never the bookkeeping IllegalTransitionError — and the row the
    // agent-host recorded is left untouched.
    expect(openSettled.status).toBe("rejected");
    const openErr = (openSettled as PromiseRejectedResult).reason as Error;
    expect(openErr).not.toBeInstanceOf(IllegalTransitionError);
    expect(openErr.message).toMatch(/never became healthy/);
    expect((await world.repo.getWorkspace("ws-1"))!.runtimeState).toBe("RESTORE_FAILED");
    expect(world.transitions.map((r) => `${r.from}->${r.to}`)).toEqual([
      "STOPPED->STARTING",
      "STARTING->RESTORING",
      "RESTORING->RESTORE_FAILED",
    ]);
  });
});
