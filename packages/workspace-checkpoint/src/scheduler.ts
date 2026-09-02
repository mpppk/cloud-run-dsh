import type { Clock, GitRunner } from "./types.js";
import { isDirty } from "./dirty.js";
import { CheckpointFailedError } from "./errors.js";

export interface SchedulerOptions {
  clock: Clock;
  git: GitRunner;
  workspaceDir: string;
  checkpointFn: () => Promise<void>;
  dirtyThresholdMs?: number;
}

export type LifecycleResult = { ok: true } | { ok: false; error: CheckpointFailedError };

export class CheckpointScheduler {
  private dirty = false;
  private dirtySinceMs: number | null = null;
  private checkpointInProgress = false;
  private pendingDirtyDuringCheckpoint = false;
  private lastCheckpointMs: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SchedulerOptions) {}

  getDirty(): boolean {
    return this.dirty;
  }

  isCheckpointing(): boolean {
    return this.checkpointInProgress;
  }

  getDirtySinceMs(): number | null {
    return this.dirtySinceMs;
  }

  /** Called when workspace mutates (filesystem change, etc.) */
  notifyMutation(): void {
    if (this.checkpointInProgress) {
      this.pendingDirtyDuringCheckpoint = true;
      return;
    }
    if (!this.dirty) {
      this.dirty = true;
      this.dirtySinceMs = this.opts.clock.nowMs();
    }
  }

  /** Directly set dirty flag based on git status (for testing/manual). */
  setDirty(value: boolean): void {
    if (value) {
      this.notifyMutation();
    } else {
      this.dirty = false;
      this.dirtySinceMs = null;
    }
  }

  /** Agent turn completed trigger: if dirty, checkpoint. */
  async onAgentTurnComplete(): Promise<void> {
    if (!this.dirty) return;
    // Optionally verify dirty via git before checkpointing
    // but we rely on internal flag for scheduler logic; still check git
    await this.tryCheckpoint("agent-turn");
  }

  /** Manual trigger. */
  async triggerManual(): Promise<void> {
    await this.tryCheckpoint("manual");
  }

  /** Periodic check: dirty for >= 2 minutes. */
  async checkPeriodic(): Promise<void> {
    if (!this.dirty || this.dirtySinceMs === null) return;
    const threshold = this.opts.dirtyThresholdMs ?? 2 * 60 * 1000;
    const elapsed = this.opts.clock.nowMs() - this.dirtySinceMs;
    if (elapsed >= threshold) {
      await this.tryCheckpoint("periodic");
    }
  }

  /**
   * Lifecycle checkpoint: must succeed before stop/update.
   * Returns failure the caller can turn into CHECKPOINT_FAILED.
   * Caller must NOT proceed to stop if result is ok:false.
   */
  async runLifecycleCheckpoint(): Promise<LifecycleResult> {
    // If not dirty, lifecycle checkpoint is a no-op success (still needs to be idempotent)
    // But spec says checkpoint before stop is mandatory; if not dirty, succeed.
    if (!this.dirty && !this.checkpointInProgress) {
      // Verify via git as well
      try {
        const dirtyViaGit = await isDirty(this.opts.git, this.opts.workspaceDir);
        if (!dirtyViaGit) return { ok: true };
        // git says dirty but internal flag says clean -> mark dirty
        this.dirty = true;
        this.dirtySinceMs ??= this.opts.clock.nowMs();
      } catch (e) {
        return { ok: false, error: new CheckpointFailedError("lifecycle checkpoint failed: git status error", e) };
      }
    }
    if (this.checkpointInProgress) {
      return { ok: false, error: new CheckpointFailedError("lifecycle checkpoint failed: concurrent checkpoint in progress") };
    }
    try {
      await this.doCheckpoint();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: new CheckpointFailedError("lifecycle checkpoint failed", e) };
    }
  }

  private async tryCheckpoint(_reason: string): Promise<void> {
    if (this.checkpointInProgress) return;
    if (!this.dirty) {
      // double-check via git before skipping
      try {
        const dirtyViaGit = await isDirty(this.opts.git, this.opts.workspaceDir);
        if (!dirtyViaGit) return;
        this.dirty = true;
        this.dirtySinceMs ??= this.opts.clock.nowMs();
      } catch {
        return;
      }
    }
    try {
      await this.doCheckpoint();
    } catch {
      // checkpoint failure is not propagated for non-lifecycle triggers;
      // but dirty should remain true for retry.
      this.dirty = true;
      // keep dirtySinceMs as is for periodic retry
    }
  }

  private async doCheckpoint(): Promise<void> {
    this.checkpointInProgress = true;
    this.pendingDirtyDuringCheckpoint = false;
    try {
      await this.opts.checkpointFn();
      // Success: if mutation happened during checkpoint, keep dirty=true
      if (this.pendingDirtyDuringCheckpoint) {
        this.dirty = true;
        this.dirtySinceMs = this.opts.clock.nowMs();
      } else {
        this.dirty = false;
        this.dirtySinceMs = null;
      }
      this.lastCheckpointMs = this.opts.clock.nowMs();
      this.pendingDirtyDuringCheckpoint = false;
    } catch (e) {
      // On failure, keep dirty=true for next round
      this.dirty = true;
      // dirtySinceMs stays as before so periodic will retry soon
      this.pendingDirtyDuringCheckpoint = false;
      throw e;
    } finally {
      this.checkpointInProgress = false;
    }
  }

  /** Start periodic timer (optional for production). */
  startPeriodic(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkPeriodic();
    }, intervalMs);
    // Allow process to exit even if timer is active
    if (this.timer && typeof (this.timer as unknown as { unref?: () => void }).unref === "function") {
      (this.timer as unknown as { unref: () => void }).unref!();
    }
  }

  stopPeriodic(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
