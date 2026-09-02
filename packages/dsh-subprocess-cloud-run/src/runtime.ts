import type { SandboxManager } from "@cloud-run-dsh/cloud-run-sandbox";
import { filterEnv } from "./environment.js";
import {
  CancelledError,
  ExecutableNotFoundError,
  TimeoutError,
} from "./errors.js";
import { validateCwd } from "./argv.js";
import { OutputCollector, processOutput } from "./process.js";
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
  private readonly mutex = new Mutex();
  private readonly defaultTimeoutMs?: number;
  private readonly secrets: readonly string[];

  constructor(opts: CloudRunSubprocessRuntimeOptions) {
    this.manager = opts.manager;
    this.defaultTimeoutMs = opts.defaultTimeoutMs;
    this.secrets = opts.secrets ?? [];
  }

  /**
   * Spawn a subprocess inside the sandbox.
   * Supports cwd, env, stdin, streamed stdout/stderr, exit code, duration, AbortSignal, timeout.
   */
  async spawn(spec: SpawnOptions): Promise<ProcessResult> {
    return this.mutex.runExclusive(() => this.spawnInner(spec));
  }

  private async spawnInner(spec: SpawnOptions): Promise<ProcessResult> {
    const cwd = validateCwd(spec.cwd || "/workspace");
    const filteredEnv = filterEnv(spec.env as Record<string, string | undefined>);
    const timeoutMs = spec.timeoutMs ?? this.defaultTimeoutMs;
    const start = Date.now();

    const collector = new OutputCollector({
      maxBytes: spec.maxOutputBytes,
      secrets: [...this.secrets, ...(spec.secrets ?? [])],
      onStdout: spec.onStdout,
      onStderr: spec.onStderr,
    });

    // Build the handle promise
    let handle: { result: Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> };
    try {
      handle = this.manager.exec({
        command: spec.command,
        args: spec.args as string[],
        cwd,
        env: filteredEnv,
        stdin: spec.stdin,
      });
    } catch (e) {
      const durationMs = Date.now() - start;
      throw e;
    }

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
      // Timeout/cancel path per spec 17: abort caller -> sandbox delete -> sandbox run -> mark result TIMEOUT/CANCELLED
      // Perform reset; ignore reset errors for now but await it.
      try {
        await this.manager.reset();
      } catch {
        // swallow reset error — we still need to report timeout/cancelled
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
