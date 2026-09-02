// Security tests — credential isolation (実装手順書 section 35, 仕様書
// sections 17, 18, 26 items 3-5). Driven by fakes at the host adapter
// boundaries.
//
// INTEGRATION NOTE: platform-level guarantees (Cloud Run Sandboxes never
// receive host env vars / secrets, and cannot reach the GCP metadata server)
// are marked with `test.skip("INTEGRATION: ...")`; the unit-level refusal
// assertions below always run.

import { describe, expect, test } from "bun:test";
import { createSandboxManager, filterEnv, FORBIDDEN_ENV_KEYS } from "../../packages/cloud-run-sandbox/src/index.js";
import {
  SandboxExecRefusedError,
  createGuardedSandboxManager,
} from "../../apps/agent-host/src/guard.js";
import { buildHostProcessEnv } from "../../apps/agent-host/src/adapters.js";
import {
  FAKE_INSTALLATION_TOKEN,
  FAKE_PRIVATE_KEY_PEM,
  FakeSandboxCliRunner,
  composeTestHost,
  seedWorkspace,
} from "../../apps/agent-host/src/fakes.js";

const HOST_ENV_WITH_SECRETS: Record<string, string> = {
  PATH: "/usr/bin",
  HOME: "/home/host",
  LLM_API_KEY: "sk-super-secret",
  DATABASE_URL: "postgres://user:pass@db/cloud",
  GITHUB_APP_PRIVATE_KEY_PEM: FAKE_PRIVATE_KEY_PEM,
  GOOGLE_APPLICATION_CREDENTIALS: "/secret/adc.json",
};

describe("SECURITY: host process env is never readable from the sandbox", () => {
  test("exec requests built from host env only ever carry the allowlist", () => {
    const runner = new FakeSandboxCliRunner();
    const manager = createGuardedSandboxManager(
      createSandboxManager({ workspaceId: "ws-1", runner }),
    );
    // A caller naively forwards the whole host env — the manager must strip it.
    const handle = manager.exec({
      command: "env",
      args: [],
      cwd: "/workspace",
      env: HOST_ENV_WITH_SECRETS,
    });
    void handle.result;

    const argv = runner.recorded[0]!.join(" ");
    for (const forbidden of FORBIDDEN_ENV_KEYS) {
      expect(argv.includes(`${forbidden}=`)).toBe(false);
    }
    expect(argv.includes("sk-super-secret")).toBe(false);
    expect(argv.includes("postgres://")).toBe(false);
  });

  test("filterEnv drops every forbidden key", () => {
    const filtered = filterEnv(HOST_ENV_WITH_SECRETS);
    for (const forbidden of FORBIDDEN_ENV_KEYS) {
      expect(filtered[forbidden]).toBeUndefined();
    }
  });

  test("host child processes (git / sandbox CLI) get an explicit env allowlist", () => {
    const env = buildHostProcessEnv(HOST_ENV_WITH_SECRETS);
    expect(env["LLM_API_KEY"]).toBeUndefined();
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["GITHUB_APP_PRIVATE_KEY_PEM"]).toBeUndefined();
    expect(env["GOOGLE_APPLICATION_CREDENTIALS"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });

  test.skip("INTEGRATION (requires live Cloud Run Sandbox): `env` inside the sandbox shows no host secrets", async () => {
    // Requires a real Cloud Run Sandbox: the platform does not inherit host env.
  });
});

describe("SECURITY: the GCP metadata server is unreachable", () => {
  test("sandbox exec guard refuses commands targeting the metadata server", () => {
    const manager = createGuardedSandboxManager(
      createSandboxManager({ workspaceId: "ws-1", runner: new FakeSandboxCliRunner() }),
    );
    expect(() =>
      manager.exec({
        command: "curl",
        args: ["-H", "Metadata-Flavor: Google", "http://169.254.169.254/computeMetadata/v1/token"],
        cwd: "/workspace",
      }),
    ).toThrow(SandboxExecRefusedError);
    expect(() =>
      manager.exec({
        command: "wget",
        args: ["http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/"],
        cwd: "/workspace",
      }),
    ).toThrow(SandboxExecRefusedError);
  });

  test.skip("INTEGRATION (requires live Cloud Run Sandbox): egress to 169.254.169.254 is blocked by the platform", async () => {
    // Requires a real Cloud Run Sandbox: sandboxes cannot reach the metadata server.
  });
});

describe("SECURITY: the GitHub App private key never reaches the sandbox or disk", () => {
  test("no private key or installation token appears in any sandbox-bound or persisted payload", async () => {
    const th = await composeTestHost();
    await seedWorkspace(th);
    await th.host.recover();

    const everything: string[] = [];
    // Sandbox CLI argv (commands, env, stdin never carry credentials).
    for (const argv of th.sandboxRunner.recorded) everything.push(argv.join(" "));
    // Host filesystem writes (checkpoint payloads, git config...).
    for (const write of th.fs.writes) everything.push(new TextDecoder().decode(write.data));
    // Model-facing filesystem payloads.
    for (const payload of th.host.harness.writtenPayloads()) {
      everything.push(new TextDecoder().decode(payload.data));
    }

    for (const text of everything) {
      expect(text.includes(FAKE_PRIVATE_KEY_PEM)).toBe(false);
      expect(text.includes("BEGIN PRIVATE KEY")).toBe(false);
      expect(text.includes(FAKE_INSTALLATION_TOKEN)).toBe(false);
    }
    // The token was discarded after bootstrap.
    expect(th.host.bootstrapper.isTokenDiscarded).toBe(true);
  });

  test("the harness adapter exposes no way to obtain the private key", async () => {
    const { createFakeHarnessComposition } = await import(
      "../../apps/agent-host/src/harness.js"
    );
    const harness = createFakeHarnessComposition("/workspace");
    // Static surface assertion: HarnessComposition only exposes the
    // filesystem / search / restoreSessions seams — no secret accessor.
    expect(Object.keys(harness).sort()).toEqual([
      "filesystem",
      "observationPolicy",
      "restoreSessions",
      "restoredSessions",
      "search",
      "writtenPayloads",
    ]);
  });
});
