import { describe, test, expect } from "bun:test";
import { isDirty } from "./dirty.js";
import type { GitRunner } from "./types.js";

function fakeGit(output: string, exitCode = 0): GitRunner {
  return {
    async run(args) {
      expect(args).toEqual(["status", "--porcelain"]);
      return { stdout: output, stderr: "", exitCode };
    },
  };
}

describe("dirty detection", () => {
  test("clean when porcelain empty", async () => {
    expect(await isDirty(fakeGit(""), "/workspace")).toBe(false);
    expect(await isDirty(fakeGit("\n"), "/workspace")).toBe(false);
    expect(await isDirty(fakeGit("   \n  "), "/workspace")).toBe(false);
  });

  test("dirty when porcelain non-empty", async () => {
    expect(await isDirty(fakeGit(" M src/index.ts\n"), "/workspace")).toBe(true);
    expect(await isDirty(fakeGit("?? newfile.txt\n"), "/workspace")).toBe(true);
  });

  test("throws when git fails", async () => {
    const git: GitRunner = {
      async run() {
        return { stdout: "", stderr: "fatal", exitCode: 1 };
      },
    };
    await expect(isDirty(git, "/workspace")).rejects.toThrow("git status failed");
  });

  test("uses git status --porcelain", async () => {
    let called = false;
    const git: GitRunner = {
      async run(args, opts) {
        expect(args).toEqual(["status", "--porcelain"]);
        expect(opts?.cwd).toBe("/my/workspace");
        called = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    await isDirty(git, "/my/workspace");
    expect(called).toBe(true);
  });
});
