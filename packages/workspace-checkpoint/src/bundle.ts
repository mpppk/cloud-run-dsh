import type { CheckpointManifest, CheckpointBundle, Clock, GitRunner, FileSystem } from "./types.js";
import { filterExcluded } from "./exclusions.js";
import { createUntrackedTar } from "./tar.js";

export interface CreateBundleOptions {
  workspaceDir: string;
  baseCommit: string;
  git: GitRunner;
  fs: FileSystem;
  clock: Clock;
}

export async function createCheckpointBundle(opts: CreateBundleOptions): Promise<CheckpointBundle> {
  const { workspaceDir, baseCommit, git, fs, clock } = opts;

  // 1. git diff --binary HEAD -> patch.diff
  const diffResult = await git.run(["diff", "--binary", "HEAD"], { cwd: workspaceDir });
  if (diffResult.exitCode !== 0) {
    throw new Error(`git diff failed: ${diffResult.stderr}`);
  }
  const patchDiff = diffResult.stdout;

  // 2. untracked files via git ls-files --others --exclude-standard
  const lsResult = await git.run(["ls-files", "--others", "--exclude-standard"], { cwd: workspaceDir });
  if (lsResult.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${lsResult.stderr}`);
  }
  const rawFiles = lsResult.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const filtered = filterExcluded(rawFiles);

  // 3. pack into untracked.tar by reading each file
  const entries: { path: string; content: Uint8Array }[] = [];
  for (const file of filtered) {
    const fullPath = `${workspaceDir.replace(/\/$/, "")}/${file}`;
    try {
      const content = await fs.readFile(fullPath);
      entries.push({ path: file, content });
    } catch {
      // If file cannot be read (e.g., deleted between ls and read), skip
    }
  }
  const untrackedTar = createUntrackedTar(entries);

  // 4. metadata.json manifest
  const manifest: CheckpointManifest = {
    version: 1,
    baseCommit,
    createdAt: clock.now().toISOString(),
    patch: "patch.diff",
    untracked: "untracked.tar",
  };

  return {
    manifest,
    patchDiff,
    untrackedFiles: filtered,
    untrackedTar,
  };
}

export function serializeBundle(bundle: CheckpointBundle): Uint8Array {
  // Serialize bundle for storage: JSON with base64-encoded binary fields
  const payload = {
    manifest: bundle.manifest,
    patchDiff: bundle.patchDiff,
    untrackedFiles: bundle.untrackedFiles,
    untrackedTar: Buffer.from(bundle.untrackedTar).toString("base64"),
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

export function deserializeBundle(data: Uint8Array): CheckpointBundle {
  const text = new TextDecoder().decode(data);
  const obj = JSON.parse(text) as {
    manifest: CheckpointManifest;
    patchDiff: string;
    untrackedFiles: string[];
    untrackedTar: string;
  };
  return {
    manifest: obj.manifest,
    patchDiff: obj.patchDiff,
    untrackedFiles: obj.untrackedFiles,
    untrackedTar: Uint8Array.from(Buffer.from(obj.untrackedTar, "base64")),
  };
}
