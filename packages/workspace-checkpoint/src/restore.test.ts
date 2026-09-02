import { describe, test, expect } from "bun:test";
import { restoreWorkspace } from "./restore.js";
import { InMemoryCheckpointStorage } from "./storage.js";
import { createCheckpointBundle, serializeBundle } from "./bundle.js";
import { RestoreValidationError } from "./errors.js";
import type { GitRunner, FileSystem, Clock } from "./types.js";

class FakeClock implements Clock {
  now() {
    return new Date("2026-09-02T00:00:00Z");
  }
  nowMs() {
    return Date.now();
  }
}

function makeFs(initial: Record<string, Uint8Array> = {}): FileSystem & { files: Map<string, Uint8Array> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
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
  };
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
    const gitCalls: string[][] = [];
    const git: GitRunner = {
      async run(args, opts) {
        gitCalls.push([...args]);
        if (args[0] === "clone") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[0] === "checkout") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[0] === "apply") {
          expect(args).toEqual(["apply", "--binary", expect.stringContaining("patch.diff") as unknown as string]);
          expect(opts?.cwd).toBe(workspaceDir);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "status") {
          // After restore, status should be dirty (patch + untracked)
          return { stdout: " M modified.txt\n?? new.txt\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const fs = makeFs();

    await restoreWorkspace({
      workspaceDir,
      repoUrl,
      baseCommit,
      checkpointKey: "chk-1",
      storage,
      git,
      fs,
    });

    expect(gitCalls.map((c) => c[0])).toEqual(expect.arrayContaining(["clone", "checkout", "apply", "status"]));
    // Verify untracked file was extracted
    expect(await fs.exists("/workspace/new.txt")).toBe(true);
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

    const git: GitRunner = {
      async run(args) {
        if (args[0] === "clone") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[0] === "checkout") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[0] === "apply") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[0] === "status") return { stdout: "", stderr: "", exitCode: 0 }; // clean, but bundle had patch
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
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

    const git: GitRunner = {
      async run(args) {
        if (args[0] === "status") return { stdout: "?? a.txt\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
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
    };
    await expect(
      restoreWorkspace({ workspaceDir: "/workspace", checkpointKey: "chk4", storage, git, fs: fsNoop }),
    ).rejects.toBeInstanceOf(RestoreValidationError);
  });
});
