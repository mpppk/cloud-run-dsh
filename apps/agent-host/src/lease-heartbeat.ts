// Controller lease renewal loop (仕様書 section 26 / reviewer BLOCKER fix).
//
// recover() acquires the lease exactly once; without a renewal loop the lease
// expires after LEASE_EXPIRY_MS (45s) and `lease.getActive()` returns null,
// making the gateway 409 every message/approval/cancel permanently. This
// loop calls `lease.heartbeat()` every HEARTBEAT_INTERVAL_MS (15s, T6).
//
// Testability: the interval is driven by an INJECTED IntervalScheduler, never
// a bare setInterval reaching for wall time — tests bind a scheduler to the
// injected fake clock. The production scheduler unrefs its timer so the loop
// can never keep a stopped host process alive.

import {
  HEARTBEAT_INTERVAL_MS,
  LeaseExpiredError,
  LeaseNotFoundError,
  NotLeaseOwnerError,
} from "@cloud-run-dsh/controller-lease";
import type { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import type { Logger } from "@cloud-run-dsh/observability";
import type { HealthService } from "./health.js";

export interface IntervalHandle {
  cancel(): void;
}

/**
 * Injectable timer seam. Production: systemIntervalScheduler (setInterval,
 * unref'd). Tests: a scheduler wired to the injected fake clock.
 */
export interface IntervalScheduler {
  start(fn: () => void, intervalMs: number): IntervalHandle;
}

/** Wall-clock scheduler. The timer is unref'd so it never blocks process exit. */
export const systemIntervalScheduler: IntervalScheduler = {
  start(fn, intervalMs): IntervalHandle {
    const timer = setInterval(fn, intervalMs);
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
    return { cancel: () => clearInterval(timer) };
  },
};

export interface LeaseHeartbeatLoopOptions {
  readonly lease: ControllerLeaseService;
  readonly workspaceId: string;
  readonly controllerId: string;
  readonly userId: string;
  /** Defaults to the T6 constant HEARTBEAT_INTERVAL_MS (15s). */
  readonly intervalMs?: number;
  /** Defaults to the unref'd setInterval-based system scheduler. */
  readonly scheduler?: IntervalScheduler;
  readonly health: HealthService;
  readonly logger: Logger;
  /**
   * Invoked when the lease has been (re)established after a failed renewal.
   * The composition decides what "healthy" means (it consults the runtime
   * state) — the loop itself never un-fails health blindly.
   */
  readonly onLeaseRegained?: () => void;
  /**
   * Consulted before each tick; when it returns true the loop stops itself.
   * The composition binds `runtime.getState() === "STOPPED"` so a gracefully
   * stopped host is not kept renewing a lease (nor alive) by this loop.
   */
  readonly isStopped?: () => boolean;
}

/** A failed renewal of one of these typed errors means the lease is LOST. */
function isLeaseLostError(e: unknown): boolean {
  return (
    e instanceof LeaseExpiredError ||
    e instanceof NotLeaseOwnerError ||
    e instanceof LeaseNotFoundError
  );
}

export class LeaseHeartbeatLoop {
  private handle: IntervalHandle | null = null;
  private ticking = false;
  private stopped = false;

  constructor(private readonly opts: LeaseHeartbeatLoopOptions) {}

  get running(): boolean {
    return this.handle !== null;
  }

  /** Starts the renewal loop. Idempotent. */
  start(): void {
    if (this.handle) return;
    this.stopped = false;
    const scheduler = this.opts.scheduler ?? systemIntervalScheduler;
    this.handle = scheduler.start(
      () => void this.tick(),
      this.opts.intervalMs ?? HEARTBEAT_INTERVAL_MS,
    );
    this.opts.logger.info("lease.heartbeat.started", {
      event_detail: `intervalMs=${this.opts.intervalMs ?? HEARTBEAT_INTERVAL_MS}`,
    });
  }

  /** Stops the loop. Idempotent; a stopped loop cannot be restarted by a stray tick. */
  stop(): void {
    this.stopped = true;
    this.handle?.cancel();
    this.handle = null;
  }

  /** One renewal attempt. Also invoked directly by tests. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    if (this.opts.isStopped?.()) {
      this.stop();
      return;
    }
    this.ticking = true;
    try {
      await this.opts.lease.heartbeat(this.opts.workspaceId, this.opts.controllerId);
      // Renewed — health stays whatever the recovery/runtime state says.
    } catch (e) {
      if (isLeaseLostError(e)) {
        // The lease is gone (expired, taken over, or deleted): fail health
        // and attempt to re-acquire instead of silently continuing.
        this.opts.health.setRestoreFailed();
        this.opts.logger.error("lease.heartbeat.lost", {
          error: e instanceof Error ? e.message : String(e),
        });
        await this.reacquire();
      } else {
        // Transient failure (DB/transport): the lease may still be valid.
        // Do NOT fail health; retry on the next interval.
        this.opts.logger.error("lease.heartbeat.failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async reacquire(): Promise<void> {
    try {
      await this.opts.lease.acquire(
        this.opts.workspaceId,
        this.opts.controllerId,
        this.opts.userId,
      );
      this.opts.logger.info("lease.heartbeat.reacquired", {});
      this.opts.onLeaseRegained?.();
    } catch (e) {
      // Another controller holds the lease now — stay failed and keep
      // retrying each interval; never overwrite the other holder's lease.
      this.opts.logger.error("lease.heartbeat.reacquire.failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
