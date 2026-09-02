import { buildDeleteArgv, buildExecArgv, buildRunArgv } from "./argv.js";
import { toSandboxId } from "./sandboxId.js";
import type {
  SandboxCliRunner,
  SandboxExecRequest,
  SandboxExecResult,
  SubprocessHandle,
} from "./types.js";

export interface SandboxManager {
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
  private readonly sandboxId: string;
  private readonly runner: SandboxCliRunner;

  constructor(opts: SandboxManagerOptions) {
    this.sandboxId = toSandboxId(opts.workspaceId);
    this.runner = opts.runner;
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
    // cwd defaults to /workspace if not provided? spec says cwd required.
    const cwd = request.cwd || "/workspace";
    const argv = buildExecArgv(this.sandboxId, {
      cwd,
      env: request.env,
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
