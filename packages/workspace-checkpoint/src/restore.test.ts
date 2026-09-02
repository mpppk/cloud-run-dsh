import { describe, test, expect } from "bun:test";
import { restoreWorkspace, resolveWorkspaceEntryPath } from "./restore.js";
import { InMemoryCheckpointStorage } from "./storage.js";
import { createCheckpointBundle, serializeBundle } from "./bundle.js";
import { createUntrackedTar } from "./tar.js";
import { RestoreValidationError } from "./errors.js";
import type { CheckpointBundle } from "./types.js";
import type { GitRunner, FileSystem, Clock } from "./types.js";

class FakeClock implements Clock {
  now() {
    return new Date("2026-09-02T00:00:00Z");
  }
  nowMs() {
    return Date.now();
  }
}

function makeFs(
  initial: Record<string, Uint8Array> = {},
): FileSystem & { files: Map<string, Uint8Array>; unlinked: string[] } {
  const files = new Map(Object.entries(initial));
  const unlinked: string[] = [];
  return {
    files,
    unlinked,
    async readFile(path: string) {
      const v = files.get(path);
      if (!v) throw new Error(`not found ${path}`);
      return v;
    },
    async writeFile(path: string, data: Uint8Array) {
      files.set(path, new Uint8Array(data));
    },
    async exists(path: string) {
      return files.has(path);
    },
    async unlink(path: string) {
      unlinked.push(path);
      files.delete(path);
    },
  };
}

function makeRestoreGit(statusOutput: string, opts?: { applyExitCode?: number }): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args, _opts) {
      calls.push([...args]);
      if (args[0] === "clone") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "checkout") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "apply") return { stdout: "", stderr: "", exitCode: opts?.applyExitCode ?? 0 };
      if (args[0] === "status") return { stdout: statusOutput, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

function bundleGit(diffOut = "", lsOut = ""): GitRunner {
  return {
    async run(args) {
      if (args[0] === "diff") return { stdout: diffOut, stderr: "", exitCode: 0 };
      if (args[0] === "ls-files") return { stdout: lsOut, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

/** Hand-build a stored bundle (for hostile/corrupted payloads). */
function storeRawBundle(storage: InMemoryCheckpointStorage, key: string, bundle: Partial<CheckpointBundle>): void {
  const full: CheckpointBundle = {
    manifest: {
      version: 1,
      baseCommit: "abc123",
      createdAt: "2026-09-02T00:00:00.000Z",
      patch: "patch.diff",
      untracked: "untracked.tar",
    },
    patchDiff: "",
    untrackedFiles: [],
    untrackedTar: createUntrackedTar([]),
    ...bundle,
  };
  storage.put(key, serializeBundle(full));
}

describe("restoreWorkspace", () => {
  test("clone -> checkout -> download -> git apply --binary -> extract untracked -> validate", async () => {
    const storage = new InMemoryCheckpointStorage();
    const workspaceDir = "/workspace";
    const baseCommit = "abc123";
    const repoUrl = "https://github.com/org/repo.git";

    // Create a bundle to store
    const gitForBundle: GitRunner = {
      async run(args) {
        if (args[0] === "diff") return { stdout: "patch content", stderr: "", exitCode: 0 };
        if (args[0] === "ls-files") return { stdout: "new.txt\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const fsForBundle = makeFs({ "/workspace/new.txt": new TextEncoder().encode("new file content") });
    const bundle = await createCheckpointBundle({
      workspaceDir,
      baseCommit,
      git: gitForBundle,
      fs: fsForBundle,
      clock: new FakeClock(),
    });
    await storage.put("chk-1", serializeBundle(bundle));

    // Mock git for restore
    const git = makeRestoreGit(" M modified.txt\n?? new.txt\n");
    const fs = makeFs();

    await restoreWorkspace({
      workspaceDir,
      repoUrl,
      baseCommit,
      checkpointKey: "chk-1",
      storage,
      git,
      fs,
      tmpDir: "/tmp-fake",
    });

    expect(git.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["clone", "checkout", "apply", "status"]));
    // checkout must target the manifest base commit
    expect(git.calls.find((c) => c[0] === "checkout")).toEqual(["checkout", "abc123"]);
    // Verify untracked file was extracted
    expect(await fs.exists("/workspace/new.txt")).toBe(true);
    // Patch temp file lived outside the workspace and was removed
    const applyCall = git.calls.find((c) => c[0] === "apply")!;
    expect(applyCall[2].startsWith("/tmp-fake/")).toBe(true);
    expect(applyCall[2].startsWith("/workspace")).toBe(false);
    expect(fs.unlinked).toEqual([applyCall[2]]);
    for (const key of fs.files.keys()) {
      expect(key.startsWith("/workspace/")).toBe(true);
      expect(key.includes("workspace-checkpoint-patch-")).toBe(false);
    }
  });

  test("MAJOR-2: no temp patch artifact remains in workspace after failure path", async () => {
    const storage = new InMemoryCheckpointStorage();
    storeRawBundle(storage, "chk", { patchDiff: "broken patch content", untrackedFiles: [] });
    const git = makeRestoreGit("", { applyExitCode: 1 });
    const fs = makeFs();
    await expect(
      restoreWorkspace({
        workspaceDir: "/workspace",
        checkpointKey: "chk",
        storage,
        git,
        fs,
        tmpDir: "/tmp-fake",
      }),
    ).rejects.toThrow("git apply failed");
    // The temp file was cleaned up even though apply failed
    expect(fs.unlinked.length).toBe(1);
    expect(fs.unlinked[0].startsWith("/tmp-fake/")).toBe(true);
    expect(fs.unlinked[0].startsWith("/workspace")).toBe(false);
    // No artifact written into the workspace at all
    for (const key of fs.files.keys()) {
      expect(key.startsWith("/workspace/")).toBe(true);
      expect(key.includes("workspace-checkpoint-patch-")).toBe(false);
    }
  });

  test("MAJOR-3: rejects traversal entry ../ESCAPED.txt without writing outside workspace", async () => {
    const storage = new InMemoryCheckpointStorage();
    storeRawBundle(storage, "chk-evil", {
      untrackedTar: createUntrackedTar([{ path: "../ESCAPED.txt", content: new TextEncoder().encode("evil") }]),
    });
    const git = makeRestoreGit("");
    const fs = makeFs();
    await expect(
      restoreWorkspace({ workspaceDir: "/workspace", checkpointKey: "chk-evil", storage, git, fs, tmpDir: "/tmp-fake" }),
    ).rejects.toBeInstanceOf(RestoreValidationError);
    // nothing written anywhere (in or out of workspace)
    expect(fs.files.size).toBe(0);
  });

  test("MAJOR-3: rejects absolute entry /etc/passwd", async () => {
    const storage = new InMemoryCheckpointStorage();
    storeRawBundle(storage, "chk-evil2", {
      untrackedTar: createUntrackedTar([{ path: "/etc/passwd", content: new TextEncoder().encode("evil") }]),
    });
    const git = makeRestoreGit("");
    const fs = makeFs();
    await expect(
      restoreWorkspace({ workspaceDir: "/workspace", checkpointKey: "chk-evil2", storage, git, fs, tmpDir: "/tmp-fake" }),
    ).rejects.toBeInstanceOf(RestoreValidationError);
    expect(fs.files.size).toBe(0);
  });

  test("MAJOR-3: rejects sneaky entry a/../../b", async () => {
    const storage = new InMemoryCheckpointStorage();
    storeRawBundle(storage, "chk-evil3", {
      untrackedTar: createUntrackedTar([{ path: "a/../../b", content: new TextEncoder().encode("evil") }]),
    });
    const git = makeRestoreGit("");
    const fs = makeFs();
    await expect(
      restoreWorkspace({ workspaceDir: "/workspace", checkpointKey: "chk-evil3", storage, git, fs, tmpDir: "/tmp-fake" }),
    ).rejects.toBeInstanceOf(RestoreValidationError);
    expect(fs.files.size).toBe(0);
  });

  test("MAJOR-3: legit nested untracked entries still land inside the workspace", async () => {
    const storage = new InMemoryCheckpointStorage();
    storeRawBundle(storage, "chk-ok", {
      untrackedTar: createUntrackedTar([
        { path: "sub/dir/notes.txt", content: new TextEncoder().encode("ok") },
      ]),
      untrackedFiles: ["sub/dir/notes.txt"],
    });
    const git = makeRestoreGit("?? sub/dir/notes.txt\n");
    const fs = makeFs();
    await restoreWorkspace({ workspaceDir: "/workspace", checkpointKey: "chk-ok", storage, git, fs, tmpDir: "/tmp-fake" });
    expect(fs.files.has("/workspace/sub/dir/notes.txt")).toBe(true);
  });

  test("MAJOR-4: baseCommit omitted -> checks out bundle.manifest.baseCommit", async () => {
    const storage = new InMemoryCheckpointStorage();
    storeRawBundle(storage, "chk-nobase", {});
    const git = makeRestoreGit("");
    const fs = makeFs();
    await restoreWorkspace({
      workspaceDir: "/workspace",
      checkpointKey: "chk-nobase",
      storage,
      git,
      fs,
      tmpDir: "/tmp-fake",
    });
    expect(git.calls.find((c) => c[0] === "checkout")).toEqual(["checkout", "abc123"]);
  });

  test("MAJOR-4: explicit baseCommit mismatch fails hard with typed error before checkout", async () => {
    const storage = new InMemoryCheckpointStorage();
    storeRawBundle(storage, "chk-mismatch", {});
    const git = makeRestoreGit("");
    const fs = makeFs();
    let err: unknown = null;
    try {
      await restoreWorkspace({
        workspaceDir: "/workspace",
        baseCommit: "def456",
        checkpointKey: "chk-mismatch",
        storage,
        git,
        fs,
        tmpDir: "/tmp-fake",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RestoreValidationError);
    expect((err as RestoreValidationError).message).toContain("does not match bundle manifest baseCommit");
    // fail hard: no checkout/apply/status attempted
    expect(git.calls.length).toBe(0);
  });

  test("MINOR-9: extra untracked file in git status not present in manifest fails validation", async () => {
    const storage = new InMemoryCheckpointStorage();
    storeRawBundle(storage, "chk-extra", {
      untrackedTar: createUntrackedTar([{ path: "known.txt", content: new TextEncoder().encode("x") }]),
      untrackedFiles: ["known.txt"],
    });
    // status shows an extra untracked file that the manifest never had
    const git = makeRestoreGit("?? known.txt\n?? rogue.txt\n");
    const fs = makeFs({ "/workspace/known.txt": new TextEncoder().encode("x") });
    await expect(
      restoreWorkspace({ workspaceDir: "/workspace", checkpointKey: "chk-extra", storage, git, fs, tmpDir: "/tmp-fake" }),
    ).rejects.toBeInstanceOf(RestoreValidationError);
  });

  test("MINOR-9: untracked file in manifest missing from git status fails validation", async () => {
    const storage = new InMemoryCheckpointStorage();
    storeRawBundle(storage, "chk-missing-status", {
      untrackedTar: createUntrackedTar([{ path: "known.txt", content: new TextEncoder().encode("x") }]),
      untrackedFiles: ["known.txt"],
    });
    const git = makeRestoreGit("");
    const fs = makeFs();
    await expect(
      restoreWorkspace({
        workspaceDir: "/workspace",
        checkpointKey: "chk-missing-status",
        storage,
        git,
        fs,
        tmpDir: "/tmp-fake",
      }),
    ).rejects.toBeInstanceOf(RestoreValidationError);
  });

  test("validation fails -> throws RestoreValidationError and caller must NOT reach READY", async () => {
    const storage = new InMemoryCheckpointStorage();
    const workspaceDir = "/workspace";
    // Bundle says dirty but git status after restore is clean
    const gitForBundle: GitRunner = {
      async run(args) {
        if (args[0] === "diff") return { stdout: "patch", stderr: "", exitCode: 0 };
        if (args[0] === "ls-files") return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const bundle = await createCheckpointBundle({
      workspaceDir,
      baseCommit: "abc",
      git: gitForBundle,
      fs: makeFs({}),
      clock: new FakeClock(),
    });
    await storage.put("chk", serializeBundle(bundle));

    const git = makeRestoreGit(""); // clean, but bundle had patch
    const fs = makeFs();
    let reachedReady = false;
    try {
      await restoreWorkspace({ workspaceDir, checkpointKey: "chk", storage, git, fs });
      reachedReady = true;
    } catch (e) {
      expect(e).toBeInstanceOf(RestoreValidationError);
      expect((e as RestoreValidationError).name).toBe("RestoreValidationError");
      reachedReady = false;
    }
    expect(reachedReady).toBe(false);
  });

  test("validation fails when clean expected but status dirty", async () => {
    const storage = new InMemoryCheckpointStorage();
    const gitForBundle: GitRunner = {
      async run(args) {
        if (args[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[0] === "ls-files") return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const bundle = await createCheckpointBundle({
      workspaceDir: "/workspace",
      baseCommit: "abc",
      git: gitForBundle,
      fs: makeFs({}),
      clock: new FakeClock(),
    });
    await storage.put("chk2", serializeBundle(bundle));

    const git: GitRunner = {
      async run(args) {
        if (args[0] === "status") return { stdout: " M dirty.txt\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    await expect(
      restoreWorkspace({ workspaceDir: "/workspace", checkpointKey: "chk2", storage, git, fs: makeFs() }),
    ).rejects.toBeInstanceOf(RestoreValidationError);
  });

  test("throws RestoreValidationError when git status fails", async () => {
    const storage = new InMemoryCheckpointStorage();
    const gitForBundle: GitRunner = {
      async run(args) {
        if (args[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[0] === "ls-files") return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const bundle = await createCheckpointBundle({
      workspaceDir: "/workspace",
      baseCommit: "abc",
      git: gitForBundle,
      fs: makeFs({}),
      clock: new FakeClock(),
    });
    await storage.put("chk3", serializeBundle(bundle));
    const git: GitRunner = {
      async run(args) {
        if (args[0] === "status") return { stdout: "", stderr: "fatal", exitCode: 1 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    await expect(
      restoreWorkspace({ workspaceDir: "/workspace", checkpointKey: "chk3", storage, git, fs: makeFs() }),
    ).rejects.toBeInstanceOf(RestoreValidationError);
  });

  test("missing untracked file after extraction fails validation", async () => {
    const storage = new InMemoryCheckpointStorage();
    const gitForBundle: GitRunner = {
      async run(args) {
        if (args[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[0] === "ls-files") return { stdout: "a.txt\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const fsForBundle = makeFs({ "/workspace/a.txt": new TextEncoder().encode("x") });
    const bundle = await createCheckpointBundle({
      workspaceDir: "/workspace",
      baseCommit: "abc",
      git: gitForBundle,
      fs: fsForBundle,
      clock: new FakeClock(),
    });
    await storage.put("chk4", serializeBundle(bundle));

    const git = makeRestoreGit("?? a.txt\n");
    // Fs that silently drops writes
    const fsNoop: FileSystem = {
      async readFile() {
        throw new Error("not found");
      },
      async writeFile() {
        // do not store
      },
      async exists() {
        return false;
      },
      async unlink() {},
    };
    await expect(
      restoreWorkspace({ workspaceDir: "/workspace", checkpointKey: "chk4", storage, git, fs: fsNoop }),
    ).rejects.toBeInstanceOf(RestoreValidationError);
  });
});
