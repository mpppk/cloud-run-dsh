// Local implementation of the DeepSeek Harness subprocess seam
// (`@deepseek-ai/dsh-subprocess`) for the agent-host filesystem composition.
//
// The real Harness composition (harness-real.ts) mounts
// @deepseek-ai/dsh-tool-fs-search, whose glob/grep tools execute the packaged
// ripgrep binary through `ctx.subprocess.spawn()` with a fully-specified
// SubprocessSpawnSpec. The official local backend
// (@deepseek-ai/dsh-subprocess-local) pulls in node-pty for terminal
// allocation, which this composition never uses; this provider implements the
// documented seam contract (detached process trees, credential-scrubbed
// environment, bounded collected output with offset-based non-consuming
// readers, SIGTERM→grace→SIGKILL tree escalation, disposal killing live
// handles) over node:child_process, and fails loud on terminal allocation.
//
// Environment scrubbing reuses the seam's own `scrubbedParentEnv()` so the
// credential-shape policy is the Harness's, not ours.

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import {
  SubprocessRuntime,
  scrubbedParentEnv,
} from "@deepseek-ai/dsh-subprocess";
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";

/**
 * One bounded in-memory collected stream over whole-stream byte coordinates.
 * The window keeps the TAIL within `maxBytes`; a read below the window is
 * lossy (the seam's diagnostic-tail shape — glob/grep never needs spill files
 * because it bounds raw output far below its cap).
 */
class CollectedStream implements SubprocessOutputReader {
  private chunks: Buffer[] = [];
  private windowBytes = 0;
  private windowStart = 0;
  totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(data: Buffer): void {
    this.totalBytes += data.byteLength;
    this.chunks.push(data);
    this.windowBytes += data.byteLength;
    while (this.windowBytes > this.maxBytes && this.chunks.length > 1) {
      const head = this.chunks[0];
      if (head === undefined) break;
      if (this.windowBytes - head.byteLength < this.maxBytes) break;
      this.chunks.shift();
      this.windowBytes -= head.byteLength;
      this.windowStart += head.byteLength;
    }
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    const whole = Buffer.concat(this.chunks);
    if (fromByte < this.windowStart) {
      return {
        text: new TextDecoder().decode(whole),
        nextOffset: this.totalBytes,
        lossy: true,
      };
    }
    return {
      text: new TextDecoder().decode(whole.subarray(fromByte - this.windowStart)),
      nextOffset: this.totalBytes,
      lossy: false,
    };
  }
}

/** Signal one detached process tree: process group first, direct child fallback. */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The tree is already gone; termination is idempotent by contract.
    }
  }
}

class LocalSpawnHandle implements SubprocessHandle {
  readonly pid: number;
  readonly stdin = undefined;
  readonly stdout = undefined;
  readonly stderr = undefined;
  readonly collected: SubprocessCollectedOutputs = {};
  readonly done: Promise<SubprocessOutcome>;

  private terminated = false;
  private closed = false;
  private killTimer: NodeJS.Timeout | undefined;
  private readonly exitWaiters: Array<() => void> = [];
  private readonly outcome: SubprocessOutcome = { exitCode: null, signal: null };

  constructor(
    child: ChildProcess,
    private readonly graceMs: number,
  ) {
    this.pid = child.pid ?? -1;
    let resolveDone!: (outcome: SubprocessOutcome) => void;
    let rejectDone!: (error: Error) => void;
    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    child.once("error", (error: Error) => {
      if (!this.closed) rejectDone(error);
    });
    child.once("close", (code, signal) => {
      this.closed = true;
      if (this.killTimer !== undefined) clearTimeout(this.killTimer);
      this.outcome.exitCode = code;
      this.outcome.signal = signal;
      resolveDone(this.outcome);
      for (const waiter of this.exitWaiters.splice(0)) waiter();
    });
  }

  terminate(): void {
    if (this.terminated || this.closed || this.pid < 0) return;
    this.terminated = true;
    signalTree(this.pid, "SIGTERM");
    // Escalate to SIGKILL after the spec's grace period (the seam's only
    // termination verb is the TERM → grace → KILL ladder).
    if (this.killTimer !== undefined || this.closed) return;
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined;
      if (!this.closed) signalTree(this.pid, "SIGKILL");
    }, this.graceMs);
    this.killTimer.unref?.();
  }

  async waitForExit(_signal?: AbortSignal): Promise<boolean> {
    if (this.closed) return true;
    await new Promise<void>((resolve) => {
      this.exitWaiters.push(resolve);
    });
    return this.closed;
  }
}

/**
 * Local spawn-backed provider registered as `ctx.subprocess` by the real
 * Harness composition. See the module doc for the seam-contract notes.
 */
export class AgentHostLocalSubprocessRuntime extends SubprocessRuntime {
  private readonly live = new Set<LocalSpawnHandle>();

  constructor(ctx: import("@deepseek-ai/cordis").Context) {
    super(ctx);
    // Disposal of the service terminates all still-running managed processes.
    ctx.effect(() => async () => {
      const handles = [...this.live];
      for (const handle of handles) handle.terminate();
      await Promise.all(handles.map((handle) => handle.waitForExit().catch(() => undefined)));
    }, "agent-host local subprocess teardown");
  }


  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new Error("resolveExecutable aborted");
    if (command.includes("/")) {
      if (!command.startsWith("/")) {
        throw new Error(
          `subprocess: relative executable paths are not resolvable without an execution-world base: ${command}`,
        );
      }
      try {
        accessSync(command, fsConstants.X_OK);
      } catch (error) {
        throw new Error(`subprocess: executable is not accessible: ${command}`, { cause: error });
      }
      return command;
    }
    const path = env?.PATH ?? process.env.PATH ?? "";
    for (const dir of path.split(":")) {
      if (dir.length === 0) continue;
      const candidate = `${dir}/${command}`;
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    throw new Error(`subprocess: executable not found on PATH: ${command}`);
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
    }
    if (spec.signal?.aborted) throw new Error("subprocess spawn aborted before start");
    if (spec.argv.length === 0 || spec.argv.some((part) => part.includes("\0"))) {
      throw new Error("subprocess: argv must be a non-empty vector without NUL bytes");
    }
    if (spec.stdio.stdin === "pipe") {
      throw new Error("subprocess: stdin 'pipe' is not supported by this composition (glob/grep spawn 'ignore')");
    }
    const stdoutCollect = typeof spec.stdio.stdout !== "string" ? spec.stdio.stdout : undefined;
    const stderrCollect = typeof spec.stdio.stderr !== "string" ? spec.stdio.stderr : undefined;
    const childEnv: Record<string, string> = { ...scrubbedParentEnv() };
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }
    const stdoutMode = typeof spec.stdio.stdout === "string" ? spec.stdio.stdout : "pipe";
    const stderrMode = typeof spec.stdio.stderr === "string" ? spec.stdio.stderr : "pipe";
    const argv0 = spec.argv[0];
    if (argv0 === undefined) throw new Error("subprocess: argv must be a non-empty vector without NUL bytes");
    const child: ChildProcess = nodeSpawn(argv0, spec.argv.slice(1), {
      cwd: spec.cwd,
      env: childEnv,
      stdio: ["ignore", stdoutMode, stderrMode] as const,
      detached: true,
    });

    const handle = new LocalSpawnHandle(child, spec.graceMs);
    const stdoutStream = child.stdout;
    if (stdoutCollect !== undefined && stdoutStream != null) {
      const out = new CollectedStream(stdoutCollect.maxBytes);
      (handle.collected as { stdout?: SubprocessOutputReader }).stdout = out;
      stdoutStream.on("data", (chunk: Buffer) => out.push(chunk));
    }
    const stderrStream = child.stderr;
    if (stderrCollect !== undefined && stderrStream != null) {
      const err = new CollectedStream(stderrCollect.maxBytes);
      (handle.collected as { stderr?: SubprocessOutputReader }).stderr = err;
      stderrStream.on("data", (chunk: Buffer) => err.push(chunk));
    }

    spec.signal?.addEventListener("abort", () => handle.terminate(), { once: true });
    this.live.add(handle);
    void handle.done
      .catch(() => undefined)
      .finally(() => {
        this.live.delete(handle);
        child.removeAllListeners();
      });
    return handle;
  }

  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error(
      "agent-host local subprocess provider does not support terminal allocation (the composition only needs spawn)",
    );
  }
}
