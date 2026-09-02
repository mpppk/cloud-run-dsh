import { describe, test, expect } from "bun:test";
import { createCheckpointBundle, serializeBundle, deserializeBundle } from "./bundle.js";
import type { GitRunner, Clock, FileSystem } from "./types.js";
import { extractUntrackedTar } from "./tar.js";

class FakeClock implements Clock {
  constructor(private date: Date) {}
  now() {
    return this.date;
  }
  nowMs() {
    return this.date.getTime();
  }
}

function makeGit(opts: { diff: string; lsFiles: string }): GitRunner {
  return {
    async run(args) {
      if (args[0] === "diff") return { stdout: opts.diff, stderr: "", exitCode: 0 };
      if (args[0] === "ls-files") return { stdout: opts.lsFiles, stderr: "", exitCode: 0 };
      throw new Error(`unexpected git args ${args.join(" ")}`);
    },
  };
}

function makeFs(files: Record<string, string>): FileSystem {
  return {
    async readFile(path: string) {
      const key = path.split("/").pop() ?? path;
      // path is workspaceDir/file; we map by file path suffix
      for (const [k, v] of Object.entries(files)) {
        if (path.endsWith(`/${k}`) || path === k) return new TextEncoder().encode(v);
      }
      throw new Error(`file not found: ${path}`);
    },
    async writeFile() {},
    async exists() {
      return true;
    },
    async unlink() {},
    async mkdir() {},
  };
}

describe("createCheckpointBundle", () => {
  test("creates patch.diff from git diff --binary HEAD", async () => {
    const git = makeGit({ diff: "diff --git a/foo.txt b/foo.txt\n", lsFiles: "" });
    const bundle = await createCheckpointBundle({
      workspaceDir: "/workspace",
      baseCommit: "abc123",
      git,
      fs: makeFs({}),
      clock: new FakeClock(new Date("2026-09-02T00:00:00Z")),
    });
    expect(bundle.patchDiff).toBe("diff --git a/foo.txt b/foo.txt\n");
    expect(bundle.manifest.version).toBe(1);
    expect(bundle.manifest.baseCommit).toBe("abc123");
    expect(bundle.manifest.patch).toBe("patch.diff");
    expect(bundle.manifest.untracked).toBe("untracked.tar");
    expect(bundle.manifest.createdAt).toBe("2026-09-02T00:00:00.000Z");
  });

  test("packs untracked files from git ls-files --others --exclude-standard", async () => {
    const git = makeGit({ diff: "", lsFiles: "newfile.txt\nanother.js\n" });
    const fs = makeFs({ "newfile.txt": "hello", "another.js": "world" });
    const bundle = await createCheckpointBundle({
      workspaceDir: "/workspace",
      baseCommit: "abc",
      git,
      fs,
      clock: new FakeClock(new Date("2026-09-02T00:00:00Z")),
    });
    expect(bundle.untrackedFiles).toEqual(["newfile.txt", "another.js"]);
    const entries = extractUntrackedTar(bundle.untrackedTar);
    expect(entries.map((e) => e.path).sort()).toEqual(["another.js", "newfile.txt"]);
    expect(new TextDecoder().decode(entries.find((e) => e.path === "newfile.txt")!.content)).toBe("hello");
  });

  test("excludes node_modules untracked file but includes normal untracked file", async () => {
    const git = makeGit({
      diff: "",
      lsFiles: "node_modules/foo/bar.js\nnormal.txt\n.node_modules_fake\n",
    });
    // Add .next, dist, build, coverage, .cache, .git cases
    const git2 = makeGit({
      diff: "",
      lsFiles: "node_modules/a.js\n.next/b.js\ndist/c.js\nbuild/d.js\ncoverage/e.js\n.cache/f.js\n.git/g.js\nkeep.txt\n",
    });
    const fs = makeFs({ "normal.txt": "ok", "keep.txt": "keep" });
    const bundle = await createCheckpointBundle({
      workspaceDir: "/workspace",
      baseCommit: "abc",
      git,
      fs,
      clock: new FakeClock(new Date("2026-09-02T00:00:00Z")),
    });
    expect(bundle.untrackedFiles).toEqual(["normal.txt", ".node_modules_fake"]);
    // node_modules file must be excluded: tar should not contain it
    const entries = extractUntrackedTar(bundle.untrackedTar);
    expect(entries.some((e) => e.path.startsWith("node_modules/"))).toBe(false);
    expect(entries.some((e) => e.path === "normal.txt")).toBe(true);

    // Test broader exclusions
    const bundle2 = await createCheckpointBundle({
      workspaceDir: "/workspace",
      baseCommit: "abc",
      git: git2,
      fs,
      clock: new FakeClock(new Date("2026-09-02T00:00:00Z")),
    });
    expect(bundle2.untrackedFiles).toEqual(["keep.txt"]);
    const entries2 = extractUntrackedTar(bundle2.untrackedTar);
    expect(entries2.map((e) => e.path)).toEqual(["keep.txt"]);
  });

  test("metadata.json manifest has required fields", async () => {
    const git = makeGit({ diff: "patch", lsFiles: "" });
    const bundle = await createCheckpointBundle({
      workspaceDir: "/ws",
      baseCommit: "deadbeef",
      git,
      fs: makeFs({}),
      clock: new FakeClock(new Date("2026-01-01T12:00:00Z")),
    });
    expect(bundle.manifest).toEqual({
      version: 1,
      baseCommit: "deadbeef",
      createdAt: "2026-01-01T12:00:00.000Z",
      patch: "patch.diff",
      untracked: "untracked.tar",
    });
  });

  test("serialize/deserialize round-trip with storage", async () => {
    const git = makeGit({ diff: "patch", lsFiles: "a.txt\n" });
    const fs = makeFs({ "a.txt": "content" });
    const bundle = await createCheckpointBundle({
      workspaceDir: "/ws",
      baseCommit: "abc",
      git,
      fs,
      clock: new FakeClock(new Date("2026-09-02T00:00:00Z")),
    });
    const bytes = serializeBundle(bundle);
    const restored = deserializeBundle(bytes);
    expect(restored.manifest).toEqual(bundle.manifest);
    expect(restored.patchDiff).toBe(bundle.patchDiff);
    expect(restored.untrackedFiles).toEqual(bundle.untrackedFiles);
    expect(restored.untrackedTar).toEqual(bundle.untrackedTar);
  });

  test("calls git diff --binary HEAD and git ls-files --others --exclude-standard", async () => {
    const calls: string[][] = [];
    const git: GitRunner = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[0] === "ls-files") return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    await createCheckpointBundle({
      workspaceDir: "/workspace",
      baseCommit: "abc",
      git,
      fs: makeFs({}),
      clock: new FakeClock(new Date("2026-09-02T00:00:00Z")),
    });
    expect(calls).toContainEqual(["diff", "--binary", "HEAD"]);
    expect(calls).toContainEqual(["ls-files", "--others", "--exclude-standard"]);
  });
});
