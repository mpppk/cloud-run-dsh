import { describe, test, expect } from "bun:test";
import {
  DEFAULT_INSTANCE_CONFIG,
  INSTANCE_PROFILES,
  AVAILABLE_PROFILES,
  configForProfile,
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
    const c = new CloudRunInstanceClient({ transport: t, basePath: "projects/p/locations/us-central1" });
    expect(c.getConfig()).toEqual(DEFAULT_INSTANCE_CONFIG);
  });

  test("client uses profile config", () => {
    const t = new FakeTransport();
    const c = new CloudRunInstanceClient({
      transport: t,
      basePath: "projects/p/locations/us-central1",
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
          basePath: "projects/p/locations/us-central1",
          config: { cpu: 4, memory: "8Gi", restartPolicy: "always", sandboxLauncher: true, port: 8080 },
        }),
    ).toThrow(InvalidRestartPolicyError);
  });

  test("error message cites spec section 23 Preview issue", () => {
    const t = new FakeTransport();
    try {
      new CloudRunInstanceClient({
        transport: t,
        basePath: "projects/p/locations/us-central1",
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
  const basePath = "projects/test-proj/locations/us-central1";

  test("create request shape", async () => {
    const transport = new FakeTransport(async (req) => ({
      status: 200,
      body: { name: "dsh-ws-1", state: "READY", url: "https://example.run.app" },
    }));
    const client = new CloudRunInstanceClient({ transport, basePath });

    const info = await client.create({ id: "ws-123" });

    expect(info.name).toBe("dsh-ws-1");
    const req = transport.lastRequest()!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${basePath}/instances`);
    const body = req.body as Record<string, unknown>;
    expect(body["workspaceId"]).toBe("ws-123");
    expect(body["name"]).toBe("dsh-ws-123");
    const resources = body["resources"] as Record<string, unknown>;
    expect(resources["cpu"]).toBe(4);
    expect(resources["memory"]).toBe("8Gi");
    expect(body["restartPolicy"]).toBe("on-failure");
    expect(body["sandboxLauncher"]).toBe(true);
    expect(body["containerPort"]).toBe(8080);
  });

  test("create uses explicit instanceName when provided", async () => {
    const transport = new FakeTransport(async () => ({
      status: 200,
      body: { name: "my-instance", state: "READY" },
    }));
    const client = new CloudRunInstanceClient({ transport, basePath });
    await client.create({ id: "ws-123", instanceName: "my-instance" });
    const body = transport.lastRequest()!.body as Record<string, unknown>;
    expect(body["name"]).toBe("my-instance");
  });

  test("start request shape", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: {} }));
    const client = new CloudRunInstanceClient({ transport, basePath });
    await client.start("my-instance");
    const req = transport.lastRequest()!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${basePath}/instances/my-instance:start`);
  });

  test("stop request shape", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: {} }));
    const client = new CloudRunInstanceClient({ transport, basePath });
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
    const client = new CloudRunInstanceClient({ transport, basePath });
    const info = await client.get("my-instance");
    expect(info.name).toBe("my-instance");
    expect(info.state).toBe("READY");
    const req = transport.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${basePath}/instances/my-instance`);
  });

  test("delete request shape", async () => {
    const transport = new FakeTransport(async () => ({ status: 200, body: {} }));
    const client = new CloudRunInstanceClient({ transport, basePath });
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
    const client = new CloudRunInstanceClient({ transport, basePath });
    await client.create({ id: "ws-1" });
    await client.get("x");
    await client.start("x");
    await client.stop("x");
    await client.delete("x");
    expect(transport.requests).toHaveLength(5);
  });
});

describe("cloud-run-instance-client error mapping", () => {
  const basePath = "projects/test-proj/locations/us-central1";

  test("404 maps to InstanceNotFoundError", async () => {
    const transport = new FakeTransport(async () => ({ status: 404, body: { message: "not found" } }));
    const client = new CloudRunInstanceClient({ transport, basePath });
    await expect(client.get("missing")).rejects.toBeInstanceOf(InstanceNotFoundError);
    await expect(client.start("missing")).rejects.toBeInstanceOf(InstanceNotFoundError);
    await expect(client.stop("missing")).rejects.toBeInstanceOf(InstanceNotFoundError);
    await expect(client.delete("missing")).rejects.toBeInstanceOf(InstanceNotFoundError);
  });

  test("409 maps to InstanceAlreadyExistsError", async () => {
    const transport = new FakeTransport(async () => ({ status: 409, body: { message: "already exists" } }));
    const client = new CloudRunInstanceClient({ transport, basePath });
    await expect(client.create({ id: "ws-1" })).rejects.toBeInstanceOf(InstanceAlreadyExistsError);
  });

  test("create 409 error message reports the instance name, not the workspace id", async () => {
    const transport = new FakeTransport(async () => ({ status: 409, body: { message: "already exists" } }));
    const client = new CloudRunInstanceClient({ transport, basePath });
    const err = await client.create({ id: "ws-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceAlreadyExistsError);
    expect((err as Error).message).toContain("dsh-ws-1");
    expect((err as Error).message).not.toBe("instance already exists: ws-1");
  });

  test("create 409 error message reports an explicit instanceName when provided", async () => {
    const transport = new FakeTransport(async () => ({ status: 409, body: { message: "already exists" } }));
    const client = new CloudRunInstanceClient({ transport, basePath });
    const err = await client.create({ id: "ws-1", instanceName: "my-instance" }).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceAlreadyExistsError);
    expect((err as Error).message).toContain("my-instance");
    expect((err as Error).message).not.toContain("ws-1");
  });

  test("create 404 error message reports the instance name, not the workspace id", async () => {
    const transport = new FakeTransport(async () => ({ status: 404, body: {} }));
    const client = new CloudRunInstanceClient({ transport, basePath });
    const err = await client.create({ id: "ws-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceNotFoundError);
    expect((err as Error).message).toContain("dsh-ws-1");
  });

  test("403 maps to PermissionDeniedError", async () => {
    const transport = new FakeTransport(async () => ({ status: 403, body: { message: "permission denied" } }));
    const client = new CloudRunInstanceClient({ transport, basePath });
    await expect(client.get("x")).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("5xx maps to InstanceClientError", async () => {
    const transport = new FakeTransport(async () => ({ status: 500, body: { message: "internal" } }));
    const client = new CloudRunInstanceClient({ transport, basePath });
    await expect(client.get("x")).rejects.toBeInstanceOf(InstanceClientError);
  });

  test("create 404 also maps correctly", async () => {
    const transport = new FakeTransport(async () => ({ status: 404, body: {} }));
    const client = new CloudRunInstanceClient({ transport, basePath });
    await expect(client.create({ id: "ws-1" })).rejects.toBeInstanceOf(InstanceNotFoundError);
  });
});
