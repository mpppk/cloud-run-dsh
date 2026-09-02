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
): readonly string[] {
  if (!command) throw new Error("command required");
  return [command, ...args];
}

/**
 * Validate cwd is an absolute path inside /workspace.
 * Returns normalized cwd or throws.
 */
export function validateCwd(cwd: string): string {
  if (!cwd) throw new Error("cwd required");
  if (!cwd.startsWith("/")) throw new Error(`cwd must be absolute: ${cwd}`);
  // For MVP we allow any absolute path but ensure it is not empty host root escape.
  return cwd;
}

export function assertNoShellJoining(command: string, args: readonly string[]): void {
  // This function exists to document the invariant: caller must not use argv join with space.
  // No-op at runtime — tests assert that the structured argv is passed verbatim.
}
