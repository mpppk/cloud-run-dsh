// Security tests — filesystem refusals (実装手順書 section 35, 仕様書 section 26
// item 2). Driven by fakes at the host adapter boundaries.
//
// INTEGRATION NOTE: the live-Cloud Run Sandbox equivalents of these refusals
// (an actual sandboxed process failing to write outside the bind-mounted
// /workspace) are marked with `test.skip("INTEGRATION: ...")` below and
// require a real Cloud Run Instance + Sandbox environment.

import { describe, expect, test } from "bun:test";
import { createSandboxManager } from "../../packages/cloud-run-sandbox/src/index.js";
import {
  SandboxExecRefusedError,
  createGuardedSandboxManager,
} from "../../apps/agent-host/src/guard.js";
import {
  HarnessPathRefusedError,
  createFakeHarnessComposition,
} from "../../apps/agent-host/src/harness.js";
import { FakeSandboxCliRunner } from "../../apps/agent-host/src/fakes.js";

describe("SECURITY: model-driven writes outside /workspace are refused", () => {
  test("harness filesystem refuses write to /etc/test", async () => {
    const harness = createFakeHarnessComposition("/workspace");
    await expect(
      harness.filesystem.write("/etc/test", new TextEncoder().encode("pwned")),
    ).rejects.toThrow(HarnessPathRefusedError);
  });

  test("harness filesystem refuses traversal escapes", async () => {
    const harness = createFakeHarnessComposition("/workspace");
    await expect(
      harness.filesystem.write("../../etc/test", new TextEncoder().encode("pwned")),
    ).rejects.toThrow(HarnessPathRefusedError);
    await expect(
      harness.filesystem.write("/workspace/../../../etc/test", new Uint8Array(1)),
    ).rejects.toThrow(HarnessPathRefusedError);
  });

  test("sandbox exec guard refuses cwd outside /workspace", () => {
    const manager = createGuardedSandboxManager(
      createSandboxManager({ workspaceId: "ws-1", runner: new FakeSandboxCliRunner() }),
    );
    for (const cwd of ["/etc", "/tmp", "/workspace/../etc", "/workspace/../../etc/test"]) {
      expect(() => manager.exec({ command: "tee", args: ["/etc/test"], cwd })).toThrow(
        SandboxExecRefusedError,
      );
    }
  });

  test.skip("INTEGRATION (requires live Cloud Run Sandbox): a process inside the sandbox cannot write outside the bind-mounted /workspace", async () => {
    // Requires a real Cloud Run Instance with the sandbox launcher; the
    // unit-level refusal above is the host-boundary contract.
  });
});
