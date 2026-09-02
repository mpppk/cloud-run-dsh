// Workspace path validation shared by the harness filesystem adapter and the
// sandbox exec guard (仕様書 section 6.1: /workspace is the ONLY mutable root;
// section 26 item 2: model-driven writes outside /workspace are forbidden).

import { posix } from "node:path";

/**
 * Resolves `path` against `root` and returns the normalized absolute path.
 * Refuses any result that escapes the workspace root (absolute paths outside
 * the root, `..` traversal, or symlink-free normalization mismatches).
 */
export function resolveInsideWorkspace(root: string, path: string): string {
  const normalizedRoot = posix.normalize(root.replace(/\/+$/, "")) || "/";
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("workspace path required");
  }
  const resolved = posix.isAbsolute(path)
    ? posix.normalize(path)
    : posix.normalize(posix.join(normalizedRoot, path));
  const prefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  if (resolved !== normalizedRoot && !resolved.startsWith(prefix)) {
    throw new Error(`path refused: ${path} escapes workspace root ${normalizedRoot}`);
  }
  return resolved;
}
