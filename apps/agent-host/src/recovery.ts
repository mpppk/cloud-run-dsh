// Restart recovery (実装手順書 section 30) — the NORMAL path, because a
// Cloud Run Instance stop/restart loses all local state:
//   read WORKSPACE_ID -> DB metadata -> restore workspace ->
//   restore session metadata -> create sandbox -> health READY.
//
// The workspace lifecycle itself (state machine, step order, coalescing,
// graceful stop) is orchestrated by the T8 WorkspaceRuntime; this module
// wires the host's collaborators into its WorkspaceLifecycleSteps seams and
// owns the controller-lease acquisition and health signalling around it.

import type {
  CheckpointFailedError,
  CheckpointScheduler,
  Clock,
} from "@cloud-run-dsh/workspace-checkpoint";
import type { SandboxManager } from "@cloud-run-dsh/cloud-run-sandbox";
import { LeaseAlreadyHeldError } from "@cloud-run-dsh/controller-lease";
import type { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import type { Logger, Metrics } from "@cloud-run-dsh/observability";
import { METRIC_NAMES } from "@cloud-run-dsh/observability";
import type { SessionEvent } from "@cloud-run-dsh/session-persistence-postgres";
import type { SessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import { summarizeRestoreError } from "@cloud-run-dsh/session-persistence-postgres";
import { IllegalTransitionError } from "@cloud-run-dsh/workspace-runtime";
import type {
  WorkspaceLifecycleSteps,
  WorkspaceRuntime,
} from "@cloud-run-dsh/workspace-runtime";
import type { AgentHostConfig } from "./config.js";
import { WorkspaceNotFoundError } from "./errors.js";
import type { TurnStarter } from "./gateway.js";
import type { HarnessComposition } from "./harness.js";
import type { WorkspaceBootstrapper } from "./bootstrap.js";
import type { HealthService } from "./health.js";

export interface LifecycleStepDeps {
  readonly config: AgentHostConfig;
  readonly bootstrapper: WorkspaceBootstrapper;
  readonly checkpointScheduler: CheckpointScheduler;
  readonly sandboxManager: SandboxManager;
  readonly harness: HarnessComposition;
  readonly repository: SessionPersistenceRepository;
  /**
   * Turn starter for agent resume (issue #39). Optional so message-only
   * starters and unit tests without one keep working: without a capable
   * starter the recovery restores harness metadata only and logs the skip.
   */
  readonly turnStarter?: TurnStarter;
  readonly logger: Logger;
}

/**
 * Maps the host collaborators onto the T8 WorkspaceLifecycleSteps seams.
 * Step order follows 仕様書 section 8 (the 実装手順書 section 30 bullet
 * "restore session metadata" is performed by `restoreHarness`, which runs
 * after `createSandbox` — matching the merged T8 runtime).
 */
export function buildLifecycleSteps(deps: LifecycleStepDeps): WorkspaceLifecycleSteps {
  return {
    // Issue #136: the WorkspaceLifecycleSteps seam no longer carries
    // waitForInstanceHealth — the control-plane open stopped polling
    // readiness in-request, and this host never called that step from its
    // completeRestore() path anyway (readiness IS this recovery completing).
    cloneRepository: () => deps.bootstrapper.cloneRepository(),
    checkoutBase: () => deps.bootstrapper.checkoutBase(),
    restoreCheckpoint: () => deps.bootstrapper.restoreCheckpoint(),
    createSandbox: () => deps.sandboxManager.ensureRunning(),
    restoreHarness: async () => {
      const sessions = await deps.repository.listSessions(deps.config.workspaceId);
      const eventsBySession: Record<string, readonly SessionEvent[]> = {};
      for (const session of sessions) {
        eventsBySession[session.id] = await deps.repository.readEvents(session.id);
      }
      await deps.harness.restoreSessions({ sessions, eventsBySession });
      // Agent resume (issue #39 — the "AH->>DB: セッションとイベントを復元"
      // sequence): one live agent per persisted session, rehydrated from the
      // rows read above via AgentLoop.resume(). A resume failure REJECTS this
      // step (recovery fails, input is refused): falling back to create would
      // silently present deleted history as a fresh session.
      const starter = deps.turnStarter;
      if (sessions.length === 0) {
        deps.logger.info("turn.resume.empty", {
          workspaceId: deps.config.workspaceId,
        });
        return;
      }
      if (!starter?.resumeSessions) {
        deps.logger.info("turn.resume.skipped_no_starter", {
          workspaceId: deps.config.workspaceId,
          sessionCount: sessions.length,
        });
        return;
      }
      const { resumed } = await starter.resumeSessions(sessions.map((s) => s.id));
      deps.logger.info("turn.resume.completed", {
        workspaceId: deps.config.workspaceId,
        resumed,
      });
    },
    runLifecycleCheckpoint: async () => {
      const result = await deps.checkpointScheduler.runLifecycleCheckpoint();
      if (!result.ok) throw result.error;
    },
    // Append-only session events are persisted at write time; nothing to flush.
    flushSessionPersistence: async () => {},
    deleteSandbox: () => deps.sandboxManager.dispose(),
  };
}

export interface RestartRecoveryDeps {
  readonly config: AgentHostConfig;
  readonly clock: Clock;
  readonly repository: SessionPersistenceRepository;
  readonly runtime: WorkspaceRuntime;
  readonly lease: ControllerLeaseService;
  readonly bootstrapper: WorkspaceBootstrapper;
  readonly health: HealthService;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export interface RecoveryResult {
  readonly state: string;
  readonly instanceName: string;
}

export class RestartRecovery {
  constructor(private readonly deps: RestartRecoveryDeps) {}

  /**
   * Adopt the controller lease established by the control-plane open (issue
   * #60 案B, 仕様書 section 26 item 8).
   *
   * CONTROLLER_ID is injected into the Instance env by the control plane from
   * the lease IT established at open time — this host must adopt THAT lease,
   * never self-acquire a fresh random id (the old code did, deadlocking
   * against the user's lease on the same row):
   * - no active lease (first boot, or the previous holder expired while this
   *   host was down): acquire it as self — this host becomes the holder.
   * - active lease with THIS controllerId (normal restart, same generation):
   *   heartbeat to prove ownership and extend it.
   * - active lease with ANOTHER controllerId: refuse — this is either a
   *   second host for the same workspace, or a stale generation fenced off
   *   by a newer open. Never overwrite it.
   */
  async adoptLease(): Promise<void> {
    const { config } = this.deps;
    const active = await this.deps.lease.getActive(config.workspaceId);
    if (!active) {
      await this.deps.lease.acquire(config.workspaceId, config.controllerId, config.userId);
      return;
    }
    if (active.controllerId === config.controllerId) {
      await this.deps.lease.heartbeat(config.workspaceId, config.controllerId);
      return;
    }
    throw new LeaseAlreadyHeldError(config.workspaceId, active.controllerId);
  }

  /**
   * Runs the restart recovery path (実装手順書 section 30). Refuses to run
   * when another controller still holds the lease (仕様書 section 26 item 8).
   */
  async recover(): Promise<RecoveryResult> {
    const startedMs = this.deps.clock.nowMs();
    const { config } = this.deps;

    this.deps.health.setRestoring();
    try {
      // 1. read WORKSPACE_ID (config) — non-empty is guaranteed by config parsing.

      // 2. controller lease (仕様書 section 26 item 8, issue #60 案B) — adopt
      //    the open-established lease; a second host for the same workspace
      //    is refused here.
      await this.adoptLease();

      // 3. DB metadata
      const workspace = await this.deps.repository.getWorkspace(config.workspaceId);
      if (!workspace) {
        throw new WorkspaceNotFoundError(config.workspaceId);
      }

      // 4-6. restore workspace / session metadata / create sandbox via the
      //      T8 runtime, then report healthy. completeRestore() — NOT open():
      //      the control plane already moved STOPPED -> STARTING and started
      //      this instance (issue #60 案C); calling open() here re-runs the
      //      instance start and fails with
      //      "open is not allowed in state STARTING" on the shared row.
      const state = await this.deps.runtime.completeRestore();
      this.deps.health.setReady();
      this.deps.metrics.recordDuration(
        METRIC_NAMES.workspaceRestoreDuration,
        this.deps.clock.nowMs() - startedMs,
        { workspaceId: config.workspaceId },
      );
      this.deps.logger.info("workspace.restore.completed", {
        workspaceId: config.workspaceId,
        instanceName: workspace.instanceName ?? config.instanceName,
      });
      // Issue #141: a previous generation's reason must not linger on a
      // healthy row. Conditional (one read, write only when needed) so the
      // common no-failure path costs no extra write.
      await this.clearRestoreErrorBestEffort();
      return { state, instanceName: config.instanceName };
    } catch (e) {
      this.deps.health.setRestoreFailed();
      // The token must never outlive a failed bootstrap.
      this.deps.bootstrapper.discardToken();
      // Issue #141 案1: the host owns the restore, so it records WHY it
      // failed into workspaces.last_error (pre-sanitized — never secrets).
      // Best-effort and guarded: only while the row is still RESTORE_FAILED
      // (a re-open may already own it), and never for an
      // IllegalTransitionError — that error means someone ELSE moved the row
      // (typically the control plane's concurrent mark), so overwriting their
      // reason with bookkeeping noise would destroy the real diagnosis.
      const reason = summarizeRestoreError(e);
      if (!(e instanceof IllegalTransitionError)) {
        try {
          const current = await this.deps.repository.getWorkspace(config.workspaceId);
          if (current && current.runtimeState === "RESTORE_FAILED") {
            await this.deps.repository.updateWorkspace(config.workspaceId, { lastError: reason });
          }
        } catch (persistError) {
          this.deps.logger.warn("workspace.restore.record-error-failed", {
            workspaceId: config.workspaceId,
            error: persistError instanceof Error ? persistError.message : String(persistError),
          });
        }
      }
      this.deps.logger.error("workspace.restore.failed", {
        workspaceId: config.workspaceId,
        error: e instanceof Error ? e.message : String(e),
        reason,
      });
      throw e;
    }
  }

  /**
   * Clears a previous generation's last_error after a successful restore.
   * Never throws: a failed clear must not fail a healthy recovery.
   */
  private async clearRestoreErrorBestEffort(): Promise<void> {
    const { config } = this.deps;
    try {
      const current = await this.deps.repository.getWorkspace(config.workspaceId);
      if (current?.lastError) {
        await this.deps.repository.updateWorkspace(config.workspaceId, { lastError: null });
      }
    } catch (e) {
      this.deps.logger.warn("workspace.restore.clear-error-failed", {
        workspaceId: config.workspaceId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/** Re-export so callers can catch the T5 typed error without importing internals. */
export type { CheckpointFailedError };
