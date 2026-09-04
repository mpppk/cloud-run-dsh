import { describe, test, expect } from "bun:test";
import {
  DEFAULT_INSTANCE_CONFIG,
  INSTANCE_PROFILES,
  AVAILABLE_PROFILES,
  DEFAULT_INSTANCES_API_BASE_URL,
  InvalidBasePathError,
  buildInstancesBasePath,
  configForProfile,
  toApiRestartPolicy,
  ProfileNotAvailableError,
  InvalidRestartPolicyError,
  InstanceNotFoundError,
  InstanceAlreadyExistsError,
  PermissionDeniedError,
  InstanceClientError,
  CloudRunInstanceClient,
} from "./index.js";
import { FakeTransport } from "./testing.js";

describe("cloud-run-instance-client config defaults", () => {
  test("DEFAULT_INSTANCE_CONFIG matches spec section 6", () => {
    expect(DEFAULT_INSTANCE_CONFIG.cpu).toBe(4);
    expect(DEFAULT_INSTANCE_CONFIG.memory).toBe("8Gi");
    expect(DEFAULT_INSTANCE_CONFIG.restartPolicy).toBe("on-failure");
    expect(DEFAULT_INSTANCE_CONFIG.sandboxLauncher).toBe(true);
    expect(DEFAULT_INSTANCE_CONFIG.port).toBe(8080);
  });

  test("profile mapping matches spec section 22", () => {
    expect(INSTANCE_PROFILES.Small).toEqual({
      cpu: 2,
      memory: "4Gi",
      restartPolicy: "on-failure",
      sandboxLauncher: true,
      port: 8080,
    });
    expect(INSTANCE_PROFILES.Standard).toEqual(DEFAULT_INSTANCE_CONFIG);
    expect(INSTANCE_PROFILES.Large).toEqual({
      cpu: 8,
      memory: "16Gi",
      restartPolicy: "on-failure",
      sandboxLauncher: true,
      port: 8080,
    });
  });

  test("AVAILABLE_PROFILES exposes Standard only in v1", () => {
    expect(AVAILABLE_PROFILES).toEqual(["Standard"]);
  });

  test("configForProfile returns Standard", () => {
    expect(configForProfile("Standard")).toEqual(DEFAULT_INSTANCE_CONFIG);
  });

  test("configForProfile rejects Small/Large in v1", () => {
    expect(() => configForProfile("Small")).toThrow(ProfileNotAvailableError);
    expect(() => configForProfile("Large")).toThrow(ProfileNotAvailableError);
  });

  test("client uses default config when none provided", () => {
    const t = new FakeTransport();
    const c = new CloudRunInstanceClient({ transport: t, basePath: "https://run.googleapis.com/v2/projects/p/locations/us-central1" });
    expect(c.getConfig()).toEqual(DEFAULT_INSTANCE_CONFIG);
  });

  test("client uses profile config", () => {
    const t = new FakeTransport();
    const c = new CloudRunInstanceClient({
      transport: t,
      basePath: "https://run.googleapis.com/v2/projects/p/locations/us-central1",
      profile: "Standard",
    });
    expect(c.getConfig()).toEqual(DEFAULT_INSTANCE_CONFIG);
  });
});

describe("cloud-run-instance-client restartPolicy always rejection", () => {
  test("constructor rejects always with typed error", () => {
    const t = new FakeTransport();
    expect(
      () =>
        new CloudRunInstanceClient({
          transport: t,
          basePath: "https://run.googleapis.com/v2/projects/p/locations/us-central1",
          config: { cpu: 4, memory: "8Gi", restartPolicy: "always", sandboxLauncher: true, port: 8080 },
        }),
    ).toThrow(InvalidRestartPolicyError);
  });

  test("error message cites spec section 23 Preview issue", () => {
    const t = new FakeTransport();
    try {
      new CloudRunInstanceClient({
        transport: t,
        basePath: "https://run.googleapis.com/v2/projects/p/locations/us-central1",
        config: { cpu: 4, memory: "8Gi", restartPolicy: "always", sandboxLauncher: true, port: 8080 },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidRestartPolicyError);
      expect((e as Error).message).toContain("Preview");
    }
  });
});

describe("cloud-run-instance-client request shapes", () => {
  const basePath = "https://run.googleapis.com/v2/projects/test-proj/locations/us-central1";
  const IMAGE = "us-docker.pkg.dev/test-proj/agent-host/agent-host:v1";

  test("toApiRestartPolicy maps to the v2 API enum", () => {
    expect(toApiRestartPolicy("on-failure")).toBe("ON_FAILURE");
    expect(toApiRestartPolicy("never")).toBe("NEVER");
    expect(toApiRestartPolicy("always")).toBe("ALWAYS");
  });

  test("create request shape matches v2 GoogleCloudRunV2Instance", async () => {
    const transport = new FakeTransport(async (req) => ({
      status: 200,
      body: { name: `${basePath}/instances/dsh-ws-123`, done: true, response: { name: `${basePath}/instances/dsh-ws-123`, terminalCondition: { state: "CONDITION_SUCCEEDED" }, urls: ["https://example.run.app"] } },
    }));
    const client = new CloudRunInstanceClient({
      transport,
      basePath,
      image: IMAGE,
      serviceAccount: "agent-host@test-proj.iam.gserviceaccount.com",
    });

    const info = await client.create({ id: "ws-123" });

    expect(info.name).toBe(`${basePath}/instances/dsh-ws-123`);
    expect(info.state).toBe("READY");
    expect(info.url).toBe("https://example.run.app");
    const req = transport.lastRequest()!;
    expect(req.method).toBe("POST");
    // v2 create: instance id is a QUERY param; body `name` is ignored by the API
    expect(req.url).toBe(`${basePath}/instances?instanceId=dsh-ws-123`);
    const body = req.body as Record<string, unknown>;
    expect(body["restartPolicy"]).toBe("ON_FAILURE");
    expect(body["serviceAccount"]).toBe("agent-host@test-proj.iam.gserviceaccount.com");
    const containers = body["containers"] as Array<Record<string, unknown>>;
    expect(containers).toHaveLength(1);
    expect(containers[0]!["image"]).toBe(IMAGE);
    const resources = containers[0]!["resources"] as Record<string, unknown>;
    const limits = resources["limits"] as Record<string, unknown>;
    expect(limits["cpu"]).toBe("4");
    expect(limits["memory"]).toBe("8Gi");
    expect(containers[0]!["sandboxLauncher"]).toBe(true);
    const ports = containers[0]!["ports"] as Array<Record<string, unknown>>;
    expect(ports[0]!["containerPort"]).toBe(8080);
    // no v1 leftovers
    expect(body["template"]).toBeUndefined();
    expect(body["workspaceId"]).toBeUndefined();
    expect(body["name"]).toBeUndefined();
    expect(body["resources"]).toBeUndefined();
    expect(body["containerPort"]).toBeUndefined();
  });

  test("create does not send readOnly fields", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: { done: false } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await client.create({ id: "ws-1" });
    const body = transport.lastRequest()!.body as Record<string, unknown>;
    const readOnly = [
      "createTime", "updateTime", "deleteTime", "expireTime", "etag", "generation",
      "observedGeneration", "uid", "creator", "lastModifier", "reconciling",
      "conditions", "terminalCondition", "containerStatuses", "urls", "logUri",
    ];
    for (const field of readOnly) expect(body[field]).toBeUndefined();
  });

  test("create appends validateOnly=true when requested", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: { done: false } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await client.create({ id: "ws-1" }, { validateOnly: true });
    expect(transport.lastRequest()!.url).toBe(
      `${basePath}/instances?instanceId=dsh-ws-1&validateOnly=true`,
    );
  });

  test("create without validateOnly never sets the query parameter", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: { done: false } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await client.create({ id: "ws-1" });
    expect(transport.lastRequest()!.url).toBe(`${basePath}/instances?instanceId=dsh-ws-1`);
  });

  test("create throws a typed error when no image is configured", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: {} }));
    const client = new CloudRunInstanceClient({ transport, basePath });
    await expect(client.create({ id: "ws-1" })).rejects.toBeInstanceOf(InstanceClientError);
    expect(transport.requests).toHaveLength(0);
  });

  test("create uses explicit instanceName in the instanceId query param", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: { done: false } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await client.create({ id: "ws-123", instanceName: "my-instance" });
    const req = transport.lastRequest()!;
    expect(req.url).toBe(`${basePath}/instances?instanceId=my-instance`);
    expect((req.body as Record<string, unknown>)["containers"]).toBeDefined();
  });

  test("create parses a pending v2 longrunning operation", async () => {
    const transport = new FakeTransport(async () => ({
      status: 200,
      body: { name: "https://run.googleapis.com/v2/projects/test-proj/locations/us-central1/operations/op-1", done: false },
    }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    const info = await client.create({ id: "ws-1" });
    expect(info.name).toBe(`${basePath}/instances/dsh-ws-1`);
    expect(info.state).toBe("PENDING");
  });

  test("create throws when the completed operation carries an error", async () => {
    const transport = new FakeTransport(async () => ({
      status: 200,
      body: { name: "https://run.googleapis.com/v2/projects/test-proj/locations/us-central1/operations/op-1", done: true, error: { code: 13, message: "internal boom" } },
    }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await expect(client.create({ id: "ws-1" })).rejects.toThrow("internal boom");
  });

  test("create falls back to parsing an instance body when the transport returns one", async () => {
    const transport = new FakeTransport(async () => ({
      status: 200,
      body: { name: "my-instance", state: "READY" },
    }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    const info = await client.create({ id: "ws-1" });
    expect(info.name).toBe("my-instance");
  });

  test("start request shape", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: {} }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await client.start("my-instance");
    const req = transport.lastRequest()!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${basePath}/instances/my-instance:start`);
  });

  test("stop request shape", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: {} }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await client.stop("my-instance");
    const req = transport.lastRequest()!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${basePath}/instances/my-instance:stop`);
  });

  test("get request shape", async () => {
    const transport = new FakeTransport(async () => ({
      status: 200,
      body: { name: "my-instance", state: "READY", url: "https://example.run.app" },
    }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    const info = await client.get("my-instance");
    expect(info.name).toBe("my-instance");
    expect(info.state).toBe("READY");
    const req = transport.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${basePath}/instances/my-instance`);
  });

  test("delete request shape", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: {} }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await client.delete("my-instance");
    const req = transport.lastRequest()!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(`${basePath}/instances/my-instance`);
  });

  test("all requests go through injected transport (no direct GCP SDK)", async () => {
    const transport = new FakeTransport(async () => ({
      status: 200,
      body: { name: "x", state: "READY" },
    }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await client.create({ id: "ws-1" });
    await client.get("x");
    await client.start("x");
    await client.stop("x");
    await client.delete("x");
    expect(transport.requests).toHaveLength(5);
  });
});

describe("cloud-run-instance-client v2 response parsing", () => {
  const basePath = "https://run.googleapis.com/v2/projects/test-proj/locations/us-central1";
  const IMAGE = "us-docker.pkg.dev/test-proj/agent-host/agent-host:v1";

  test("get derives READY from terminalCondition.state (v2 has no top-level state)", async () => {
    const transport = new FakeTransport(async () => ({
      status: 200,
      body: {
        name: `${basePath}/instances/my-instance`,
        terminalCondition: { type: "Ready", state: "CONDITION_SUCCEEDED" },
        urls: ["https://a.run.app", "https://b.run.app"],
      },
    }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    const info = await client.get("my-instance");
    expect(info.state).toBe("READY");
    expect(info.url).toBe("https://a.run.app");
  });

  test("get derives FAILED/PENDING from terminalCondition.state", async () => {
    const transport = new FakeTransport(async () => ({
      status: 200,
      body: { name: "x", terminalCondition: { state: "CONDITION_FAILED" } },
    }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    expect((await client.get("x")).state).toBe("FAILED");

    transport.setHandler(async () => ({
      status: 200,
      body: { name: "x", terminalCondition: { state: "CONDITION_RECONCILING" } },
    }));
    expect((await client.get("x")).state).toBe("PENDING");
  });

  test("get returns UNKNOWN when no state signal is present", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: { name: "x" } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    expect((await client.get("x")).state).toBe("UNKNOWN");
  });
});

describe("cloud-run-instance-client error mapping", () => {
  const basePath = "https://run.googleapis.com/v2/projects/test-proj/locations/us-central1";
  const IMAGE = "us-docker.pkg.dev/test-proj/agent-host/agent-host:v1";

  test("404 maps to InstanceNotFoundError", async () => {
    const transport = new FakeTransport(async () => ({ status: 404, body: { message: "not found" } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await expect(client.get("missing")).rejects.toBeInstanceOf(InstanceNotFoundError);
    await expect(client.start("missing")).rejects.toBeInstanceOf(InstanceNotFoundError);
    await expect(client.stop("missing")).rejects.toBeInstanceOf(InstanceNotFoundError);
    await expect(client.delete("missing")).rejects.toBeInstanceOf(InstanceNotFoundError);
  });

  test("409 maps to InstanceAlreadyExistsError", async () => {
    const transport = new FakeTransport(async () => ({ status: 409, body: { message: "already exists" } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await expect(client.create({ id: "ws-1" })).rejects.toBeInstanceOf(InstanceAlreadyExistsError);
  });

  test("create 409 error message reports the instance name, not the workspace id", async () => {
    const transport = new FakeTransport(async () => ({ status: 409, body: { message: "already exists" } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    const err = await client.create({ id: "ws-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceAlreadyExistsError);
    expect((err as Error).message).toContain("dsh-ws-1");
    expect((err as Error).message).not.toBe("instance already exists: ws-1");
  });

  test("create 409 error message reports an explicit instanceName when provided", async () => {
    const transport = new FakeTransport(async () => ({ status: 409, body: { message: "already exists" } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    const err = await client.create({ id: "ws-1", instanceName: "my-instance" }).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceAlreadyExistsError);
    expect((err as Error).message).toContain("my-instance");
    expect((err as Error).message).not.toContain("ws-1");
  });

  test("create 404 error message reports the instance name, not the workspace id", async () => {
    const transport = new FakeTransport(async () => ({ status: 404, body: {} }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    const err = await client.create({ id: "ws-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceNotFoundError);
    expect((err as Error).message).toContain("dsh-ws-1");
  });

  test("403 maps to PermissionDeniedError", async () => {
    const transport = new FakeTransport(async () => ({ status: 403, body: { message: "permission denied" } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await expect(client.get("x")).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("5xx maps to InstanceClientError", async () => {
    const transport = new FakeTransport(async () => ({ status: 500, body: { message: "internal" } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await expect(client.get("x")).rejects.toBeInstanceOf(InstanceClientError);
  });

  test("create 404 also maps correctly", async () => {
    const transport = new FakeTransport(async () => ({ status: 404, body: {} }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await expect(client.create({ id: "ws-1" })).rejects.toBeInstanceOf(InstanceNotFoundError);
  });
});

describe("cloud-run-instance-client container env", () => {
  const basePath = "https://run.googleapis.com/v2/projects/test-proj/locations/us-central1";
  const IMAGE = "us-docker.pkg.dev/test-proj/agent-host/agent-host:v1";

  function createBodyOf(req: { body?: unknown }): Record<string, unknown> {
    return req.body as Record<string, unknown>;
  }

  test("no env option -> containers[0] carries no env key", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: { done: false } }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await client.create({ id: "ws-1" });
    const containers = createBodyOf(transport.lastRequest()!)["containers"] as Array<
      Record<string, unknown>
    >;
    expect(containers[0]!["env"]).toBeUndefined();
  });

  test("env option is emitted as sorted {name, value} pairs on the container", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: { done: false } }));
    const client = new CloudRunInstanceClient({
      transport,
      basePath,
      image: IMAGE,
      env: {
        WORKSPACE_ID: "ws-1",
        CHECKPOINT_BUCKET: "bucket",
        DATABASE_URL: "postgresql://x",
      },
    });
    await client.create({ id: "ws-1" });
    const containers = createBodyOf(transport.lastRequest()!)["containers"] as Array<
      Record<string, unknown>
    >;
    expect(containers[0]!["env"]).toEqual([
      { name: "CHECKPOINT_BUCKET", value: "bucket" },
      { name: "DATABASE_URL", value: "postgresql://x" },
      { name: "WORKSPACE_ID", value: "ws-1" },
    ]);
  });
});

describe("cloud-run-instance-client basePath contract (issue #47)", () => {
  const IMAGE = "us-docker.pkg.dev/test-proj/agent-host/agent-host:v1";

  test("DEFAULT_INSTANCES_API_BASE_URL is the production v2 origin", () => {
    expect(DEFAULT_INSTANCES_API_BASE_URL).toBe("https://run.googleapis.com/v2");
  });

  test("buildInstancesBasePath assembles an absolute basePath", () => {
    expect(
      buildInstancesBasePath({
        apiBaseUrl: "https://run.googleapis.com/v2",
        projectId: "my-proj",
        region: "asia-northeast1",
      }),
    ).toBe("https://run.googleapis.com/v2/projects/my-proj/locations/asia-northeast1");
  });

  test("buildInstancesBasePath tolerates a trailing slash on the origin", () => {
    expect(
      buildInstancesBasePath({
        apiBaseUrl: "http://localhost:8080/v2/",
        projectId: "p",
        region: "r",
      }),
    ).toBe("http://localhost:8080/v2/projects/p/locations/r");
  });

  test("relative basePath is rejected in the constructor, before any request", () => {
    const t = new FakeTransport();
    expect(
      () =>
        new CloudRunInstanceClient({
          transport: t,
          basePath: "projects/p/locations/us-central1",
        }),
    ).toThrow(InvalidBasePathError);
    expect(t.requests).toHaveLength(0);
  });

  test("rejection message names the absolute-URL contract", () => {
    const t = new FakeTransport();
    try {
      new CloudRunInstanceClient({ transport: t, basePath: "projects/p/locations/r" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidBasePathError);
      expect((e as Error).message).toContain("https://run.googleapis.com/v2");
    }
  });

  test("empty and non-http(s) basePaths are rejected", () => {
    for (const bad of ["", "   ", "ftp://example.com/v2/projects/p/locations/r"]) {
      const t = new FakeTransport();
      expect(() => new CloudRunInstanceClient({ transport: t, basePath: bad })).toThrow(
        InvalidBasePathError,
      );
      expect(t.requests).toHaveLength(0);
    }
  });

  test("http:// emulator origins are accepted", async () => {
    const basePath = "http://localhost:8080/v2/projects/p/locations/r";
    const transport = new FakeTransport(async () => ({
      status: 200,
      body: { name: "x", state: "READY" },
    }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await client.get("x");
    expect(transport.lastRequest()!.url).toBe(`${basePath}/instances/x`);
  });

  test("absolute request URLs are fetchable (regression: relative URLs threw 'URL is invalid')", async () => {
    const basePath =
      "https://run.googleapis.com/v2/projects/test-proj/locations/us-central1";
    const transport = new FakeTransport(async () => ({
      status: 200,
      body: { name: "x", state: "READY" },
    }));
    const client = new CloudRunInstanceClient({ transport, basePath, image: IMAGE });
    await client.get("x");
    const url = transport.lastRequest()!.url;
    // Must survive the WHATWG URL parser that fetch() applies — the exact
    // failure mode of the relative basePath in #47.
    expect(() => new URL(url)).not.toThrow();
    expect(new URL(url).protocol).toBe("https:");
    expect(url).toBe(`${basePath}/instances/x`);
  });
});
