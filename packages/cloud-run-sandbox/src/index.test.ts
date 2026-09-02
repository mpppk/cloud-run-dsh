import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toSandboxId, isValidWorkspaceId } from "./sandboxId.js";
import { buildRunArgv, buildExecArgv, buildDeleteArgv } from "./argv.js";
import { DefaultSandboxManager } from "./manager.js";
import type { SandboxCliRunner, SandboxCliResult } from "./types.js";

class FakeRunner implements SandboxCliRunner {
  calls: readonly string[][] = [];
  private _calls: string[][] = [];
  results: SandboxCliResult[] = [];
  nextResult: SandboxCliResult = { exitCode: 0, stdout: "", stderr: "" };

  get recorded(): string[][] {
    return this._calls;
  }

  async run(argv: readonly string[], _opts?: unknown): Promise<SandboxCliResult> {
    this._calls.push([...argv]);
    if (this.results.length > 0) return this.results.shift()!;
    return this.nextResult;
  }
}

describe("cloud-run-sandbox", () => {
  describe("sandboxId derivation", () => {
    test("derives dsh- prefix in one place", () => {
      expect(toSandboxId("abc123")).toBe("dsh-abc123");
      expect(toSandboxId("workspace-1")).toBe("dsh-workspace-1");
    });

    test("validates workspaceId", () => {
      expect(() => toSandboxId("")).toThrow();
      expect(() => toSandboxId("has space")).toThrow();
      expect(() => toSandboxId("has;semicolon")).toThrow();
      expect(() => toSandboxId("has/slash")).toThrow();
      expect(isValidWorkspaceId("valid_id-123")).toBe(true);
      expect(isValidWorkspaceId("")).toBe(false);
      expect(isValidWorkspaceId("bad id")).toBe(false);
    });

    test("validation prevents injection-like ids", () => {
      expect(() => toSandboxId("$(rm -rf /)")).toThrow();
      expect(() => toSandboxId("a`b`")).toThrow();
    });
  });

  describe("argv builders — pure and structured", () => {
    test("buildRunArgv matches spec", () => {
      const argv = buildRunArgv("dsh-ws1");
      expect(argv).toEqual([
        "sandbox",
        "run",
        "dsh-ws1",
        "--detach",
        "--allow-egress",
        "--write",
        "--mount",
        "type=bind,source=/workspace,destination=/workspace",
        "--workdir",
        "/workspace",
        "--",
        "/bin/sh",
        "-c",
        "while true; do sleep 3600; done",
      ]);
    });

    test("buildExecArgv structured — command + args stay separate", () => {
      const argv = buildExecArgv("dsh-ws1", {
        cwd: "/workspace",
        env: { CI: "true", NODE_ENV: "test" },
        command: "npm",
        args: ["run", "test"],
      });
      expect(argv).toEqual([
        "sandbox",
        "exec",
        "dsh-ws1",
        "--workdir",
        "/workspace",
        "--env",
        "CI=true",
        "--env",
        "NODE_ENV=test",
        "--",
        "npm",
        "run",
        "test",
      ]);
    });

    test("buildDeleteArgv", () => {
      expect(buildDeleteArgv("dsh-ws1")).toEqual(["sandbox", "delete", "dsh-ws1"]);
    });

    test("arguments containing spaces/quotes/;/$() survive verbatim", () => {
      const trickyArgs = [
        "hello world",
        `a"b'c`,
        "semi;colon",
        "$(whoami)",
        "`backtick`",
        "a&b",
        "x|y",
        "d$var",
        "a && b",
        "line1\nline2",
        "a; rm -rf /",
        `he said "hi" and 'bye'`,
      ];
      const argv = buildExecArgv("dsh-ws1", {
        cwd: "/workspace",
        command: "echo",
        args: trickyArgs,
      });
      // The argv array must contain each tricky arg as a single element after "--"
      const sepIdx = argv.indexOf("--");
      const payload = argv.slice(sepIdx + 1);
      expect(payload[0]).toBe("echo");
      expect(payload.slice(1)).toEqual(trickyArgs);

      // Each tricky arg stays a SINGLE argv element — no joining occurred
      for (const arg of trickyArgs) {
        expect(payload).toContain(arg);
      }
      expect(payload.length).toBe(trickyArgs.length + 1);

      // Ensure no shell string was built: joining would collapse spaces and change semantics
      const joined = payload.join(" ");
      expect(joined).not.toBe(payload.join("\x00"));
    });

    test("never uses argv.join(' ') for user command construction", () => {
      // Read source to ensure no .join(" ") on user argv
      const src = readFileSync(join(import.meta.dir, "argv.ts"), "utf-8");
      // The file should not contain a pattern that joins user command into a shell string
      // Allow joining only if not related to user command? We assert file does not contain `join(" ")` at all for safety
      // (builders return structured arrays, never join)
      expect(src.includes('join(" ")')).toBe(false);
      expect(src.includes("join(' ')")).toBe(false);
      expect(src.includes("join(` `)")).toBe(false);
    });

    test("env values with spaces/special chars survive as single argv element", () => {
      const argv = buildExecArgv("dsh-ws1", {
        cwd: "/workspace",
        env: { MY_VAR: "hello world; rm -rf /", MULTI_LINE: "line1\nline2" },
        command: "env",
        args: [],
      });
      // Find --env entries
      const firstIdx = argv.indexOf("--env");
      expect(argv[firstIdx + 1]).toBe("MY_VAR=hello world; rm -rf /");
      const secondIdx = argv.indexOf("--env", firstIdx + 1);
      expect(argv[secondIdx + 1]).toBe("MULTI_LINE=line1\nline2");
      // Each env value stays a SINGLE argv element — the newline did not split it
      expect(argv.filter((a) => a === "--env")).toHaveLength(2);
    });
  });

  describe("SandboxManager with fake runner (no real gcloud)", () => {
    test("ensureRunning calls sandbox run", async () => {
      const runner = new FakeRunner();
      const mgr = new DefaultSandboxManager({ workspaceId: "ws1", runner });
      await mgr.ensureRunning();
      expect(runner.recorded[0]).toEqual(buildRunArgv("dsh-ws1"));
    });

    test("exposes workspaceId (used for cross-instance coordination)", () => {
      const mgr = new DefaultSandboxManager({ workspaceId: "ws1", runner: new FakeRunner() });
      expect(mgr.getWorkspaceId()).toBe("ws1");
    });

    test("exec throws when cwd is missing — no silent /workspace default", () => {
      const runner = new FakeRunner();
      const mgr = new DefaultSandboxManager({ workspaceId: "ws1", runner });
      expect(() => mgr.exec({ command: "echo", args: ["hi"], cwd: "" })).toThrow("cwd required");
      expect(() =>
        mgr.exec({ command: "echo", args: ["hi"], cwd: undefined as unknown as string }),
      ).toThrow("cwd required");
      // Nothing was run against the CLI
      expect(runner.recorded.length).toBe(0);
    });

    test("exec enforces the env allowlist — forbidden vars dropped via manager path too (spec 26 item 6)", async () => {
      const runner = new FakeRunner();
      runner.nextResult = { exitCode: 0, stdout: "", stderr: "" };
      const mgr = new DefaultSandboxManager({ workspaceId: "ws1", runner });
      const handle = mgr.exec({
        command: "env",
        args: [],
        cwd: "/workspace",
        env: {
          CI: "1",
          NODE_ENV: "test",
          LLM_API_KEY: "sk-secret",
          DATABASE_URL: "postgres://host/db",
          GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
        },
      });
      await handle.result;
      const argv = runner.recorded[0]!;
      expect(argv).toContain("CI=1");
      expect(argv).toContain("NODE_ENV=test");
      for (const key of ["LLM_API_KEY", "DATABASE_URL", "GITHUB_APP_PRIVATE_KEY"]) {
        expect(argv.some((a) => a.startsWith(`${key}=`))).toBe(false);
        expect(argv.some((a) => a.includes(key))).toBe(false);
      }
    });

    test("exec builds structured argv and returns handle", async () => {
      const runner = new FakeRunner();
      runner.nextResult = { exitCode: 0, stdout: "hi\n", stderr: "" };
      const mgr = new DefaultSandboxManager({ workspaceId: "ws1", runner });
      const handle = mgr.exec({ command: "echo", args: ["hello world"], cwd: "/workspace" });
      const res = await handle.result;
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe("hi\n");
      const execArgv = runner.recorded[0]!;
      expect(execArgv).toContain("echo");
      expect(execArgv).toContain("hello world");
      // Ensure hello world is a single argv element, not split
      const sep = execArgv.indexOf("--");
      const after = execArgv.slice(sep + 1);
      expect(after).toEqual(["echo", "hello world"]);
    });

    test("reset = delete then recreate with /workspace bind mount", async () => {
      const runner = new FakeRunner();
      const mgr = new DefaultSandboxManager({ workspaceId: "ws1", runner });
      await mgr.reset();
      expect(runner.recorded.length).toBe(2);
      expect(runner.recorded[0]).toEqual(buildDeleteArgv("dsh-ws1"));
      expect(runner.recorded[1]).toEqual(buildRunArgv("dsh-ws1"));
      // Ensure recreate still has bind mount
      expect(runner.recorded[1]).toContain("type=bind,source=/workspace,destination=/workspace");
    });

    test("dispose calls delete", async () => {
      const runner = new FakeRunner();
      const mgr = new DefaultSandboxManager({ workspaceId: "ws1", runner });
      await mgr.dispose();
      expect(runner.recorded[0]).toEqual(buildDeleteArgv("dsh-ws1"));
    });

    test("all CLI-shape knowledge lives only in this package (adapter)", () => {
      // Ensure manager delegates to argv builders — no raw string building
      const src = readFileSync(join(import.meta.dir, "manager.ts"), "utf-8");
      expect(src.includes("buildRunArgv")).toBe(true);
      expect(src.includes("buildDeleteArgv")).toBe(true);
      expect(src.includes("buildExecArgv")).toBe(true);
      // Manager should not hardcode "sandbox run" string directly
      const lines = src.split("\n");
      const hardCoded = lines.filter((l) => l.includes('"sandbox"') && !l.includes("build"));
      // Only imports/builders should reference sandbox CLI; manager itself uses builders
      // Allow import lines, but not direct ["sandbox", "run"] literals outside builder
      // This is a soft check — we already verified via builder usage
      expect(hardCoded.length).toBe(0);
    });
  });
});
