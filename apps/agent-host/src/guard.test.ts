import { describe, expect, test } from "bun:test";
import { createSandboxManager } from "@cloud-run-dsh/cloud-run-sandbox";
import { buildRunArgv } from "@cloud-run-dsh/cloud-run-sandbox";
import {
  SandboxExecRefusedError,
  createGuardedSandboxManager,
  runArgvForPolicy,
} from "./guard.js";
import { FakeSandboxCliRunner } from "./fakes.js";

describe("guarded sandbox manager", () => {
  test("passes valid exec requests through to the inner manager", () => {
    const runner = new FakeSandboxCliRunner();
    const manager = createGuardedSandboxManager(
      createSandboxManager({ workspaceId: "ws-1", runner }),
    );
    const handle = manager.exec({ command: "echo", args: ["hi"], cwd: "/workspace" });
    void handle.result;
    expect(runner.recorded.length).toBe(1);
    const argv = runner.recorded[0]!;
    expect(argv[0]).toBe("sandbox");
    expect(argv[1]).toBe("exec");
    expect(argv).toContain("echo");
  });

  test("refuses exec with cwd outside /workspace", () => {
    const manager = createGuardedSandboxManager(
      createSandboxManager({ workspaceId: "ws-1", runner: new FakeSandboxCliRunner() }),
    );
    expect(() =>
      manager.exec({ command: "ls", args: [], cwd: "/etc" }),
    ).toThrow(SandboxExecRefusedError);
    expect(() =>
      manager.exec({ command: "ls", args: [], cwd: "/workspace/../etc" }),
    ).toThrow(SandboxExecRefusedError);
  });

  test("refuses exec targeting the GCP metadata server", () => {
    const manager = createGuardedSandboxManager(
      createSandboxManager({ workspaceId: "ws-1", runner: new FakeSandboxCliRunner() }),
    );
    expect(() =>
      manager.exec({
        command: "curl",
        args: ["http://169.254.169.254/computeMetadata/v1/"],
        cwd: "/workspace",
      }),
    ).toThrow(SandboxExecRefusedError);
    expect(() =>
      manager.exec({
        command: "curl",
        args: ["http://metadata.google.internal/computeMetadata/v1/instance/"],
        cwd: "/workspace",
      }),
    ).toThrow(SandboxExecRefusedError);
  });

  test("delegates lifecycle operations", async () => {
    const runner = new FakeSandboxCliRunner();
    const manager = createGuardedSandboxManager(
      createSandboxManager({ workspaceId: "ws-1", runner }),
    );
    expect(manager.getWorkspaceId()).toBe("ws-1");
    await manager.ensureRunning();
    await manager.reset();
    await manager.dispose();
    expect(runner.recorded.map((argv) => argv[1])).toEqual(["run", "delete", "run", "delete"]);
  });
});

describe("runArgvForPolicy", () => {
  test("keeps --allow-egress when egress is enabled", () => {
    const argv = runArgvForPolicy("dsh-ws-1", true);
    expect(argv).toEqual(buildRunArgv("dsh-ws-1"));
    expect(argv).toContain("--allow-egress");
  });

  test("omits --allow-egress when egress is disabled", () => {
    const argv = runArgvForPolicy("dsh-ws-1", false);
    expect(argv).not.toContain("--allow-egress");
    expect(argv[0]).toBe("sandbox");
    expect(argv[1]).toBe("run");
  });
});
