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
import type { InstanceRuntime } from "@cloud-run-dsh/cloud-run-instance-client";
import type { SandboxManager } from "@cloud-run-dsh/cloud-run-sandbox";
import type { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import type { Logger, Metrics } from "@cloud-run-dsh/observability";
import { METRIC_NAMES } from "@cloud-run-dsh/observability";
import type { SessionEvent } from "@cloud-run-dsh/session-persistence-postgres";
import type { SessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import type {
  WorkspaceLifecycleSteps,
  WorkspaceRuntime,
} from "@cloud-run-dsh/workspace-runtime";
import type { AgentHostConfig } from "./config.js";
import { WorkspaceNotFoundError, InstanceNotHealthyError } from "./errors.js";
import type { HarnessComposition } from "./harness.js";
import type { WorkspaceBootstrapper } from "./bootstrap.js";
import type { HealthService } from "./health.js";

export interface LifecycleStepDeps {
  readonly config: AgentHostConfig;
  readonly instanceRuntime: InstanceRuntime;
  readonly bootstrapper: WorkspaceBootstrapper;
  readonly checkpointScheduler: CheckpointScheduler;
  readonly sandboxManager: SandboxManager;
  readonly harness: HarnessComposition;
  readonly repository: SessionPersistenceRepository;
}

/**
 * Maps the host collaborators onto the T8 WorkspaceLifecycleSteps seams.
 * Step order follows 仕様書 section 8 (the 実装手順書 section 30 bullet
 * "restore session metadata" is performed by `restoreHarness`, which runs
 * after `createSandbox` — matching the merged T8 runtime).
 */
export function buildLifecycleSteps(deps: LifecycleStepDeps): WorkspaceLifecycleSteps {
  return {
    waitForInstanceHealth: async () => {
      const info = await deps.instanceRuntime.get(deps.config.instanceName);
      if (info.state !== "READY") {
        throw new InstanceNotHealthyError(deps.config.instanceName, info.state);
      }
    },
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
   * Runs the restart recovery path (実装手順書 section 30). Refuses to run
   * when another controller still holds the lease (仕様書 section 26 item 8).
   */
  async recover(): Promise<RecoveryResult> {
    const startedMs = this.deps.clock.nowMs();
    const { config } = this.deps;

    this.deps.health.setRestoring();
    try {
      // 1. read WORKSPACE_ID (config) — non-empty is guaranteed by config parsing.

      // 2. controller lease (仕様書 section 26 item 8) — a second host for the
      //    same workspace is refused here.
      await this.deps.lease.acquire(config.workspaceId, config.controllerId, config.userId);

      // 3. DB metadata
      const workspace = await this.deps.repository.getWorkspace(config.workspaceId);
      if (!workspace) {
        throw new WorkspaceNotFoundError(config.workspaceId);
      }

      // 4-6. restore workspace / session metadata / create sandbox via the T8
      //      runtime, then report healthy.
      const state = await this.deps.runtime.open();
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
      return { state, instanceName: config.instanceName };
    } catch (e) {
      this.deps.health.setRestoreFailed();
      // The token must never outlive a failed bootstrap.
      this.deps.bootstrapper.discardToken();
      this.deps.logger.error("workspace.restore.failed", {
        workspaceId: config.workspaceId,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
}

/** Re-export so callers can catch the T5 typed error without importing internals. */
export type { CheckpointFailedError };
