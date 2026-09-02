/**
 * Helpers for keeping command + args as structured argv.
 * This package does NOT contain sandbox CLI shape — that lives in @cloud-run-dsh/cloud-run-sandbox.
 */

export interface SubprocessSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export function toStructuredArgv(
  command: string,
  args: readonly string[],
): [string, ...string[]] {
  if (!command) throw new Error("command required");
  return [command, ...args];
}

/**
 * Validate cwd is an absolute path strictly inside /workspace.
 * Rejects non-absolute paths, any path outside /workspace, and any path
 * containing a '..' segment (workspace-path confinement, spec 26 item 2).
 * Returns normalized cwd or throws.
 */
export function validateCwd(cwd: string): string {
  if (!cwd) throw new Error("cwd required");
  if (!cwd.startsWith("/")) throw new Error(`cwd must be absolute: ${cwd}`);
  if (cwd !== "/workspace" && !cwd.startsWith("/workspace/")) {
    throw new Error(`cwd must be inside /workspace: ${cwd}`);
  }
  if (cwd.split("/").includes("..")) {
    throw new Error(`cwd must not contain '..' segments: ${cwd}`);
  }
  return cwd;
}
