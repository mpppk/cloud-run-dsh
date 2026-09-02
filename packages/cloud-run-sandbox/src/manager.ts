import { buildDeleteArgv, buildExecArgv, buildRunArgv } from "./argv.js";
import { filterEnv } from "./env.js";
import { toSandboxId } from "./sandboxId.js";
import type {
  SandboxCliRunner,
  SandboxExecRequest,
  SandboxExecResult,
  SubprocessHandle,
} from "./types.js";

export interface SandboxManager {
  getWorkspaceId(): string;
  ensureRunning(): Promise<void>;
  exec(request: SandboxExecRequest): SubprocessHandle;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SandboxManagerOptions {
  readonly workspaceId: string;
  readonly runner: SandboxCliRunner;
}

export class DefaultSandboxManager implements SandboxManager {
  private readonly workspaceId: string;
  private readonly sandboxId: string;
  private readonly runner: SandboxCliRunner;

  constructor(opts: SandboxManagerOptions) {
    this.workspaceId = opts.workspaceId;
    this.sandboxId = toSandboxId(opts.workspaceId);
    this.runner = opts.runner;
  }

  getWorkspaceId(): string {
    return this.workspaceId;
  }

  getSandboxId(): string {
    return this.sandboxId;
  }

  async ensureRunning(): Promise<void> {
    const argv = buildRunArgv(this.sandboxId);
    await this.runner.run(argv);
  }

  exec(request: SandboxExecRequest): SubprocessHandle {
    if (!request.command) throw new Error("command required");
    // cwd is required — never silently default to /workspace (spec 26 item 2).
    if (!request.cwd) throw new Error("cwd required");
    // Env allowlist is enforced here too, so callers using the manager directly
    // cannot bypass it (spec 26 item 6).
    const env = filterEnv(request.env);
    const argv = buildExecArgv(this.sandboxId, {
      cwd: request.cwd,
      env,
      command: request.command,
      args: request.args,
    });
    const start = Date.now();
    const result: Promise<SandboxExecResult> = this.runner
      .run(argv, { stdin: request.stdin })
      .then((r) => ({
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs: Date.now() - start,
      }));
    return { result };
  }

  /**
   * reset() = delete then recreate the named sandbox,
   * reconnecting the /workspace bind mount.
   */
  async reset(): Promise<void> {
    await this.runner.run(buildDeleteArgv(this.sandboxId));
    await this.runner.run(buildRunArgv(this.sandboxId));
  }

  async dispose(): Promise<void> {
    await this.runner.run(buildDeleteArgv(this.sandboxId));
  }
}

export function createSandboxManager(opts: SandboxManagerOptions): SandboxManager {
  return new DefaultSandboxManager(opts);
}
