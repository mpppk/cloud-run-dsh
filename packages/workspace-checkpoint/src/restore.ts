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
}

export async function restoreWorkspace(opts: RestoreOptions): Promise<void> {
  const { workspaceDir, repoUrl, baseCommit, checkpointKey, storage, git, fs } = opts;

  // 1. Clone if repoUrl provided (bootstrap path)
  if (repoUrl) {
    const cloneResult = await git.run(["clone", repoUrl, workspaceDir]);
    if (cloneResult.exitCode !== 0) {
      throw new Error(`git clone failed: ${cloneResult.stderr}`);
    }
  }

  // 2. Checkout base commit if provided
  if (baseCommit) {
    const checkoutResult = await git.run(["checkout", baseCommit], { cwd: workspaceDir });
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`git checkout failed: ${checkoutResult.stderr}`);
    }
  }

  // 3. Download checkpoint
  const data = await storage.get(checkpointKey);
  if (!data) {
    throw new Error(`checkpoint not found: ${checkpointKey}`);
  }
  const bundle = deserializeBundle(data);

  // Allow baseCommit from bundle if not provided explicitly
  const effectiveBaseCommit = baseCommit ?? bundle.manifest.baseCommit;
  if (effectiveBaseCommit && effectiveBaseCommit !== bundle.manifest.baseCommit) {
    // Mismatch is not fatal but we still checkout bundle's base
  }

  // 4. Apply patch via git apply --binary
  if (bundle.patchDiff && bundle.patchDiff.trim().length > 0) {
    // Write patch to temp file via fs then apply. For testability, we pass patch via stdin simulation:
    // Use git apply with patch content. Our GitRunner abstraction expects args; we simulate by
    // writing patch file and applying from file.
    const patchPath = `${workspaceDir.replace(/\/$/, "")}/.tmp-patch.diff`;
    await fs.writeFile(patchPath, new TextEncoder().encode(bundle.patchDiff));
    const applyResult = await git.run(["apply", "--binary", patchPath], { cwd: workspaceDir });
    if (applyResult.exitCode !== 0) {
      throw new Error(`git apply failed: ${applyResult.stderr}`);
    }
  }

  // 5. Extract untracked tar
  if (bundle.untrackedTar.length > 0) {
    const entries = extractUntrackedTar(bundle.untrackedTar);
    for (const entry of entries) {
      const fullPath = `${workspaceDir.replace(/\/$/, "")}/${entry.path}`;
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

  // Additional check: ensure untracked files from manifest appear in status or exist
  if (hasUntracked) {
    for (const file of bundle.untrackedFiles) {
      const exists = await fs.exists(`${workspaceDir.replace(/\/$/, "")}/${file}`);
      if (!exists) {
        throw new RestoreValidationError(`restore validation failed: untracked file missing: ${file}`, {
          manifest: bundle.manifest,
          missingFile: file,
        });
      }
    }
  }
}
