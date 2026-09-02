import type { SandboxManager } from "@cloud-run-dsh/cloud-run-sandbox";
import { filterEnv } from "./environment.js";
import {
  CancelledError,
  ExecutableNotFoundError,
  TimeoutError,
} from "./errors.js";
import { toStructuredArgv, validateCwd } from "./argv.js";
import { OutputCollector } from "./process.js";
import type { ProcessResult } from "./process.js";
import type { SubprocessSpawnSpec } from "./argv.js";

export type { ProcessResult };

export interface SpawnOptions extends SubprocessSpawnSpec {
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly maxOutputBytes?: number;
  readonly secrets?: readonly string[];
}

/**
 * Per-workspace mutex that serializes subprocess execution.
 * Only one active subprocess exists per workspace (spec 15).
 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((res) => (release = res));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Shared per-workspace lock registry. The "1 active subprocess per workspace"
 * invariant (spec 15) must hold across ALL runtime instances for the same
 * workspace, not just within one object — hence a module-level registry keyed
 * by workspaceId.
 */
interface WorkspaceLock {
  readonly mutex: Mutex;
  /** Set when a timeout/cancel reset failed: the sandbox may be gone (with the /workspace bind mount). */
  sandboxUnusable: boolean;
}

const workspaceLocks = new Map<string, WorkspaceLock>();

function getWorkspaceLock(workspaceId: string): WorkspaceLock {
  let lock = workspaceLocks.get(workspaceId);
  if (!lock) {
    lock = { mutex: new Mutex(), sandboxUnusable: false };
    workspaceLocks.set(workspaceId, lock);
  }
  return lock;
}

/**
 * resolveExecutable runs `command -v <cmd>` INSIDE the sandbox and returns the execution-world path.
 * Never resolves against the host PATH.
 */
export async function resolveExecutable(
  command: string,
  manager: Pick<SandboxManager, "exec">,
): Promise<string> {
  if (!command) throw new Error("command required");
  // Use /bin/sh -c 'command -v -- "$1"' sh <cmd> to avoid shell injection; cmd is passed as $1.
  const handle = manager.exec({
    command: "/bin/sh",
    args: ["-c", 'command -v -- "$1"', "sh", command],
    cwd: "/workspace",
  });
  const res = await handle.result;
  if (res.exitCode !== 0) {
    throw new ExecutableNotFoundError(command);
  }
  const p = res.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (!p) throw new ExecutableNotFoundError(command);
  return p;
}

export interface CloudRunSubprocessRuntimeOptions {
  readonly manager: SandboxManager;
  readonly defaultTimeoutMs?: number;
  readonly secrets?: readonly string[];
}

export class CloudRunSubprocessRuntime {
  private readonly manager: SandboxManager;
  private readonly lock: WorkspaceLock;
  private readonly workspaceId: string;
  private readonly defaultTimeoutMs?: number;
  private readonly secrets: readonly string[];

  constructor(opts: CloudRunSubprocessRuntimeOptions) {
    this.manager = opts.manager;
    this.workspaceId = opts.manager.getWorkspaceId();
    this.lock = getWorkspaceLock(this.workspaceId);
    this.defaultTimeoutMs = opts.defaultTimeoutMs;
    this.secrets = opts.secrets ?? [];
  }

  getWorkspaceId(): string {
    return this.manager.getWorkspaceId();
  }

  /**
   * Graceful teardown: waits for any in-flight subprocess, then evicts this
   * workspace's lock from the module-level registry so the entry (and its
   * serialized promise chain) is not retained forever by long-lived hosts.
   */
  async dispose(): Promise<void> {
    await this.lock.mutex.runExclusive(async () => {
      if (workspaceLocks.get(this.workspaceId) === this.lock) {
        workspaceLocks.delete(this.workspaceId);
      }
    });
  }

  /**
   * Spawn a subprocess inside the sandbox.
   * Supports cwd, env, stdin, streamed stdout/stderr, exit code, duration, AbortSignal, timeout.
   */
  async spawn(spec: SpawnOptions): Promise<ProcessResult> {
    return this.lock.mutex.runExclusive(() => this.spawnInner(spec));
  }

  private async spawnInner(spec: SpawnOptions): Promise<ProcessResult> {
    // If a previous reset failed, the sandbox may no longer exist and the
    // /workspace bind mount is lost. Recreate it up-front (or fail loudly) —
    // never silently run against a dead sandbox.
    if (this.lock.sandboxUnusable) {
      await this.manager.ensureRunning();
      this.lock.sandboxUnusable = false;
    }
    // cwd is required — no silent /workspace fallback.
    const cwd = validateCwd(spec.cwd);
    const filteredEnv = filterEnv(spec.env as Record<string, string | undefined>);
    const timeoutMs = spec.timeoutMs ?? this.defaultTimeoutMs;
    const start = Date.now();

    const collector = new OutputCollector({
      maxBytes: spec.maxOutputBytes,
      secrets: [...this.secrets, ...(spec.secrets ?? [])],
      onStdout: spec.onStdout,
      onStderr: spec.onStderr,
    });

    // Structured argv invariant is enforced here at runtime (spec 26 item 11):
    // command + args stay separate elements, never a joined shell string.
    const [command, ...args] = toStructuredArgv(spec.command, spec.args);

    const handle = this.manager.exec({
      command,
      args,
      cwd,
      env: filteredEnv,
      stdin: spec.stdin,
    });

    // Setup abort / timeout handling
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    let timedOut = false;
    let cancelled = false;

    const abortPromise = new Promise<never>((_, reject) => {
      if (spec.signal?.aborted) {
        cancelled = true;
        reject(new CancelledError());
        return;
      }
      if (spec.signal) {
        abortHandler = () => {
          cancelled = true;
          reject(new CancelledError());
        };
        spec.signal.addEventListener("abort", abortHandler, { once: true });
      }
      if (timeoutMs !== undefined) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new TimeoutError());
        }, timeoutMs);
      }
    });

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (abortHandler && spec.signal) {
        spec.signal.removeEventListener("abort", abortHandler);
      }
    };

    try {
      const res = await Promise.race([handle.result, abortPromise]);
      cleanup();
      // Stream simulation: push collected stdout/stderr through collector
      // For real runner stdout/stderr are already buffered; we simulate streaming via single chunk.
      if (res.stdout) collector.pushStdout(res.stdout);
      if (res.stderr) collector.pushStderr(res.stderr);
      const durationMs = res.durationMs ?? Date.now() - start;
      const status = res.exitCode === 0 ? "success" : "error";
      return collector.finalize(res.exitCode, durationMs, status);
    } catch (e) {
      cleanup();
      // Timeout/cancel path per spec 17: abort caller -> sandbox delete -> sandbox run -> mark result TIMEOUT/CANCELLED.
      // If reset fails, the sandbox is gone and the /workspace bind mount is lost:
      // mark it unusable so the next spawn recreates it via ensureRunning (or fails loudly).
      try {
        await this.manager.reset();
      } catch {
        this.lock.sandboxUnusable = true;
      }
      const durationMs = Date.now() - start;
      if (timedOut || e instanceof TimeoutError) {
        return collector.finalize(null, durationMs, "timeout");
      }
      if (cancelled || e instanceof CancelledError) {
        return collector.finalize(null, durationMs, "cancelled");
      }
      // Re-throw unexpected errors
      throw e;
    }
  }
}
