import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterEnv, ALLOWED_ENV, FORBIDDEN_ENV_KEYS } from "./environment.js";
import { mapExitCode, TimeoutError, CancelledError, ExecutableNotFoundError } from "./errors.js";
import { redactSecrets, truncateOutput, OutputCollector, DEFAULT_MAX_OUTPUT_BYTES } from "./process.js";
import { validateCwd, toStructuredArgv } from "./argv.js";
import { resolveExecutable, CloudRunSubprocessRuntime } from "./runtime.js";
import { createCloudRunSubprocessPlugin } from "./plugin.js";
import type { SandboxManager } from "@cloud-run-dsh/cloud-run-sandbox";

// --- Fake SandboxManager for injection ---

class FakeManager implements SandboxManager {
  execCalls: Array<{ command: string; args: readonly string[]; cwd: string; env?: Record<string,string>; stdin?: unknown }> = [];
  resetCalls = 0;
  nextResult: { exitCode: number; stdout: string; stderr: string; durationMs: number } = {
    exitCode: 0, stdout: "", stderr: "", durationMs: 10,
  };
  // For hanging test: if set, exec will hang until resolveHang is called
  hang = false;
  private hangPromise: Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> | null = null;
  private hangResolve: ((v: any) => void) | null = null;

  async ensureRunning(): Promise<void> {}
  exec(request: { command: string; args: readonly string[]; cwd: string; env?: Record<string,string>; stdin?: any }) {
    this.execCalls.push({ ...request });
    if (this.hang) {
      if (!this.hangPromise) {
        this.hangPromise = new Promise((res) => { this.hangResolve = res; });
      }
      return { result: this.hangPromise };
    }
    const r = this.nextResult;
    return { result: Promise.resolve({ ...r }) };
  }
  resolveHang(result = { exitCode: 0, stdout: "ok", stderr: "", durationMs: 5 }) {
    if (this.hangResolve) this.hangResolve(result);
  }
  async reset(): Promise<void> { this.resetCalls++; }
  async dispose(): Promise<void> {}
}

// --- Tests ---

describe("dsh-subprocess-cloud-run", () => {
  describe("environment allowlist", () => {
    test("only allowed keys survive", () => {
      const input: Record<string,string> = {
        CI: "true",
        NODE_ENV: "production",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TERM: "xterm",
        LLM_API_KEY: "sk-secret",
        DATABASE_URL: "postgres://...",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
        GOOGLE_APPLICATION_CREDENTIALS: "/path/to/creds.json",
        HOME: "/root",
        PATH: "/usr/bin",
        RANDOM: "evil",
      };
      const out = filterEnv(input);
      expect(out).toEqual({
        CI: "true",
        NODE_ENV: "production",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TERM: "xterm",
      });
      for (const k of FORBIDDEN_ENV_KEYS) {
        expect(out[k]).toBeUndefined();
      }
    });

    test("FORBIDDEN keys are dropped even if present", () => {
      for (const key of FORBIDDEN_ENV_KEYS) {
        const out = filterEnv({ [key]: "secret-value", CI: "1" } as any);
        expect(out[key]).toBeUndefined();
        expect(out["CI"]).toBe("1");
      }
    });

    test("host process.env is never passed through wholesale", () => {
      // Simulate host env with many keys
      const hostEnv = { ...process.env, LLM_API_KEY: "sk-host-secret", DATABASE_URL: "postgres://host" } as any;
      const filtered = filterEnv(hostEnv);
      // Should only contain allowlist, not host secrets
      expect(filtered["LLM_API_KEY"]).toBeUndefined();
      expect(filtered["DATABASE_URL"]).toBeUndefined();
      // Ensure we didn't accidentally copy PATH or HOME
      expect(filtered["PATH"]).toBeUndefined();
      expect(filtered["HOME"]).toBeUndefined();
      // Source file must not read process.env wholesale
      const runtimeSrc = readFileSync(join(import.meta.dir, "runtime.ts"), "utf-8");
      expect(runtimeSrc.includes("process.env")).toBe(false);
      const envSrc = readFileSync(join(import.meta.dir, "environment.ts"), "utf-8");
      // environment.ts should not read process.env either
      expect(envSrc.includes("process.env")).toBe(false);
    });

    test("ALLOWED_ENV is exactly spec set", () => {
      expect([...ALLOWED_ENV].sort()).toEqual(["CI", "LANG", "LC_ALL", "NODE_ENV", "TERM"].sort());
    });
  });

  describe("argv — structured, never shell-joined", () => {
    test("toStructuredArgv keeps args verbatim", () => {
      const args = ["a b", 'c"d', "e;f", "$(g)", "`h`"];
      const argv = toStructuredArgv("echo", args);
      expect(argv).toEqual(["echo", "a b", 'c"d', "e;f", "$(g)", "`h`"]);
      // Ensure no join
      const src = readFileSync(join(import.meta.dir, "argv.ts"), "utf-8");
      expect(src.includes('join(" ")')).toBe(false);
    });

    test("validateCwd rejects relative or empty", () => {
      expect(() => validateCwd("")).toThrow();
      expect(() => validateCwd("relative/path")).toThrow();
      expect(validateCwd("/workspace")).toBe("/workspace");
      expect(validateCwd("/workspace/subdir")).toBe("/workspace/subdir");
    });
  });

  describe("errors — typed mapping", () => {
    test("mapExitCode", () => {
      expect(mapExitCode(0)).toEqual({ kind: "success", exitCode: 0 });
      expect(mapExitCode(1)).toEqual({ kind: "error", exitCode: 1 });
      expect(mapExitCode(127).kind).toBe("error");
    });

    test("TimeoutError and CancelledError are distinct", () => {
      expect(new TimeoutError() instanceof TimeoutError).toBe(true);
      expect(new CancelledError() instanceof CancelledError).toBe(true);
      expect(new TimeoutError().name).toBe("TimeoutError");
      expect(new CancelledError().name).toBe("CancelledError");
    });
  });

  describe("process — redaction, truncation, streaming", () => {
    test("redactSecrets replaces secret values", () => {
      const secrets = ["my-secret-token"];
      const input = "stdout contains my-secret-token and more";
      expect(redactSecrets(input, secrets)).toBe("stdout contains *** and more");
    });

    test("redactSecrets pattern-based (sk-, ghp_)", () => {
      const input = "key sk-12345678901234567890 and ghp_12345678901234567890 here";
      const out = redactSecrets(input);
      expect(out).not.toContain("sk-12345678901234567890");
      expect(out).not.toContain("ghp_12345678901234567890");
      expect(out).toContain("***");
    });

    test("truncateOutput limits bytes", () => {
      const big = "a".repeat(DEFAULT_MAX_OUTPUT_BYTES + 100);
      const out = truncateOutput(big);
      expect(out.length).toBeLessThan(big.length);
      expect(out).toContain("[truncated");
    });

    test("OutputCollector streaming callbacks", () => {
      const chunks: string[] = [];
      const collector = new OutputCollector({ onStdout: (c) => chunks.push(c) });
      collector.pushStdout("hello ");
      collector.pushStdout("world");
      expect(chunks).toEqual(["hello ", "world"]);
      const res = collector.finalize(0, 10, "success");
      expect(res.stdout).toBe("hello world");
    });

    test("process redaction is applied in finalize", () => {
      const collector = new OutputCollector({ secrets: ["s3cr3t"] });
      collector.pushStdout("output s3cr3t here");
      const res = collector.finalize(0, 5, "success");
      expect(res.stdout).toBe("output *** here");
    });
  });

  describe("resolveExecutable — inside sandbox, never host PATH", () => {
    test("runs command -v inside sandbox", async () => {
      const mgr = new FakeManager();
      mgr.nextResult = { exitCode: 0, stdout: "/usr/bin/node\n", stderr: "", durationMs: 5 };
      const p = await resolveExecutable("node", mgr as any);
      expect(p).toBe("/usr/bin/node");
      expect(mgr.execCalls[0].command).toBe("/bin/sh");
      expect(mgr.execCalls[0].args).toContain("command -v -- \"$1\"");
      expect(mgr.execCalls[0].args).toContain("node");
    });

    test("throws ExecutableNotFoundError when not found", async () => {
      const mgr = new FakeManager();
      mgr.nextResult = { exitCode: 1, stdout: "", stderr: "", durationMs: 5 };
      await expect(resolveExecutable("nonexistent", mgr as any)).rejects.toBeInstanceOf(ExecutableNotFoundError);
    });

    test("never resolves against host PATH (source check)", () => {
      const src = readFileSync(join(import.meta.dir, "runtime.ts"), "utf-8");
      // Should call manager.exec with command -v, not process.env.PATH or which on host
      expect(src.includes("command -v")).toBe(true);
      // Ensure no host PATH lookup like `process.env.PATH` or `which` on host
      expect(src.includes("process.env.PATH")).toBe(false);
    });
  });

  describe("spawn — cwd, env, stdin, streamed stdout/stderr, exit code, duration, AbortSignal, timeout", () => {
    test("spawn forwards filtered env and cwd", async () => {
      const mgr = new FakeManager();
      mgr.nextResult = { exitCode: 0, stdout: "hello", stderr: "", durationMs: 7 };
      const rt = new CloudRunSubprocessRuntime({ manager: mgr as any });
      const res = await rt.spawn({
        command: "echo",
        args: ["hi"],
        cwd: "/workspace",
        env: { CI: "true", LLM_API_KEY: "should-be-dropped", NODE_ENV: "test" } as any,
      });
      expect(res.status).toBe("success");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe("hello");
      expect(mgr.execCalls[0].env).toEqual({ CI: "true", NODE_ENV: "test" });
      expect(mgr.execCalls[0].env).not.toHaveProperty("LLM_API_KEY");
      expect(mgr.execCalls[0].cwd).toBe("/workspace");
    });

    test("spawn supports stdin and reports duration", async () => {
      const mgr = new FakeManager();
      mgr.nextResult = { exitCode: 0, stdout: "echo input", stderr: "", durationMs: 12 };
      const rt = new CloudRunSubprocessRuntime({ manager: mgr as any });
      const res = await rt.spawn({
        command: "cat",
        args: [],
        cwd: "/workspace",
        stdin: "input data",
      });
      expect(mgr.execCalls[0].stdin).toBe("input data");
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("spawn streams stdout/stderr via collector callbacks", async () => {
      const mgr = new FakeManager();
      mgr.nextResult = { exitCode: 0, stdout: "out", stderr: "err", durationMs: 5 };
      const rt = new CloudRunSubprocessRuntime({ manager: mgr as any });
      const onStdout: string[] = [];
      const onStderr: string[] = [];
      await rt.spawn({
        command: "echo",
        args: ["hi"],
        cwd: "/workspace",
        onStdout: (c) => onStdout.push(c),
        onStderr: (c) => onStderr.push(c),
      });
      expect(onStdout).toEqual(["out"]);
      expect(onStderr).toEqual(["err"]);
    });

    test("spawn handles non-zero exit code", async () => {
      const mgr = new FakeManager();
      mgr.nextResult = { exitCode: 2, stdout: "", stderr: "fail", durationMs: 5 };
      const rt = new CloudRunSubprocessRuntime({ manager: mgr as any });
      const res = await rt.spawn({ command: "false", args: [], cwd: "/workspace" });
      expect(res.status).toBe("error");
      expect(res.exitCode).toBe(2);
    });
  });

  describe("per-workspace mutex — serializes commands", () => {
    test("only one active subprocess at a time (queue)", async () => {
      const mgr = new FakeManager();
      // Make exec hang for first call, then resolve after we check queue
      mgr.hang = true;
      const rt = new CloudRunSubprocessRuntime({ manager: mgr as any });

      const p1 = rt.spawn({ command: "sleep", args: ["1"], cwd: "/workspace" });
      // Give event loop tick to ensure first spawn acquired mutex and called exec
      await new Promise((r) => setTimeout(r, 10));
      expect(mgr.execCalls.length).toBe(1);

      const p2 = rt.spawn({ command: "echo", args: ["second"], cwd: "/workspace" });
      await new Promise((r) => setTimeout(r, 10));
      // Second should not have started yet because mutex serializes
      expect(mgr.execCalls.length).toBe(1);

      // Resolve first hang
      (mgr as any).resolveHang({ exitCode: 0, stdout: "done1", stderr: "", durationMs: 10 });
      const r1 = await p1;
      expect(r1.stdout).toContain("done1");

      // Now second should start. Need to un-hang for second as well? We still hang, but we can switch to not hang
      (mgr as any).hang = false;
      // The second spawn was waiting on mutex, but its exec was not yet called via hang promise path?
      // For this test we need to simulate second exec after first completes.
      // We set nextResult for second
      (mgr as any).nextResult = { exitCode: 0, stdout: "done2", stderr: "", durationMs: 5 };
      // Since hangPromise was reused, second call still hangs on same promise; we need to reset hangPromise
      (mgr as any).hangPromise = null;
      // Actually our FakeManager's hang logic reuses same promise for all calls while hang=true.
      // We toggled hang to false, so next exec will resolve immediately with nextResult.
      // But p2's exec hasn't happened yet because it was queued. After p1 finishes, p2 will call exec anew.
      // Wait a bit for queue to drain
      await new Promise((r) => setTimeout(r, 20));
      const r2 = await p2;
      expect(mgr.execCalls.length).toBe(2);
      expect(mgr.execCalls[1].command).toBe("echo");
    });
  });

  describe("timeout / cancel path: abort -> delete -> run -> TIMEOUT/CANCELLED", () => {
    test("timeout triggers reset and marks TIMEOUT", async () => {
      const mgr = new FakeManager();
      mgr.hang = true;
      const rt = new CloudRunSubprocessRuntime({ manager: mgr as any });
      const res = await rt.spawn({
        command: "sleep",
        args: ["10"],
        cwd: "/workspace",
        timeoutMs: 20,
      });
      expect(res.status).toBe("timeout");
      expect(res.exitCode).toBeNull();
      expect(mgr.resetCalls).toBe(1);
    });

    test("AbortSignal triggers reset and marks CANCELLED", async () => {
      const mgr = new FakeManager();
      mgr.hang = true;
      const rt = new CloudRunSubprocessRuntime({ manager: mgr as any });
      const ctrl = new AbortController();
      const p = rt.spawn({
        command: "sleep",
        args: ["10"],
        cwd: "/workspace",
        signal: ctrl.signal,
      });
      setTimeout(() => ctrl.abort(), 10);
      const res = await p;
      expect(res.status).toBe("cancelled");
      expect(mgr.resetCalls).toBe(1);
    });

    test("abort path with fake sandbox CLI deletes and recreates (reset = delete+run)", async () => {
      // Verify reset was called which conceptually is delete+run
      const mgr = new FakeManager();
      mgr.hang = true;
      const rt = new CloudRunSubprocessRuntime({ manager: mgr as any });
      const res = await rt.spawn({ command: "sleep", args: ["10"], cwd: "/workspace", timeoutMs: 5 });
      expect(res.status).toBe("timeout");
      // FakeManager.reset increments resetCalls — which in real impl would be delete+run
      expect(mgr.resetCalls).toBeGreaterThanOrEqual(1);
    });
  });

  describe("plugin", () => {
    test("createCloudRunSubprocessPlugin exposes resolveExecutable and spawn", async () => {
      const mgr = new FakeManager();
      mgr.nextResult = { exitCode: 0, stdout: "/bin/echo\n", stderr: "", durationMs: 5 };
      const plugin = createCloudRunSubprocessPlugin({ manager: mgr as any });
      expect(typeof plugin.resolveExecutable).toBe("function");
      expect(typeof plugin.spawn).toBe("function");
      const p = await plugin.resolveExecutable("echo");
      expect(p).toBe("/bin/echo");
    });
  });
});
