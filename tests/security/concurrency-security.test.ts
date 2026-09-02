// Security tests — concurrency & network isolation (実装手順書 section 35,
// 仕様書 sections 15, 26). Driven by fakes at the host adapter boundaries.
//
// INTEGRATION NOTE: the live-Cloud Run Sandbox network refusal (an actual
// egress-disabled sandbox failing DNS/connect) is marked with
// `test.skip("INTEGRATION: ...")`; the unit-level refusal assertion below
// always runs.

import { describe, expect, test } from "bun:test";
import { LeaseAlreadyHeldError, ControllerLeaseService } from "../../packages/controller-lease/src/index.js";
import { InMemoryLeaseStore } from "../../packages/controller-lease/src/testing.js";
import type { SandboxManager, SandboxExecRequest, SubprocessHandle, SandboxExecResult } from "../../packages/cloud-run-sandbox/src/index.js";
import { CloudRunSubprocessRuntime } from "../../packages/dsh-subprocess-cloud-run/src/index.js";
import { runArgvForPolicy } from "../../apps/agent-host/src/guard.js";
import { FakeClock } from "../../apps/agent-host/src/fakes.js";

describe("SECURITY: parallel controller acquisitions are refused", () => {
  test("only one controller can acquire the workspace lease", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock();
    const service = new ControllerLeaseService({ store, clock });

    const [first, second] = await Promise.allSettled([
      service.acquire("ws-1", "ctrl-1", "user-1"),
      service.acquire("ws-1", "ctrl-2", "user-1"),
    ]);

    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason).toBeInstanceOf(LeaseAlreadyHeldError);
  });
});

describe("SECURITY: concurrent subprocesses are refused / serialized", () => {
  test("the subprocess runtime serializes exec per workspace (one active subprocess)", async () => {
    let active = 0;
    let maxConcurrent = 0;
    const delayedManager: SandboxManager = {
      getWorkspaceId: () => "ws-1",
      ensureRunning: async () => {},
      exec: (request: SandboxExecRequest): SubprocessHandle => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        const result: Promise<SandboxExecResult> = new Promise((resolve) => {
          setTimeout(
            () => {
              active -= 1;
              resolve({ exitCode: 0, stdout: String(request.command), stderr: "", durationMs: 1 });
            },
            5,
          );
        });
        return { result };
      },
      reset: async () => {},
      dispose: async () => {},
    };

    const runtime = new CloudRunSubprocessRuntime({ manager: delayedManager });
    const [a, b] = await Promise.all([
      runtime.spawn({ command: "echo", args: ["one"], cwd: "/workspace" }),
      runtime.spawn({ command: "echo", args: ["two"], cwd: "/workspace" }),
    ]);
    expect(a.status).toBe("success");
    expect(b.status).toBe("success");
    // Two parallel spawns must never overlap inside the sandbox.
    expect(maxConcurrent).toBe(1);
  });
});

describe("SECURITY: network access while egress is disabled", () => {
  test("sandbox creation argv with egress disabled omits --allow-egress", () => {
    const argv = runArgvForPolicy("dsh-ws-1", false);
    expect(argv).not.toContain("--allow-egress");
    expect(argv[0]).toBe("sandbox");
  });

  test.skip("INTEGRATION (requires live Cloud Run Sandbox): curl inside an egress-disabled sandbox fails", async () => {
    // Requires a real Cloud Run Sandbox created WITHOUT --allow-egress:
    // DNS resolution and outbound connections are refused by the platform.
  });
});
