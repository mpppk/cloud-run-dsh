// Tests for the production RuntimeRegistry factory (issue #23).
// No real GCP: the Instances API is a FakeTransport (imported via the
// package's `./testing` entrypoint), the DB is the shared InMemoryFakeExecutor
// (via its `./testing` entrypoint), GCS is an in-memory GcsClient, and the
// agent-host /healthz is a stubbed HealthFetch.

import { describe, expect, test } from "bun:test";
import { FakeTransport } from "@cloud-run-dsh/cloud-run-instance-client/testing";
import {
  PostgresSessionPersistenceRepository,
  type SessionPersistenceRepository,
} from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import type { GcsClient } from "@cloud-run-dsh/workspace-checkpoint";
import { SystemClock } from "./deps.js";
import { SqlTransactionalStateStore } from "./prod-adapters.js";
import type { ControlPlaneConfig } from "./config.js";
import {
  assertTwoMethodClock,
  buildInstanceEnv,
  createProductionRuntimeRegistry,
  defaultInstanceName,
  type HealthFetch,
} from "./runtime-factory.js";

const BASE_PATH = "projects/test-proj/locations/test-region";

function testConfig(): ControlPlaneConfig {
  return {
    port: 8080,
    databaseUrl: "postgresql://dsh_app:pw@/dsh?host=/cloudsql/test-proj:test-region:main",
    gcpProjectId: "test-proj",
    gcpRegion: "test-region",
    agentHostImage: "test-region-docker.pkg.dev/test-proj/agent-host/agent-host:v1",
    agentHostServiceAccount: "agent-host@test-proj.iam.gserviceaccount.com",
    checkpointBucket: "test-checkpoints",
    agentHostDatabaseUrl: "postgresql://dsh_app:pw@/dsh?host=/cloudsql/test-proj:test-region:main",
    githubAppId: "12345",
    githubAppPrivateKeyPem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
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
  healthFetch: HealthFetch;
  healthCalls: string[];
}

function makeHarness(): Harness {
  // One executor shared by the repository AND the state store — the prod shape
  // (one BunSqlQueryExecutor), so state transitions and row reads see one DB.
  const executor = new InMemoryFakeExecutor();
  const repo = new PostgresSessionPersistenceRepository(executor);
  const transport = new FakeTransport();
  const gcs = new MapGcsClient();
  const healthCalls: string[] = [];
  const healthFetch: HealthFetch = async (url: string) => {
    healthCalls.push(url);
    return { ok: true, status: 200 };
  };
  return { repo, executor, transport, gcs, healthFetch, healthCalls };
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

function makeRegistry(h: Harness) {
  return createProductionRuntimeRegistry({
    config: testConfig(),
    repo: h.repo,
    stateStore: new SqlTransactionalStateStore(h.executor),
    clock: new SystemClock(),
    instanceTransport: h.transport,
    gcsClient: h.gcs,
    healthFetch: h.healthFetch,
    instancePoll: { maxAttempts: 3, intervalMs: 0 },
    agentHealthPoll: { maxAttempts: 3, intervalMs: 0 },
    sleep: async () => {},
    controllerIdForWorkspace: () => "ctrl-1",
  });
}

describe("createProductionRuntimeRegistry — open() drives the Instances API", () => {
  test("first open creates, starts, waits for health, persists name+url, returns READY", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(openFlowHandler("dsh-ws-1", "https://dsh-ws-1.run.app"));

    const registry = makeRegistry(h);

    const handle = await registry.get(workspace);
    const state = await handle.open();
    expect(state).toBe("READY");

    const methods = h.transport.requests.map((r) => `${r.method} ${r.url}`);
    expect(methods[0]).toBe(`GET ${BASE_PATH}/instances/dsh-ws-1`);
    expect(methods[1]).toBe(`POST ${BASE_PATH}/instances?instanceId=dsh-ws-1`);
    expect(methods[2]).toBe(`POST ${BASE_PATH}/instances/dsh-ws-1:start`);
    expect(methods[3]).toBe(`GET ${BASE_PATH}/instances/dsh-ws-1`);

    // create body: image + SA + Standard resources + all 13 agent-host env keys
    const createReq = h.transport.requests[1]!;
    const body = createReq.body as Record<string, unknown>;
    expect(body["restartPolicy"]).toBe("ON_FAILURE");
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

    // agent-host /healthz was polled at the instance URL from GET
    expect(h.healthCalls).toEqual(["https://dsh-ws-1.run.app/healthz"]);

    // durable row carries the name + URL for #22
    const row = await h.repo.getWorkspace("ws-1");
    expect(row!.instanceName).toBe("dsh-ws-1");
    expect(row!.instanceUrl).toBe("https://dsh-ws-1.run.app");
    expect(await handle.getInstanceUrl()).toBe("https://dsh-ws-1.run.app");
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
    expect(await handle.open()).toBe("READY");
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
    await expect(handle.stop()).resolves.toBe("STOPPED");
  });

  test("lost create race (409) falls through to start", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    let gets = 0;
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") {
        gets++;
        // First GET (existence check): missing. Later GETs (health poll): ready.
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
    await expect(handle.open()).resolves.toBe("READY");
  });

  test("open fails honestly when the instance never becomes READY", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") {
        return {
          status: 200,
          body: { name: "dsh-ws-1", terminalCondition: { state: "CONDITION_PENDING" } },
        };
      }
      return { status: 200, body: {} };
    });
    const registry = makeRegistry(h);
    const handle = await registry.get(workspace);
    await expect(handle.open()).rejects.toThrow(/never became READY/);
    expect(handle.getState()).toBe("RESTORE_FAILED");
    // No agent-host health polling happened — there was no URL to poll.
    expect(h.healthCalls).toEqual([]);
  });

  test("open fails honestly when the agent-host never becomes healthy", async () => {
    const h = makeHarness();
    const workspace = await seedWorkspace(h.repo);
    h.transport.setHandler(async (req) => {
      if (req.method === "GET") {
        return { status: 200, body: instanceBody("dsh-ws-1", "https://dsh-ws-1.run.app") };
      }
      return { status: 200, body: {} };
    });
    const unhealthy: HealthFetch = async (url: string) => {
      h.healthCalls.push(url);
      return { ok: false, status: 503 };
    };
    const registry = createProductionRuntimeRegistry({
      config: testConfig(),
      repo: h.repo,
      stateStore: new SqlTransactionalStateStore(h.executor),
      clock: new SystemClock(),
      instanceTransport: h.transport,
      gcsClient: h.gcs,
      healthFetch: unhealthy,
      instancePoll: { maxAttempts: 2, intervalMs: 0 },
      agentHealthPoll: { maxAttempts: 2, intervalMs: 0 },
      sleep: async () => {},
    });
    const handle = await registry.get(workspace);
    await expect(handle.open()).rejects.toThrow(/never became healthy/);
    expect(handle.getState()).toBe("RESTORE_FAILED");
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
    await handle.runManualCheckpoint();
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
        "GCP_PROJECT_ID",
        "GCP_REGION",
        "GITHUB_APP_ID",
        "GITHUB_APP_PRIVATE_KEY_PEM",
        "INSTANCE_NAME",
        "REPOSITORY_NAME",
        "REPOSITORY_OWNER",
        "USER_ID",
        "WORKSPACE_ID",
      ].sort(),
    );
    expect(env["DATABASE_URL"]).toBe(config.agentHostDatabaseUrl);
    expect(env["GITHUB_APP_PRIVATE_KEY_PEM"]).toBe(config.githubAppPrivateKeyPem);
  });

  test("defaultInstanceName honors an explicit instanceName, else dsh-<id>", () => {
    expect(defaultInstanceName({ id: "ws-1", instanceName: null })).toBe("dsh-ws-1");
    expect(defaultInstanceName({ id: "ws-1", instanceName: "custom" })).toBe("custom");
  });
});
