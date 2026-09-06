// Tests for the production RuntimeRegistry factory (issue #23).
// No real GCP: the Instances API is a FakeTransport (imported via the
// package's `./testing` entrypoint), the DB is the shared InMemoryFakeExecutor
// (via its `./testing` entrypoint), GCS is an in-memory GcsClient, and the
// agent-host phase runs as a second WorkspaceRuntime on the shared row.
// Issue #136: open() is async — no readiness endpoint is polled in-request.

import { describe, expect, test } from "bun:test";
import { FakeTransport } from "@cloud-run-dsh/cloud-run-instance-client/testing";
import {
  PostgresSessionPersistenceRepository,
  type SessionPersistenceRepository,
} from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import type { GcsClient } from "@cloud-run-dsh/workspace-checkpoint";
import {
  IdleManager,
  IllegalTransitionError,
  WorkspaceRuntime,
} from "@cloud-run-dsh/workspace-runtime";
import { SystemClock } from "./deps.js";
import { SqlTransactionalStateStore } from "./prod-adapters.js";
import type { ControlPlaneConfig } from "./config.js";
import {
  assertCloudSqlSocketConsistency,
  assertTwoMethodClock,
  buildInstanceEnv,
  buildInstancesBasePathForConfig,
  createProductionRuntimeRegistry,
  defaultInstanceName,
} from "./runtime-factory.js";
import {
  AgentHostConflictError,
  AgentHostForwardError,
  type ForwardCheckpointArgs,
  type ForwardPrepareStopArgs,
  type MessageForwarder,
} from "./forwarding.js";

const BASE_PATH = "https://run.googleapis.com/v2/projects/test-proj/locations/test-region";

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
    // Distinctive sentinel: leak assertions below search for this exact value.
    openrouterApiKey: "sk-or-v1-test-sentinel-key-0001",
    // Issue #56: must agree with the host= of agentHostDatabaseUrl above
    // (/cloudsql/<connection-name>) — the consistency guard enforces it.
    cloudSqlConnectionName: "test-proj:test-region:main",
    // Issue #109: pool budget, injected into created Instances.
    dbPoolMax: 5,
    dbPoolIdleTimeout: 30,
    dbPoolConnectionTimeout: 30,
    instanceGcIntervalMs: 3_600_000,
    instanceGcStaleAfterMs: 30 * 24 * 3_600_000,
    instanceGcMaxDeletesPerSweep: 10,
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

interface Harness {
  repo: SessionPersistenceRepository;
  executor: InMemoryFakeExecutor;
  transport: FakeTransport;
  gcs: MapGcsClient;
}

function makeHarness(): Harness {
  // One executor shared by the repository AND the state store — the prod shape
  // (one BunSqlQueryExecutor), so state transitions and row reads see one DB.
  const executor = new InMemoryFakeExecutor();
  const repo = new PostgresSessionPersistenceRepository(executor);
  const transport = new FakeTransport();
  const gcs = new MapGcsClient();
  return { repo, executor, transport, gcs };
}

async function seedWorkspace(repo: SessionPersistenceRepository, id = "ws-1") {
  return repo.createWorkspace({
    id,
    ownerId: "alice",
    repositoryOwner: "mpppk",
    repositoryName: "demo",
    baseBranch: "main",
    runtimeState: "STOPPED",
  });
}

function instanceBody(name: string, url: string) {
  return {
    name: `${BASE_PATH}/instances/${name}`,
    terminalCondition: { state: "CONDITION_SUCCEEDED" },
    urls: [url],
  };
}

/**
 * Stateful Instances API fake: GET 404s until POST create flips the instance
 * into existence; afterwards GET reports READY with the URL. Mirrors reality:
 * nothing exists before the first open creates it.
 */
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

function makeRegistry(
  h: Harness,
  configOverride?: Partial<ControlPlaneConfig>,
  extra?: { forwarder?: MessageForwarder },
) {
  return createProductionRuntimeRegistry({
    config: { ...testConfig(), ...configOverride },
    repo: h.repo,
    stateStore: new SqlTransactionalStateStore(h.executor),
    clock: new SystemClock(),
    instanceTransport: h.transport,
    gcsClient: h.gcs,
    controllerIdForWorkspace: () => "ctrl-1",
    messageForwarder: extra?.forwarder,
  });
}

/**
 * Agent-host role on the SHARED row (issue #60): a second WorkspaceRuntime
 * over the same executor, with no-op restore steps and a stub instance that
 * reports READY (the host is alive exactly when this code runs). Drives the
 * completeRestore() phase the control-plane handle deliberately skips.
 */
function makeAgentRuntime(h: Harness, workspaceId = "ws-1", cloneError?: Error): WorkspaceRuntime {
  const noop = async () => {};
  return new WorkspaceRuntime({
    workspaceId,
    store: new SqlTransactionalStateStore(h.executor),
    clock: new SystemClock(),
    instanceRuntime: {
      create: async () => ({ name: "dsh-ws-1", state: "READY" }),
      start: async () => {},
      stop: async () => {},
      get: async () => ({ name: "dsh-ws-1", state: "READY" }),
      delete: async () => {},
    },
    instanceName: "dsh-ws-1",
    steps: {
      cloneRepository: cloneError
        ? async () => {
            throw cloneError;
          }
        : noop,
      checkoutBase: noop,
      restoreCheckpoint: noop,
      createSandbox: noop,
      restoreHarness: noop,
      runLifecycleCheckpoint: noop,
      flushSessionPersistence: noop,
      deleteSandbox: noop,
    },
    idle: new IdleManager(new SystemClock()),
  });
}

/** Runs the agent-host restore phase to completion on the shared row. */
function driveAgentRestore(h: Harness, workspaceId = "ws-1"): Promise<string> {
  return makeAgentRuntime(h, workspaceId).completeRestore();
}

describe("createProductionRuntimeRegistry — open() drives the Instances API", () => {
  test("first open creates + starts and answers STARTING at once (issue #136: no in-request readiness wait)", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));

    const registry = makeRegistry(h);

    // Issue #60 案C: the control plane stops at STARTING (one shared
    // start); the agent-host phase completes the row to READY.
    const handle = await registry.get(workspace);
    const state = await handle.open();
    expect(state).toBe("STARTING");
    expect((await h.repo.getWorkspace("ws-1"))!.runtimeState).toBe("STARTING");

    const methods = h.transport.requests.map((r) => `${r.method} ${r.url}`);
    // Exactly the fast calls: existence GET, create, start. NO readiness
    // polling — the old 4th+ requests (instance GET loop + /readyz fetches)
    // are gone, so open() answers within seconds (issue #136).
    expect(methods).toEqual([
      `GET ${BASE_PATH}/instances/dsh-ws-1`,
      `POST ${BASE_PATH}/instances?instanceId=dsh-ws-1`,
      `POST ${BASE_PATH}/instances/dsh-ws-1:start`,
    ]);

    // create body: image + SA + Standard resources + all 13 agent-host env keys
    const createReq = h.transport.requests[1]!;
    const body = createReq.body as Record<string, unknown>;
    expect(body["restartPolicy"]).toBe("ON_FAILURE");
    // Issue #53: sandboxLauncher requires launchStage >= BETA on the live API.
    expect(body["launchStage"]).toBe("BETA");
    expect(body["serviceAccount"]).toBe("agent-host@test-proj.iam.gserviceaccount.com");
    const containers = body["containers"] as Array<Record<string, unknown>>;
    expect(containers[0]!["image"]).toBe(
      "test-region-docker.pkg.dev/test-proj/agent-host/agent-host:v1",
    );
    const env = Object.fromEntries(
      (containers[0]!["env"] as Array<{ name: string; value: string }>).map((e) => [
        e.name,
        e.value,
      ]),
    );
    expect(env["WORKSPACE_ID"]).toBe("ws-1");
    expect(env["INSTANCE_NAME"]).toBe("dsh-ws-1");
    expect(env["CONTROLLER_ID"]).toBe("ctrl-1");
    expect(env["USER_ID"]).toBe("alice");
    expect(env["REPOSITORY_OWNER"]).toBe("mpppk");
    expect(env["CHECKPOINT_BUCKET"]).toBe("test-checkpoints");
    expect(env["GITHUB_APP_ID"]).toBe("12345");
    // Issue #41: the created Instance carries the LLM key (fail-before-create
    // companion tests below cover the missing-key path).
    expect(env["OPENROUTER_API_KEY"]).toBe("sk-or-v1-test-sentinel-key-0001");

    // Issue #56: the created Instance carries the cloudSqlInstance volume
    // mounted at /cloudsql — without it the agent-host crash-loops with
    // ERR_POSTGRES_CONNECTION_REFUSED.
    expect(body["volumes"]).toEqual([
      {
        name: "cloudsql",
        cloudSqlInstance: { instances: ["test-proj:test-region:main"] },
      },
    ]);
    expect(containers[0]!["volumeMounts"]).toEqual([
      { name: "cloudsql", mountPath: "/cloudsql" },
    ]);
    // The socket the app dials (DATABASE_URL host=) is exactly the mounted
    // volume's path: mountPath + the volume's connection name. (Parsed by
    // hand: Bun's URL parser rejects socket DSNs — issue #42 — so the
    // assertion splits the query string instead of new URL().)
    const hostParam = env["DATABASE_URL"]!.split("?host=")[1]!.split("&")[0];
    expect(decodeURIComponent(hostParam!)).toBe("/cloudsql/test-proj:test-region:main");

    // agent-host readiness was NOT polled: no /readyz fetch happened, and
    // the row carries the instance name but no URL yet. The URL resolves on
    // demand through instanceUrlProvider (live Instances API GET) — this is
    // what keeps message forwarding working after an async open (issue #136
    // 事実2: the poll's row write is gone, the live lookup replaces it).
    const row = await h.repo.getWorkspace("ws-1");
    expect(row!.instanceName).toBe("dsh-ws-1");
    expect(row!.instanceUrl).toBeNull();
    expect(await handle.getInstanceUrl()).toBe("https://dsh-ws-1.run.app");
    // ... and the live lookup persisted it for direct row readers.
    expect((await h.repo.getWorkspace("ws-1"))!.instanceUrl).toBe("https://dsh-ws-1.run.app");

    // The agent-host phase completes the shared row: RESTORING -> READY.
    expect(await driveAgentRestore(h)).toBe("READY");
    expect((await h.repo.getWorkspace("ws-1"))!.runtimeState).toBe("READY");
    // A later open observes the agent-persisted READY without new API calls.
    const callsBefore = h.transport.requests.length;
    expect(await handle.open()).toBe("READY");
    expect(h.transport.requests.length).toBe(callsBefore);
  });

  test("second open skips create (instance exists) and just starts", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    let gets = 0;
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") {
        gets++;
        return { status: 200, body: instanceBody("dsh-ws-1", "https://dsh-ws-1.run.app") };
      }
      if (req.method === "POST") return { status: 200, body: {} };
      throw new Error(`unexpected request: ${req.method} ${req.url}`);
    });
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    expect(await handle.open()).toBe("STARTING");
    expect(await driveAgentRestore(h)).toBe("READY");
    expect(await handle.open()).toBe("READY");
    expect(gets).toBeGreaterThanOrEqual(1);
    expect(
      h.transport.requests.some(
        (r) => r.method === "POST" && r.url.includes("/instances?instanceId="),
      ),
    ).toBe(false);
    expect(
      h.transport.requests.some((r) => r.method === "POST" && r.url.endsWith(":start")),
    ).toBe(true);
  });

  test("stop() issues the :stop call and lands STOPPED", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") {
        return { status: 200, body: instanceBody("dsh-ws-1", "https://dsh-ws-1.run.app") };
      }
      return { status: 200, body: {} };
    });
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    expect(await handle.open()).toBe("STARTING");
    expect(await driveAgentRestore(h)).toBe("READY");
    expect(await handle.stop()).toBe("STOPPED");
    expect(
      h.transport.requests.some(
        (r) => r.method === "POST" && r.url === `${BASE_PATH}/instances/dsh-ws-1:stop`,
      ),
    ).toBe(true);
  });

  test("stop() treats a missing instance as already stopped (404 swallowed)", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") {
        return { status: 200, body: instanceBody("dsh-ws-1", "https://dsh-ws-1.run.app") };
      }
      if (req.method === "POST" && req.url.endsWith(":stop")) {
        return { status: 404, body: { message: "not found" } };
      }
      return { status: 200, body: {} };
    });
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    await handle.open();
    await driveAgentRestore(h);
    await expect(handle.stop()).resolves.toBe("STOPPED");
  });

  test("lost create race (409) falls through to start", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    let gets = 0;
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") {
        gets++;
        // First GET (existence check): missing. Later GETs report ready.
        if (gets === 1) return { status: 404, body: { message: "not found" } };
        return { status: 200, body: instanceBody("dsh-ws-1", "https://dsh-ws-1.run.app") };
      }
      if (req.method === "POST" && req.url.includes("/instances?instanceId=")) {
        return { status: 409, body: { message: "already exists" } };
      }
      return { status: 200, body: {} };
    });
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    await expect(handle.open()).resolves.toBe("STARTING");
    await expect(driveAgentRestore(h)).resolves.toBe("READY");
  });

  test("open records RESTORE_FAILED when the instance start fails (fail fast, in-request)", async () => {
    // Issue #136: the request still covers the fast instance start, so a
    // synchronous start failure rejects open() immediately and records
    // RESTORE_FAILED — only the minutes-long readiness wait moved out.
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") return { status: 404, body: { message: "not found" } };
      if (req.method === "POST" && req.url.includes("/instances?instanceId=")) {
        return { status: 200, body: { name: `${BASE_PATH}/operations/op-1`, done: true } };
      }
      return { status: 500, body: { message: "start failed: boom" } };
    });
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    await expect(handle.open()).rejects.toThrow();
    expect((await h.repo.getWorkspace("ws-1"))!.runtimeState).toBe("RESTORE_FAILED");
  });
});

describe("SqlTransactionalStateStore CAS mismatch shape (issue #63)", () => {
  test("reports (actual current, intended target) — same shape as the InMemory store", async () => {
    const h = makeHarness();
    await seedWorkspace(h.repo);
    const store = new SqlTransactionalStateStore(h.executor);
    await store.apply("ws-1", "STOPPED", "STARTING", "open");
    await store.apply("ws-1", "STARTING", "RESTORING", "instance-healthy");
    await store.apply("ws-1", "RESTORING", "RESTORE_FAILED", "restore-failed");

    // A stale writer still expects STARTING. The old swapped construction
    // threw "STARTING -> RESTORE_FAILED" here — byte-identical to the issue
    // #63 GCP report — which reads as a forbidden table edge.
    const err = await store
      .apply("ws-1", "STARTING", "RESTORING", "stale-writer")
      .then(
        (): IllegalTransitionError | null => null,
        (e: unknown) => e as IllegalTransitionError,
      );
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect(err!.from).toBe("RESTORE_FAILED");
    expect(err!.to).toBe("RESTORING");
    expect(await store.load("ws-1")).toBe("RESTORE_FAILED");
  });
});

describe("issue #60 — one lease, split state machine", () => {
  test("the open-established lease id reaches the Instance env (not a second random id)", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));
    // No controllerIdForWorkspace hook here: production passes the
    // open-established lease id explicitly, exactly like handlers.openWorkspace.
    const registry = createProductionRuntimeRegistry({
      config: testConfig(),
      repo: h.repo,
      stateStore: new SqlTransactionalStateStore(h.executor),
      clock: new SystemClock(),
      instanceTransport: h.transport,
      gcsClient: h.gcs,
    });
    const handle = await registry.get(workspace, "lease-ctrl-from-open");
    expect(await handle.open()).toBe("STARTING");

    const createReq = h.transport.requests.find(
      (r) => r.method === "POST" && r.url.includes("/instances?instanceId="),
    )!;
    const containers = (createReq.body as Record<string, unknown>)["containers"] as Array<
      Record<string, unknown>
    >;
    const env = Object.fromEntries(
      (containers[0]!["env"] as Array<{ name: string; value: string }>).map((e) => [
        e.name,
        e.value,
      ]),
    );
    // The agent-host adopts THIS id (issue #60 案B). A second random id here
    // is the old lease deadlock: the host's self-acquire would 409 against
    // the user's lease on the same row.
    expect(env["CONTROLLER_ID"]).toBe("lease-ctrl-from-open");
  });

  test("the agent-host must not run open(): it is refused from STARTING", async () => {
    const h = makeHarness();
    await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));
    const registry = makeRegistry(h);
    const handle = await registry.get(await h.repo.getWorkspace("ws-1").then((w) => w!));
    expect(await handle.open()).toBe("STARTING");

    // This is the exact production crash from issue #60
    // ("open is not allowed in state STARTING"): the shared row is already
    // STARTING, so a full open() — instance start included — is illegal. The
    // agent-host must call completeRestore() instead (案D).
    const agentRuntime = makeAgentRuntime(h);
    await expect(agentRuntime.open()).rejects.toThrow(/open is not allowed in state STARTING/);
    // ... while the narrow restore operation proceeds to READY.
    await expect(agentRuntime.completeRestore()).resolves.toBe("READY");
  });

  test("registry rebuilds the handle when a later open resolves a different lease", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));
    const registry = makeRegistry(h);

    const first = await registry.get(workspace, "ctrl-A");
    // Same lease id: the cached handle is reused (no rebuild churn for
    // stop/message flows, which pass no id at all).
    expect(await registry.get(workspace, "ctrl-A")).toBe(first);
    expect(await registry.get(workspace)).toBe(first);
    // A renewed lease (expiry + re-acquire): the stale env must not survive.
    const second = await registry.get(workspace, "ctrl-B");
    expect(second).not.toBe(first);
    expect(await registry.get(workspace, "ctrl-B")).toBe(second);
  });

  test("completeRestore from STOPPED is refused (host without a control-plane open)", async () => {
    const h = makeHarness();
    await seedWorkspace(h.repo);
    // No control-plane phase ran: the shared row is still STOPPED.
    await expect(makeAgentRuntime(h).completeRestore()).rejects.toThrow(
      /open is not allowed in state STOPPED/,
    );
  });
});

describe("buildInstancesBasePathForConfig — issue #47 absolute-URL contract", () => {
  test("assembles the production v2 basePath", () => {
    expect(buildInstancesBasePathForConfig(testConfig())).toBe(BASE_PATH);
  });

  test("every Instances API request is an absolute fetchable URL", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    await handle.open();
    expect(h.transport.requests.length).toBeGreaterThan(0);
    for (const req of h.transport.requests) {
      // The #47 failure mode: fetch(relative) throws "URL is invalid".
      expect(() => new URL(req.url)).not.toThrow();
      expect(req.url.startsWith("https://run.googleapis.com/v2/")).toBe(true);
    }
  });

  test("custom INSTANCES_API_BASE_URL (emulator) is honored", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") {
        return {
          status: 200,
          body: {
            name: "dsh-ws-1",
            terminalCondition: { state: "CONDITION_SUCCEEDED" },
            urls: ["https://dsh-ws-1.run.app"],
          },
        };
      }
      return { status: 200, body: {} };
    });
    const registry = makeRegistry(h, { instancesApiBaseUrl: "http://localhost:8080/v2/" });
    const handle = await registry.get(workspace);
    await handle.open();
    expect(h.transport.requests.length).toBeGreaterThan(0);
    for (const req of h.transport.requests) {
      expect(req.url.startsWith("http://localhost:8080/v2/projects/test-proj/locations/test-region/")).toBe(
        true,
      );
    }
  });
});

describe("getInstanceUrl — the #22 forwarding seam", () => {
  test("null before the first open; live URL after; durable row as fallback", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    expect(await handle.getInstanceUrl()).toBeNull();
    await handle.open();
    expect(await handle.getInstanceUrl()).toBe("https://dsh-ws-1.run.app");
  });

  test("deleted instance (GET 404): null + durable URL cleared, never the stale URL", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    await handle.open();
    // Issue #136: open() no longer persists the URL (no readiness poll) —
    // the row stays null until the first live lookup below.
    expect((await h.repo.getWorkspace("ws-1"))!.instanceUrl).toBeNull();
    expect(await handle.getInstanceUrl()).toBe("https://dsh-ws-1.run.app");
    expect(await h.repo.getWorkspace("ws-1")).toMatchObject({
      instanceUrl: "https://dsh-ws-1.run.app",
    });

    // The Instance is deleted out-of-band: the API 404s from now on.
    h.transport.setHandler(async () => ({ status: 404, body: { message: "not found" } }));
    expect(await handle.getInstanceUrl()).toBeNull();
    // The dead URL is cleared from the durable row too, so no other
    // reader can pick it up and forward to it.
    expect((await h.repo.getWorkspace("ws-1"))!.instanceUrl).toBeNull();
  });

  test("recreation in flight (READY-less GET without URL): null, not the old URL", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    await handle.open();

    // New generation exists but exposes no URL yet (PENDING): serving the
    // previous generation's address would forward to a dead Instance.
    h.transport.setHandler(async () => ({
      status: 200,
      body: { name: "dsh-ws-1", terminalCondition: { state: "CONDITION_PENDING" } },
    }));
    expect(await handle.getInstanceUrl()).toBeNull();

    // Once the new generation is READY with its (changed) URL, the live
    // lookup wins and the durable row follows it — no stale URL survives
    // the recreation.
    h.transport.setHandler(async () => ({
      status: 200,
      body: instanceBody("dsh-ws-1", "https://dsh-ws-1-new.run.app"),
    }));
    expect(await handle.getInstanceUrl()).toBe("https://dsh-ws-1-new.run.app");
    expect((await h.repo.getWorkspace("ws-1"))!.instanceUrl).toBe(
      "https://dsh-ws-1-new.run.app",
    );
  });
});

describe("handle.describeInstance — the #141 fast-fail probe", () => {
  test("missing Instance (GET 404) reports exists:false with exactly one GET", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async () => ({ status: 404, body: { message: "not found" } }));
    const handle = await makeRegistry(h).get(workspace);
    expect(handle.describeInstance).toBeDefined();
    expect(await handle.describeInstance!()).toEqual({ exists: false });
    // One GET, never a poll: the #136 案C rejection (no background CPU)
    // applies to this probe too.
    expect(h.transport.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${BASE_PATH}/instances/dsh-ws-1`,
    ]);
  });

  test("FAILED Instance reports its state; READY reports READY (both defer/fail upstream)", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async () => ({
      status: 200,
      body: { name: "dsh-ws-1", terminalCondition: { state: "CONDITION_FAILED" } },
    }));
    const handle = await makeRegistry(h).get(workspace);
    expect(await handle.describeInstance!()).toEqual({ exists: true, state: "FAILED" });

    h.transport.setHandler(async () => ({
      status: 200,
      body: instanceBody("dsh-ws-1", "https://dsh-ws-1.run.app"),
    }));
    expect(await handle.describeInstance!()).toEqual({ exists: true, state: "READY" });
  });

  test("transient API failure throws (the caller defers — unknown is never failed)", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async () => ({ status: 500, body: { message: "boom" } }));
    const handle = await makeRegistry(h).get(workspace);
    await expect(handle.describeInstance!()).rejects.toThrow(/boom/);
  });
});

describe("handle.deleteInstance — the #85 GC seam", () => {
  test("issues DELETE for the workspace's own Instance name", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async (req) => {
      if (req.method === "DELETE") return { status: 200, body: {} };
      throw new Error(`unexpected request: ${req.method} ${req.url}`);
    });
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    await handle.deleteInstance();
    expect(h.transport.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `DELETE ${BASE_PATH}/instances/dsh-ws-1`,
    ]);
  });

  test("missing Instance (404) resolves — the desired end state already holds", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async () => ({ status: 404, body: { message: "not found" } }));
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    await expect(handle.deleteInstance()).resolves.toBeUndefined();
  });

  test("other API failures propagate (the caller answers 502 and keeps the row)", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async () => ({ status: 500, body: { message: "boom" } }));
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    await expect(handle.deleteInstance()).rejects.toThrow(/boom/);
  });
});

describe("runManualCheckpoint — GCS marker", () => {
  test("writes a timestamped marker under the workspace prefix", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") {
        return { status: 200, body: instanceBody("dsh-ws-1", "https://dsh-ws-1.run.app") };
      }
      return { status: 200, body: {} };
    });
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    await handle.open();
    // Checkpoints require agent input, which is refused until the agent-host
    // phase completes the restore (issue #60). The re-open observes the
    // agent-persisted READY into this handle, like a real second open.
    await driveAgentRestore(h);
    expect(await handle.open()).toBe("READY");
    // Issue #89: the test-only no-remote fallback consulted no host, so
    // there is no skip to report — the marker write itself succeeded.
    await expect(handle.runManualCheckpoint()).resolves.toEqual({ skipped: false });
    const keys = [...h.gcs.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]!.startsWith("workspaces/ws-1/manual-checkpoints/")).toBe(true);
    const marker = JSON.parse(new TextDecoder().decode(h.gcs.objects.get(keys[0]!)!)) as Record<
      string,
      unknown
    >;
    expect(marker["workspaceId"]).toBe("ws-1");
    expect(typeof marker["requestedAt"]).toBe("string");
  });
});

describe("stop() remote preparation (issue #72)", () => {
  const CALLER = { id: "alice", email: "alice@example.com" };

  /** MessageForwarder fake with switchable prepare-stop behavior. */
  class FakeLifecycleForwarder implements MessageForwarder {
    prepareCalls: ForwardPrepareStopArgs[] = [];
    checkpointCalls: ForwardCheckpointArgs[] = [];
    prepareBehavior: "ok" | "forward-error" | "conflict" = "ok";
    checkpointSkipped = false;

    async forward(): Promise<{ status: number; turnStarted: boolean }> {
      throw new Error("message forward not used in lifecycle tests");
    }
    async forwardApproval(): Promise<{ status: number; turnStarted: boolean }> {
      throw new Error("approval forward not used in lifecycle tests");
    }
    async forwardCancel(): Promise<{ status: number; turnStarted: boolean }> {
      throw new Error("cancel forward not used in lifecycle tests");
    }
    async forwardPrepareStop(args: ForwardPrepareStopArgs) {
      this.prepareCalls.push(args);
      if (this.prepareBehavior === "forward-error") {
        throw new AgentHostForwardError("agent-host answered 502: checkpoint failed");
      }
      if (this.prepareBehavior === "conflict") {
        throw new AgentHostConflictError("agent-host refused the request (status 409)");
      }
      return { status: 200, prepared: true, state: "STOPPING" };
    }
    async forwardCheckpoint(args: ForwardCheckpointArgs) {
      this.checkpointCalls.push(args);
      return {
        status: 200,
        checkpointed: true,
        skipped: this.checkpointSkipped,
        state: "READY",
      };
    }
  }

  /** Open + agent restore, ready to stop, against a live-looking instance. */
  async function openReady(h: Harness, registry: ReturnType<typeof makeRegistry>) {
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") {
        return { status: 200, body: instanceBody("dsh-ws-1", "https://dsh-ws-1.run.app") };
      }
      return { status: 200, body: {} };
    });
    const handle = await registry.get(workspace);
    await handle.open();
    await driveAgentRestore(h);
    expect(await handle.open()).toBe("READY");
    return handle;
  }

  function stopCalled(h: Harness): boolean {
    return h.transport.requests.some(
      (r) => r.method === "POST" && r.url === `${BASE_PATH}/instances/dsh-ws-1:stop`,
    );
  }

  test("stop() prepares remotely with the caller identity, then stops the instance", async () => {
    const h = makeHarness();
    const forwarder = new FakeLifecycleForwarder();
    const registry = makeRegistry(h, undefined, { forwarder });
    const handle = await openReady(h, registry);
    expect(await handle.stop(CALLER)).toBe("STOPPED");
    // The prepare-stop reached the host with the REAL caller — never a
    // fabricated service-account identity.
    expect(forwarder.prepareCalls).toHaveLength(1);
    expect(forwarder.prepareCalls[0]!.identity).toEqual(CALLER);
    expect(forwarder.prepareCalls[0]!.instanceUrl).toBe("https://dsh-ws-1.run.app");
    expect(stopCalled(h)).toBe(true);
  });

  test("prepare-stop failure -> CHECKPOINT_FAILED and the Cloud Run :stop is NEVER called", async () => {
    const h = makeHarness();
    const forwarder = new FakeLifecycleForwarder();
    forwarder.prepareBehavior = "forward-error";
    const registry = makeRegistry(h, undefined, { forwarder });
    const handle = await openReady(h, registry);
    // The checkpoint guard (issue #72): the workspace was never saved, so
    // the instance stop — which would discard everything — must not run.
    expect(await handle.stop(CALLER)).toBe("CHECKPOINT_FAILED");
    expect(forwarder.prepareCalls).toHaveLength(1);
    expect(stopCalled(h)).toBe(false);
    expect((await h.repo.getWorkspace("ws-1"))!.runtimeState).toBe("CHECKPOINT_FAILED");
  });

  test("prepare-stop conflict (stale host generation) also blocks the instance stop", async () => {
    const h = makeHarness();
    const forwarder = new FakeLifecycleForwarder();
    forwarder.prepareBehavior = "conflict";
    const registry = makeRegistry(h, undefined, { forwarder });
    const handle = await openReady(h, registry);
    // A host-side refusal is a checkpoint-step failure too: the workspace
    // state is unverified, so stopping would risk silent work loss.
    expect(await handle.stop(CALLER)).toBe("CHECKPOINT_FAILED");
    expect(stopCalled(h)).toBe(false);
  });

  test("stop() with a forwarder but no caller identity fails closed (never faceless)", async () => {
    const h = makeHarness();
    const forwarder = new FakeLifecycleForwarder();
    const registry = makeRegistry(h, undefined, { forwarder });
    const handle = await openReady(h, registry);
    expect(await handle.stop()).toBe("CHECKPOINT_FAILED");
    expect(forwarder.prepareCalls).toHaveLength(0);
    expect(stopCalled(h)).toBe(false);
  });

  test("already-stopped workspace: stop() never attempts a remote preparation", async () => {
    const h = makeHarness();
    const forwarder = new FakeLifecycleForwarder();
    const registry = makeRegistry(h, undefined, { forwarder });
    const workspace = await seedWorkspace(h.repo);
    const handle = await registry.get(workspace);
    expect(await handle.stop(CALLER)).toBe("STOPPED");
    expect(forwarder.prepareCalls).toHaveLength(0);
    expect(stopCalled(h)).toBe(false);
  });

  test("instance already gone (GET 404): stop() skips the remote call and still lands STOPPED", async () => {
    const h = makeHarness();
    const forwarder = new FakeLifecycleForwarder();
    const registry = makeRegistry(h, undefined, { forwarder });
    const handle = await openReady(h, registry);
    // The instance vanished out of band (operator deleted it, previous
    // generation): there is nothing alive left to preserve, so the stop
    // must succeed instead of failing on an unreachable prepare-stop.
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") return { status: 404, body: { message: "not found" } };
      if (req.method === "POST" && req.url.endsWith(":stop")) {
        return { status: 404, body: { message: "not found" } };
      }
      return { status: 200, body: {} };
    });
    expect(await handle.stop(CALLER)).toBe("STOPPED");
    expect(forwarder.prepareCalls).toHaveLength(0);
  });
});

describe("runManualCheckpoint remote trigger (issue #75)", () => {
  const CALLER = { id: "alice", email: "alice@example.com" };

  class FakeCheckpointForwarder implements MessageForwarder {
    checkpointCalls: ForwardCheckpointArgs[] = [];
    checkpointSkipped = false;
    async forward(): Promise<{ status: number; turnStarted: boolean }> {
      throw new Error("not used");
    }
    async forwardApproval(): Promise<{ status: number; turnStarted: boolean }> {
      throw new Error("not used");
    }
    async forwardCancel(): Promise<{ status: number; turnStarted: boolean }> {
      throw new Error("not used");
    }
    async forwardPrepareStop(): Promise<{
      status: number;
      prepared: boolean;
      state: string;
    }> {
      throw new Error("not used");
    }
    async forwardCheckpoint(args: ForwardCheckpointArgs) {
      this.checkpointCalls.push(args);
      return {
        status: 200,
        checkpointed: true,
        skipped: this.checkpointSkipped,
        state: "READY",
      };
    }
  }

  async function openReady(h: Harness, registry: ReturnType<typeof makeRegistry>) {
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") {
        return { status: 200, body: instanceBody("dsh-ws-1", "https://dsh-ws-1.run.app") };
      }
      return { status: 200, body: {} };
    });
    const handle = await registry.get(workspace);
    await handle.open();
    await driveAgentRestore(h);
    expect(await handle.open()).toBe("READY");
    return handle;
  }

  function readMarker(h: Harness): Record<string, unknown> {
    const keys = [...h.gcs.objects.keys()];
    expect(keys).toHaveLength(1);
    return JSON.parse(new TextDecoder().decode(h.gcs.objects.get(keys[0]!)!)) as Record<
      string,
      unknown
    >;
  }

  test("takes a real host checkpoint first, then writes the marker with the skip flag", async () => {
    const h = makeHarness();
    const forwarder = new FakeCheckpointForwarder();
    const registry = makeRegistry(h, undefined, { forwarder });
    const handle = await openReady(h, registry);
    // Issue #89: the host's skip flag flows back to the caller, matching
    // what the marker records below.
    await expect(handle.runManualCheckpoint(CALLER)).resolves.toEqual({ skipped: false });
    expect(forwarder.checkpointCalls).toHaveLength(1);
    expect(forwarder.checkpointCalls[0]!.identity).toEqual(CALLER);
    expect(forwarder.checkpointCalls[0]!.instanceUrl).toBe("https://dsh-ws-1.run.app");
    const marker = readMarker(h);
    expect(marker["workspaceId"]).toBe("ws-1");
    expect(marker["checkpointSkipped"]).toBe(false);
  });

  test("host clean-tree skip is recorded on the marker (still success)", async () => {
    const h = makeHarness();
    const forwarder = new FakeCheckpointForwarder();
    forwarder.checkpointSkipped = true;
    const registry = makeRegistry(h, undefined, { forwarder });
    const handle = await openReady(h, registry);
    await expect(handle.runManualCheckpoint(CALLER)).resolves.toEqual({ skipped: true });
    expect(readMarker(h)["checkpointSkipped"]).toBe(true);
  });

  test("stopped instance (no URL): manual checkpoint is a caller-visible conflict, no marker", async () => {
    const h = makeHarness();
    const forwarder = new FakeCheckpointForwarder();
    const registry = makeRegistry(h, undefined, { forwarder });
    const handle = await openReady(h, registry);
    h.transport.setHandler(async () => ({ status: 404, body: { message: "not found" } }));
    await expect(handle.runManualCheckpoint(CALLER)).rejects.toThrow(/not running/);
    expect(forwarder.checkpointCalls).toHaveLength(0);
    expect([...h.gcs.objects.keys()]).toHaveLength(0);
  });
});

describe("clock pitfall regression (issue #23)", () => {
  test("one-method T6-style clock is rejected at factory construction, not first open()", () => {
    const h = makeHarness();
    const oneMethodClock = { now: () => new Date() } as unknown as SystemClock;
    expect(() =>
      createProductionRuntimeRegistry({
        config: testConfig(),
        repo: h.repo,
        stateStore: new SqlTransactionalStateStore(h.executor),
        clock: oneMethodClock,
        instanceTransport: h.transport,
        gcsClient: h.gcs,
      }),
    ).toThrow(/nowMs/);
  });

  test("assertTwoMethodClock accepts the two-method SystemClock", () => {
    expect(() => assertTwoMethodClock(new SystemClock())).not.toThrow();
    expect(() =>
      assertTwoMethodClock({ now: () => new Date(), nowMs: () => 1 }),
    ).not.toThrow();
  });

  test("SystemClock actually implements both methods", () => {
    const clock = new SystemClock();
    expect(clock.now()).toBeInstanceOf(Date);
    expect(typeof clock.nowMs()).toBe("number");
  });
});

describe("buildInstanceEnv — agent-host env contract", () => {
  test("emits exactly the agent-host required keys plus identity keys", () => {
    const config = testConfig();
    const workspace = {
      id: "ws-1",
      ownerId: "alice",
      repositoryOwner: "mpppk",
      repositoryName: "demo",
      baseBranch: "main",
      instanceName: null,
      instanceUrl: null,
      runtimeState: "STOPPED",
      lastError: null,
      lastActivityAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as const;
    const env = buildInstanceEnv(config, workspace, "dsh-ws-1", "ctrl-1");
    expect(Object.keys(env).sort()).toEqual(
      [
        "BASE_BRANCH",
        "CHECKPOINT_BUCKET",
        "CONTROLLER_ID",
        "DATABASE_URL",
        "DB_POOL_CONNECTION_TIMEOUT",
        "DB_POOL_IDLE_TIMEOUT",
        "DB_POOL_MAX",
        "GCP_PROJECT_ID",
        "GCP_REGION",
        "GITHUB_APP_ID",
        "GITHUB_APP_PRIVATE_KEY_PEM",
        "INSTANCE_NAME",
        "OPENROUTER_API_KEY",
        "REPOSITORY_NAME",
        "REPOSITORY_OWNER",
        "USER_ID",
        "WORKSPACE_ID",
      ].sort(),
    );
    expect(env["DATABASE_URL"]).toBe(config.agentHostDatabaseUrl);
    // Issue #109: the Instance pool budget is dictated by the control plane
    // (same 25-slot db-f1-micro budget — Bun defaults would re-exhaust it).
    expect(env["DB_POOL_MAX"]).toBe("5");
    expect(env["DB_POOL_IDLE_TIMEOUT"]).toBe("30");
    expect(env["DB_POOL_CONNECTION_TIMEOUT"]).toBe("30");
    expect(env["GITHUB_APP_PRIVATE_KEY_PEM"]).toBe(config.githubAppPrivateKeyPem);
    // Issue #41: the Instance env carries the LLM key value (agent-host
    // resolves it per request via its default LLM_API_KEY_ENV).
    expect(env["OPENROUTER_API_KEY"]).toBe("sk-or-v1-test-sentinel-key-0001");
    // Optional overrides are absent by default — the agent-host defaults apply.
    expect("LLM_BASE_URL" in env).toBe(false);
    expect("LLM_MODEL" in env).toBe(false);
    expect("LLM_APPROVAL_POLICY" in env).toBe(false);
  });

  test("optional LLM overrides pass through to the Instance env when configured", () => {
    const config: ControlPlaneConfig = {
      ...testConfig(),
      llmBaseUrl: "https://llm.example.test/v1",
      llmModel: "example/model-x",
      llmApprovalPolicy: "never",
    };
    const workspace = {
      id: "ws-1",
      ownerId: "alice",
      repositoryOwner: "mpppk",
      repositoryName: "demo",
      baseBranch: "main",
      instanceName: null,
      instanceUrl: null,
      runtimeState: "STOPPED",
      lastError: null,
      lastActivityAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as const;
    const env = buildInstanceEnv(config, workspace, "dsh-ws-1", "ctrl-1");
    expect(env["OPENROUTER_API_KEY"]).toBe("sk-or-v1-test-sentinel-key-0001");
    expect(env["LLM_BASE_URL"]).toBe("https://llm.example.test/v1");
    expect(env["LLM_MODEL"]).toBe("example/model-x");
    expect(env["LLM_APPROVAL_POLICY"]).toBe("never");
  });

  test("blank LLM key fails before any Instances API call, without leaking the value", () => {
    const config = testConfig();
    const workspace = {
      id: "ws-1",
      ownerId: "alice",
      repositoryOwner: "mpppk",
      repositoryName: "demo",
      baseBranch: "main",
      instanceName: null,
      instanceUrl: null,
      runtimeState: "STOPPED",
      lastError: null,
      lastActivityAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as const;
    // Unit level: buildInstanceEnv throws and names only the variable.
    // (There is no key VALUE to leak here — the throw happens precisely
    // because the value is blank. Value-leak coverage lives in the
    // "open() failure surfaces" test below, which runs with the sentinel key.)
    for (const blank of ["", "   "]) {
      let message = "";
      try {
        buildInstanceEnv({ ...config, openrouterApiKey: blank }, workspace, "dsh-ws-1", "ctrl-1");
        expect.unreachable("expected buildInstanceEnv to throw for a blank LLM key");
      } catch (e) {
        message = String(e);
      }
      expect(message).toContain("OPENROUTER_API_KEY");
    }
  });

  test("registry get() with a blank LLM key rejects without touching the Instances API", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));
    const registry = makeRegistry(h, { openrouterApiKey: "   " });
    // buildInstanceEnv runs inside the registry factory, so the failure lands
    // at handle creation — before open(), before any GET/create/start.
    await expect(registry.get(workspace)).rejects.toThrow(/OPENROUTER_API_KEY/);
    // Fail-before-create (#22 "never fake success"): no GET/create/start was sent.
    expect(h.transport.requests).toEqual([]);
  });

  test("open() failure surfaces never contain the LLM key value", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    // Every Instances API call fails: the rejection must still not carry the key.
    h.transport.setHandler(async () => ({ status: 500, body: { message: "boom" } }));
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    let message = "";
    try {
      await handle.open();
    } catch (e) {
      message = String(e);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("sk-or-v1-test-sentinel-key-0001");
  });

  test("defaultInstanceName honors an explicit instanceName, else dsh-<id>", () => {
    expect(defaultInstanceName({ id: "ws-1", instanceName: null })).toBe("dsh-ws-1");
    expect(defaultInstanceName({ id: "ws-1", instanceName: "custom" })).toBe("custom");
  });
});

describe("assertCloudSqlSocketConsistency — issue #56 mount/DATABASE_URL contract", () => {
  const SOCKET_URL =
    "postgresql://dsh_app:pw@/dsh?host=/cloudsql/test-proj:test-region:main";
  const CONN = "test-proj:test-region:main";

  test("matching connection name and socket host passes", () => {
    expect(() => assertCloudSqlSocketConsistency(SOCKET_URL, CONN)).not.toThrow();
  });

  test("mismatched connection name throws naming both sides, never the password", () => {
    const secret = "s3cr3t-pw";
    const url = `postgresql://dsh_app:${secret}@/dsh?host=/cloudsql/other-proj:r:other-pg`;
    let message = "";
    try {
      assertCloudSqlSocketConsistency(url, CONN);
      expect.unreachable("expected a consistency error for a mismatched host");
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("AGENT_HOST_DATABASE_URL");
    expect(message).toContain("CLOUD_SQL_CONNECTION_NAME");
    expect(message).toContain("/cloudsql/test-proj:test-region:main");
    expect(message).not.toContain(secret);
  });

  test("blank connection name throws naming CLOUD_SQL_CONNECTION_NAME", () => {
    for (const blank of ["", "   "]) {
      expect(() => assertCloudSqlSocketConsistency(SOCKET_URL, blank)).toThrow(
        /CLOUD_SQL_CONNECTION_NAME/,
      );
    }
  });

  test("non-socket (TCP / host-less) DATABASE_URL throws instead of building a doomed Instance", () => {
    for (const url of ["postgres://dsh_app:pw@localhost:5432/dsh", "postgresql://x"]) {
      expect(() => assertCloudSqlSocketConsistency(url, CONN)).toThrow(
        /AGENT_HOST_DATABASE_URL/,
      );
    }
  });

  test("registry get() with a mismatched host rejects without touching the Instances API", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));
    const registry = makeRegistry(h, {
      cloudSqlConnectionName: "other-proj:other-region:other-pg",
    });
    // Same timing as the #41 OPENROUTER_API_KEY guard: handle creation fails
    // before open(), before any GET/create/start.
    await expect(registry.get(workspace)).rejects.toThrow(/CLOUD_SQL_CONNECTION_NAME/);
    expect(h.transport.requests).toEqual([]);
  });

  test("registry get() with a blank connection name rejects without touching the Instances API", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));
    const registry = makeRegistry(h, { cloudSqlConnectionName: "   " });
    await expect(registry.get(workspace)).rejects.toThrow(/CLOUD_SQL_CONNECTION_NAME/);
    expect(h.transport.requests).toEqual([]);
  });
});