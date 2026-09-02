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

/**
 * Parse `git status --porcelain -uall -z` output.
 *
 * -z separates records with NUL, so filenames containing spaces or quotes are
 * unambiguous, and -uall lists every untracked file individually (never
 * collapsed to a directory like `?? sub/`).
 */
export function parsePorcelainZ(output: string): { index: string; workTree: string; path: string }[] {
  const records: { index: string; workTree: string; path: string }[] = [];
  let pos = 0;
  while (pos < output.length) {
    const xy = output.slice(pos, pos + 2);
    if (output[pos + 2] !== " ") {
      throw new Error(`git status -z parse error: malformed record at offset ${pos}`);
    }
    const pathStart = pos + 3;
    const nul = output.indexOf("\0", pathStart);
    if (nul === -1) {
      throw new Error(`git status -z parse error: unterminated record at offset ${pos}`);
    }
    records.push({ index: xy[0] ?? "?", workTree: xy[1] ?? "?", path: output.slice(pathStart, nul) });
    pos = nul + 1;
  }
  return records;
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
  //    deleted in a finally. unlink errors are swallowed so they cannot mask
  //    the original git apply failure.
  if (bundle.patchDiff && bundle.patchDiff.trim().length > 0) {
    const patchPath = posix.join(tmpDir, `workspace-checkpoint-patch-${randomUUID()}.diff`);
    await fs.writeFile(patchPath, new TextEncoder().encode(bundle.patchDiff));
    try {
      const applyResult = await git.run(["apply", "--binary", patchPath], { cwd: workspaceDir });
      if (applyResult.exitCode !== 0) {
        throw new Error(`git apply failed: ${applyResult.stderr}`);
      }
    } finally {
      try {
        await fs.unlink(patchPath);
      } catch {
        // swallow: cleanup failure must not mask the real error
      }
    }
  }

  // 5. Extract untracked tar. Paths are sanitised FIRST (rejecting absolute,
  //    `..`-containing, or workspace-escaping entries) and only then is the
  //    parent directory created, so a malicious entry can never cause a
  //    directory to be created outside the workspace. mkdir -p handles the
  //    normal case of an untracked file in a directory absent from the base
  //    commit.
  if (bundle.untrackedTar.length > 0) {
    const entries = extractUntrackedTar(bundle.untrackedTar);
    for (const entry of entries) {
      const fullPath = resolveWorkspaceEntryPath(workspaceDir, entry.path);
      const parentDir = posix.dirname(fullPath);
      if (parentDir && parentDir !== fullPath) {
        await fs.mkdir(parentDir);
      }
      await fs.writeFile(fullPath, entry.content);
    }
  }

  // 6. Validate git status against manifest. -uall lists untracked files
  //    individually (no directory collapse) and -z makes filenames with
  //    spaces/quotes unambiguous.
  const statusResult = await git.run(["status", "--porcelain", "-uall", "-z"], { cwd: workspaceDir });
  if (statusResult.exitCode !== 0) {
    throw new RestoreValidationError(`git status validation failed: ${statusResult.stderr}`, {
      manifest: bundle.manifest,
    });
  }
  const records = parsePorcelainZ(statusResult.stdout);
  const hasPatch = bundle.patchDiff.trim().length > 0;
  const hasUntracked = bundle.untrackedFiles.length > 0;
  const expectsDirty = hasPatch || hasUntracked;
  const isDirty = records.length > 0;

  // If manifest says dirty but status is clean, or vice versa, validation fails
  if (expectsDirty && !isDirty) {
    throw new RestoreValidationError("restore validation failed: expected dirty workspace but git status is clean", {
      manifest: bundle.manifest,
      status: records.map((r) => r.path),
    });
  }
  if (!expectsDirty && isDirty) {
    throw new RestoreValidationError("restore validation failed: expected clean workspace but git status shows changes", {
      manifest: bundle.manifest,
      status: records.map((r) => r.path),
    });
  }

  // 7. Cross-check untracked entries against manifest.untrackedFiles.
  //    Paths introduced by the applied patch (files that were staged at
  //    checkpoint time are captured by `git diff --binary HEAD` but absent
  //    from `git ls-files --others`) are EXPECTED and do not count as extras.
  const patchUntracked = hasPatch ? extractPatchNewFiles(bundle.patchDiff) : [];
  const allowed = new Set<string>([...bundle.untrackedFiles, ...patchUntracked]);
  const actualUntracked = records.filter((r) => r.index === "?" && r.workTree === "?").map((r) => r.path);
  const extra = [...new Set(actualUntracked)].filter((p) => !allowed.has(p));
  const missing = [...new Set(bundle.untrackedFiles)].filter((p) => !actualUntracked.includes(p));
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

/**
 * Extract candidate paths of NEW files created by a unified diff (files staged
 * at checkpoint time show up in `git diff --binary HEAD` as new-file diffs but
 * not in `git ls-files --others`).
 *
 * git normally prefixes paths with `b/` (and `a/` on the minus side), but the
 * first component is ambiguous for a repo path that genuinely starts with
 * `b/`, so both the raw path and the path with its first component stripped
 * are returned as candidates; the cross-check set simply allows both.
 */
export function extractPatchNewFiles(patchDiff: string): string[] {
  const candidates = new Set<string>();
  for (const line of patchDiff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const raw = line.slice(4).trim();
    if (raw === "/dev/null") continue;
    let path = raw;
    // git C-quotes paths containing special characters ("my file.txt")
    if (path.startsWith('"') && path.endsWith('"')) {
      try {
        path = JSON.parse(path) as string;
      } catch {
        path = path.slice(1, -1);
      }
    }
    path = path.replace(/^\//, "");
    if (path.length === 0) continue;
    candidates.add(path);
    const slash = path.indexOf("/");
    if (slash !== -1 && slash < path.length - 1) {
      candidates.add(path.slice(slash + 1));
    }
  }
  return [...candidates];
}
