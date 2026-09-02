/**
 * Pure argv builders for the Preview-unstable `sandbox` CLI.
 * All CLI-shape knowledge lives ONLY in this package.
 *
 * CRITICAL: command + args stay a structured argv array.
 * Never build a shell string; caller must pass the returned array directly to spawn/exec.
 */

const KEEP_ALIVE_CMD = "while true; do sleep 3600; done";

export function buildRunArgv(sandboxId: string): readonly string[] {
  if (!sandboxId) throw new Error("sandboxId required");
  return [
    "sandbox",
    "run",
    sandboxId,
    "--detach",
    "--allow-egress",
    "--write",
    "--mount",
    "type=bind,source=/workspace,destination=/workspace",
    "--workdir",
    "/workspace",
    "--",
    "/bin/sh",
    "-c",
    KEEP_ALIVE_CMD,
  ] as const;
}

export interface ExecArgvOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly command: string;
  readonly args: readonly string[];
}

export function buildExecArgv(
  sandboxId: string,
  opts: ExecArgvOptions,
): readonly string[] {
  if (!sandboxId) throw new Error("sandboxId required");
  if (!opts.command) throw new Error("command required");
  if (!opts.cwd) throw new Error("cwd required");
  const argv: string[] = ["sandbox", "exec", sandboxId, "--workdir", opts.cwd];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      // Each env is a single argv element `K=V` — never shell-joined.
      argv.push("--env", `${k}=${v}`);
    }
  }
  argv.push("--", opts.command, ...opts.args);
  return argv;
}

export function buildDeleteArgv(sandboxId: string): readonly string[] {
  if (!sandboxId) throw new Error("sandboxId required");
  return ["sandbox", "delete", sandboxId] as const;
}
