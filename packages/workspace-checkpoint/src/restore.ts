import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { CheckpointStorage } from "./storage.js";
import type { GitRunner, FileSystem } from "./types.js";
import { RestoreValidationError } from "./errors.js";
import { deserializeBundle } from "./bundle.js";
import { extractUntrackedTar } from "./tar.js";

export interface RestoreOptions {
  workspaceDir: string;
  repoUrl?: string;
  baseCommit?: string;
  checkpointKey: string;
  storage: CheckpointStorage;
  git: GitRunner;
  fs: FileSystem;
  /** Directory for transient files (e.g. the patch). Defaults to os.tmpdir(). Must be outside workspaceDir. */
  tmpDir?: string;
}

/**
 * Resolve a tar entry path to a location strictly inside workspaceDir.
 * Rejects absolute paths, any `..` segment, and anything resolving outside
 * the workspace (仕様書 section 26 item 2: /workspace 外への書き込み禁止).
 */
export function resolveWorkspaceEntryPath(workspaceDir: string, entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new RestoreValidationError(`restore validation failed: absolute path in untracked tar entry: ${entryPath}`, {
      entryPath,
    });
  }
  if (normalized.split("/").some((seg) => seg === "..")) {
    throw new RestoreValidationError(`restore validation failed: path traversal in untracked tar entry: ${entryPath}`, {
      entryPath,
    });
  }
  const workspaceRoot = posix.resolve(workspaceDir);
  const resolved = posix.resolve(workspaceRoot, normalized);
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}/`)) {
    throw new RestoreValidationError(`restore validation failed: path escapes workspace: ${entryPath}`, {
      entryPath,
    });
  }
  if (resolved === workspaceRoot || normalized === "" || normalized === ".") {
    throw new RestoreValidationError(`restore validation failed: empty untracked tar entry path`, {
      entryPath,
    });
  }
  return resolved;
}

export async function restoreWorkspace(opts: RestoreOptions): Promise<void> {
  const { workspaceDir, repoUrl, baseCommit, checkpointKey, storage, git, fs } = opts;
  const tmpDir = opts.tmpDir ?? tmpdir();

  // 1. Clone if repoUrl provided (bootstrap path)
  if (repoUrl) {
    const cloneResult = await git.run(["clone", repoUrl, workspaceDir]);
    if (cloneResult.exitCode !== 0) {
      throw new Error(`git clone failed: ${cloneResult.stderr}`);
    }
  }

  // 2. Download checkpoint (needed to learn manifest.baseCommit)
  const data = await storage.get(checkpointKey);
  if (!data) {
    throw new Error(`checkpoint not found: ${checkpointKey}`);
  }
  const bundle = deserializeBundle(data);

  // 3. Checkout base commit unconditionally (実装手順書 section 22:
  //    clone -> checkout base commit). An explicit baseCommit that disagrees
  //    with the bundle manifest is a hard, typed failure.
  if (baseCommit && baseCommit !== bundle.manifest.baseCommit) {
    throw new RestoreValidationError(
      `restore validation failed: explicit baseCommit ${baseCommit} does not match bundle manifest baseCommit ${bundle.manifest.baseCommit}`,
      { expected: bundle.manifest.baseCommit, provided: baseCommit },
    );
  }
  const checkoutResult = await git.run(["checkout", bundle.manifest.baseCommit], { cwd: workspaceDir });
  if (checkoutResult.exitCode !== 0) {
    throw new Error(`git checkout failed: ${checkoutResult.stderr}`);
  }

  // 4. Apply patch via git apply --binary, using a temp file OUTSIDE the
  //    workspace so it can never leak into a later checkpoint, and always
  //    deleted in a finally.
  if (bundle.patchDiff && bundle.patchDiff.trim().length > 0) {
    const patchPath = posix.join(tmpDir, `workspace-checkpoint-patch-${randomUUID()}.diff`);
    await fs.writeFile(patchPath, new TextEncoder().encode(bundle.patchDiff));
    try {
      const applyResult = await git.run(["apply", "--binary", patchPath], { cwd: workspaceDir });
      if (applyResult.exitCode !== 0) {
        throw new Error(`git apply failed: ${applyResult.stderr}`);
      }
    } finally {
      await fs.unlink(patchPath);
    }
  }

  // 5. Extract untracked tar, rejecting any entry that would escape the workspace
  if (bundle.untrackedTar.length > 0) {
    const entries = extractUntrackedTar(bundle.untrackedTar);
    for (const entry of entries) {
      const fullPath = resolveWorkspaceEntryPath(workspaceDir, entry.path);
      await fs.writeFile(fullPath, entry.content);
    }
  }

  // 6. Validate git status against manifest
  const statusResult = await git.run(["status", "--porcelain"], { cwd: workspaceDir });
  if (statusResult.exitCode !== 0) {
    throw new RestoreValidationError(`git status validation failed: ${statusResult.stderr}`, {
      manifest: bundle.manifest,
    });
  }
  const statusOutput = statusResult.stdout.trim();
  const hasPatch = bundle.patchDiff.trim().length > 0;
  const hasUntracked = bundle.untrackedFiles.length > 0;
  const expectsDirty = hasPatch || hasUntracked;
  const isDirty = statusOutput.length > 0;

  // If manifest says dirty but status is clean, or vice versa, validation fails
  if (expectsDirty && !isDirty) {
    throw new RestoreValidationError("restore validation failed: expected dirty workspace but git status is clean", {
      manifest: bundle.manifest,
      status: statusOutput,
    });
  }
  if (!expectsDirty && isDirty) {
    throw new RestoreValidationError("restore validation failed: expected clean workspace but git status shows changes", {
      manifest: bundle.manifest,
      status: statusOutput,
    });
  }

  // 7. Cross-check porcelain untracked entries against manifest.untrackedFiles
  const porcelainUntracked = statusOutput
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter((p) => p.length > 0);
  const expected = new Set(bundle.untrackedFiles);
  const actual = new Set(porcelainUntracked);
  const extra = [...actual].filter((p) => !expected.has(p));
  const missing = [...expected].filter((p) => !actual.has(p));
  if (extra.length > 0 || missing.length > 0) {
    throw new RestoreValidationError(
      "restore validation failed: untracked files in git status do not match manifest.untrackedFiles",
      {
        manifest: bundle.manifest,
        unexpectedUntracked: extra,
        missingUntracked: missing,
      },
    );
  }

  // Additional check: ensure untracked files from manifest exist on disk
  if (hasUntracked) {
    for (const file of bundle.untrackedFiles) {
      const exists = await fs.exists(posix.join(workspaceDir.replace(/\/$/, ""), file));
      if (!exists) {
        throw new RestoreValidationError(`restore validation failed: untracked file missing: ${file}`, {
          manifest: bundle.manifest,
          missingFile: file,
        });
      }
    }
  }
}
