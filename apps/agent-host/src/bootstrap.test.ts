import { describe, expect, test } from "bun:test";
import {
  InMemoryCheckpointStorage,
  createUntrackedTar,
  serializeBundle,
} from "@cloud-run-dsh/workspace-checkpoint";
import type { CheckpointBundle } from "@cloud-run-dsh/workspace-checkpoint";
import { createGitHubCredentialBroker } from "@cloud-run-dsh/github-credential-broker";
import { WorkspaceBootstrapper } from "./bootstrap.js";
import {
  FAKE_INSTALLATION_TOKEN,
  InMemoryFs,
  RecordingGitRunner,
  fakeBrokerTransport,
  fakeSecretProvider,
} from "./fakes.js";

const encoder = new TextEncoder();

function makeBootstrapper(options?: {
  storage?: InMemoryCheckpointStorage;
  git?: RecordingGitRunner;
  fs?: InMemoryFs;
}): {
  bootstrapper: WorkspaceBootstrapper;
  storage: InMemoryCheckpointStorage;
  git: RecordingGitRunner;
  fs: InMemoryFs;
} {
  const storage = options?.storage ?? new InMemoryCheckpointStorage();
  const git = options?.git ?? new RecordingGitRunner();
  const fs = options?.fs ?? new InMemoryFs();
  const broker = createGitHubCredentialBroker({
    secretProvider: fakeSecretProvider(),
    transport: fakeBrokerTransport({ owner: "mpppk", name: "cloud-run-dsh" }),
  });
  const bootstrapper = new WorkspaceBootstrapper({
    workspaceId: "ws-1",
    workspaceDir: "/workspace",
    repository: { owner: "mpppk", name: "cloud-run-dsh" },
    baseBranch: "main",
    checkpointKey: "workspaces/ws-1/checkpoint.bin",
    broker,
    storage,
    git,
    fs,
  });
  return { bootstrapper, storage, git, fs };
}

describe("WorkspaceBootstrapper", () => {
  test("clone uses the installation token via extraheader only — never in the URL", async () => {
    const { bootstrapper, git } = makeBootstrapper();
    await bootstrapper.cloneRepository();

    expect(git.calls.length).toBe(1);
    const args = git.calls[0]!.args;
    expect(args).toContain("clone");
    // Token travels via http.extraheader, not in the remote URL.
    const header = args.find((arg) => arg.includes("extraheader"));
    expect(header).toContain(`Bearer ${FAKE_INSTALLATION_TOKEN}`);
    const url = args.find((arg) => arg.startsWith("https://"));
    expect(url).toBe("https://github.com/mpppk/cloud-run-dsh.git");
    expect(url!.includes(FAKE_INSTALLATION_TOKEN)).toBe(false);
  });

  test("mkdir /workspace happens before clone", async () => {
    const { bootstrapper, git, fs } = makeBootstrapper();
    await bootstrapper.cloneRepository();
    expect(fs.files.has("/workspace")).toBe(true);
    expect(git.calls[0]!.args).toContain("clone");
  });

  test("fresh workspace without a checkpoint: token is discarded, nothing restored", async () => {
    const { bootstrapper, git, fs } = makeBootstrapper();
    await bootstrapper.cloneRepository();
    await bootstrapper.checkoutBase();
    await bootstrapper.restoreCheckpoint();

    expect(bootstrapper.isTokenDiscarded).toBe(true);
    // No checkout/status calls happened (no checkpoint to restore).
    expect(git.calls.filter((c) => c.args[0] === "checkout").length).toBe(0);
    expect(fs.writes.filter((w) => w.path !== "/workspace").length).toBe(0);
  });

  test("checkpoint restore applies untracked files and then discards the token", async () => {
    const storage = new InMemoryCheckpointStorage();
    const bundle: CheckpointBundle = {
      manifest: {
        version: 1,
        baseCommit: "abc1234",
        createdAt: "2026-01-01T00:00:00.000Z",
        patch: "untracked",
        untracked: "notes.txt",
      },
      patchDiff: "",
      untrackedFiles: ["notes.txt"],
      untrackedTar: createUntrackedTar([
        { path: "notes.txt", content: encoder.encode("hello from checkpoint") },
      ]),
    };
    await storage.put("workspaces/ws-1/checkpoint.bin", serializeBundle(bundle));

    const git = new RecordingGitRunner();
    git.responses.set("status", { exitCode: 0, stdout: "?? notes.txt\0", stderr: "" });

    const { bootstrapper, fs } = makeBootstrapper({ storage, git });
    await bootstrapper.cloneRepository();
    await bootstrapper.checkoutBase();
    await bootstrapper.restoreCheckpoint();

    // Base SHA checkout happened from the checkpoint manifest.
    const checkout = git.calls.find((c) => c.args[0] === "checkout");
    expect(checkout).toBeDefined();
    expect(checkout!.args).toContain("abc1234");

    // Untracked file restored into /workspace.
    const restored = await fs.readFile("/workspace/notes.txt");
    expect(new TextDecoder().decode(restored)).toBe("hello from checkpoint");

    // Token discarded and never persisted.
    expect(bootstrapper.isTokenDiscarded).toBe(true);
    for (const write of fs.writes) {
      const text = new TextDecoder().decode(write.data);
      expect(text.includes(FAKE_INSTALLATION_TOKEN)).toBe(false);
    }
    // No git call after the clone carries the token.
    for (const call of git.calls.slice(1)) {
      expect(call.args.some((a) => a.includes(FAKE_INSTALLATION_TOKEN))).toBe(false);
    }
  });

  test("failed restore still discards the token", async () => {
    const storage = new InMemoryCheckpointStorage();
    // A checkpoint exists but git checkout fails.
    await storage.put(
      "workspaces/ws-1/checkpoint.bin",
      serializeBundle({
        manifest: {
          version: 1,
          baseCommit: "abc1234",
          createdAt: "2026-01-01T00:00:00.000Z",
          patch: "",
          untracked: "",
        },
        patchDiff: "",
        untrackedFiles: [],
        untrackedTar: new Uint8Array(0),
      }),
    );
    const git = new RecordingGitRunner();
    git.responses.set("checkout", { exitCode: 1, stdout: "", stderr: "checkout boom" });

    const { bootstrapper } = makeBootstrapper({ storage, git });
    await bootstrapper.cloneRepository();
    await expect(bootstrapper.checkoutBase()).rejects.toThrow(/git checkout failed/);
    await expect(bootstrapper.restoreCheckpoint()).rejects.toThrow(/git checkout failed/);
    expect(bootstrapper.isTokenDiscarded).toBe(true);
  });
});
