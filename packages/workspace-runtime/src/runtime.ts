import type { Clock } from "@cloud-run-dsh/workspace-checkpoint";
import type { InstanceRuntime } from "@cloud-run-dsh/cloud-run-instance-client";
import type { TransactionalStateStore } from "./store.js";
import type { WorkspaceRuntimeState } from "./state.js";
import { IllegalTransitionError, isAgentInputAllowed } from "./state.js";
import { WorkspaceStateMachine } from "./machine.js";
import { IdleManager } from "./idle.js";

/** Typed error thrown when agent input arrives in a state that refuses it (仕様書 section 8). */
export class AgentInputRefusedError extends Error {
  readonly name = "AgentInputRefusedError";
  constructor(public readonly state: WorkspaceRuntimeState) {
    super(`agent input refused in state ${state}`);
  }
}

/** Typed error thrown when open/stop is called from a state that forbids it. */
export class InvalidOperationError extends Error {
  readonly name = "InvalidOperationError";
  constructor(
    public readonly operation: string,
    public readonly state: WorkspaceRuntimeState,
  ) {
    super(`${operation} is not allowed in state ${state}`);
  }
}

/**
 * Injected lifecycle collaborators. Each step is a pure seam so tests can use
 * fakes; production wires them to the checkpoint package, sandbox manager,
 * session persistence and Cloud Run instance client.
 */
export interface WorkspaceLifecycleSteps {
  /** git clone (仕様書 section 8). */
  cloneRepository(): Promise<void>;
  /** checkout base commit (仕様書 section 8). */
  checkoutBase(): Promise<void>;
  /** checkpoint download + git apply + untracked restore (実装手順書 section 22). */
  restoreCheckpoint(): Promise<void>;
  /** create the workspace sandbox. */
  createSandbox(): Promise<void>;
  /** restore the harness session. */
  restoreHarness(): Promise<void>;
  /** lifecycle checkpoint — must throw on failure (実装手順書 section 29). */
  runLifecycleCheckpoint(): Promise<void>;
  /** flush append-only session persistence. */
  flushSessionPersistence(): Promise<void>;
  /** delete the sandbox. */
  deleteSandbox(): Promise<void>;
}

export interface WorkspaceRuntimeDeps {
  readonly workspaceId: string;
  readonly store: TransactionalStateStore;
  readonly clock: Clock;
  readonly instanceRuntime: InstanceRuntime;
  readonly instanceName: string;
  readonly steps: WorkspaceLifecycleSteps;
  readonly idle: IdleManager;
}

/** Tracks in-flight operations so graceful stop can wait for them (実装手順書 section 29). */
export class OperationTracker {
  private pending = 0;
  private waiters: (() => void)[] = [];

  count(): number {
    return this.pending;
  }

  /** Runs `fn` as a tracked operation. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.begin();
    try {
      return await fn();
    } finally {
      this.end();
    }
  }

  /** Manually opens a tracked operation (e.g. an in-flight agent turn). */
  begin(): void {
    this.pending++;
  }

  /** Manually closes a tracked operation opened with begin(); resolves waiters at zero. */
  end(): void {
    this.pending--;
    if (this.pending === 0) {
      const waiters = this.waiters.splice(0);
      for (const w of waiters) w();
    }
  }

  /** Resolves when no operations are pending. */
  async waitAll(): Promise<void> {
    if (this.pending === 0) return;
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

/**
 * Workspace runtime core: state machine, restore orchestration (仕様書 section 8),
 * graceful stop (実装手順書 section 29) and coalesced open (実装手順書 section 27).
 * All collaborators are injected; tests use fakes only.
 */
export class WorkspaceRuntime {
  private readonly machine: WorkspaceStateMachine;
  private readonly operations = new OperationTracker();
  private openPromise: Promise<WorkspaceRuntimeState> | null = null;
  private openInstancePromise: Promise<WorkspaceRuntimeState> | null = null;
  private completeRestorePromise: Promise<WorkspaceRuntimeState> | null = null;
  private stopPromise: Promise<WorkspaceRuntimeState> | null = null;
  private prepareStopPromise: Promise<WorkspaceRuntimeState> | null = null;
  private lastError: unknown = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private agentTurnActive = false;

  constructor(private readonly deps: WorkspaceRuntimeDeps) {
    this.machine = new WorkspaceStateMachine(deps.workspaceId, deps.store);
  }

  /**
   * States from which a fresh instance start is legal. Shared by open() and
   * openInstance() (issue #60): STOPPED plus the recoverable failure states.
   */
  private static readonly OPENABLE_STATES: ReadonlySet<WorkspaceRuntimeState> = new Set([
    "STOPPED",
    "RESTORE_FAILED",
    "ERROR",
    "CHECKPOINT_FAILED",
  ]);

  /**
   * States from which the agent-host restore phase may run (issue #60 案D).
   * STARTING is the normal handoff from the control plane's openInstance();
   * RESTORING resumes a host that crashed mid-restore (Cloud Run restarts the
   * container with the same env); the failure states cover a host rebooted
   * without a control-plane open. STOPPED is deliberately absent: a host
   * process running while the workspace is STOPPED means the control plane
   * never started this generation — proceeding would resurrect a stopped
   * workspace behind the control plane's back.
   */
  private static readonly RESTORABLE_STATES: ReadonlySet<WorkspaceRuntimeState> = new Set([
    "STARTING",
    "RESTORING",
    "RESTORE_FAILED",
    "ERROR",
    "CHECKPOINT_FAILED",
  ]);

  getWorkspaceId(): string {
    return this.deps.workspaceId;
  }

  getState(): WorkspaceRuntimeState {
    return this.machine.getState();
  }

  getLastError(): unknown {
    return this.lastError;
  }

  pendingOperationCount(): number {
    return this.operations.count();
  }

  /** Syncs state with the persisted store. */
  async reloadState(): Promise<WorkspaceRuntimeState> {
    return this.machine.reload();
  }

  /**
   * Opens the workspace: STARTING -> instance start -> RESTORING ->
   * clone -> checkout base -> restore checkpoint -> create sandbox ->
   * restore harness -> READY (仕様書 section 8, 実装手順書 sections 19/22/27).
   *
   * Issue #136: the start phase NO LONGER waits for agent-host readiness.
   * Readiness observation used to live here (a minutes-long poll of the
   * Instance URL), which forced POST /open to hold its request for up to ~6
   * minutes. The completion authority is now the agent-host's
   * completeRestore() persisting READY on the shared row; clients learn it
   * by polling GET /v1/workspaces/:id, and a STARTING/RESTORING row older
   * than the stale threshold is failed lazily at read time (案A — no
   * background waiter, so Cloud Run CPU throttling cannot break it).
   *
   * Concurrent open requests coalesce into a single start operation
   * (実装手順書 section 27). An already-READY workspace resolves immediately.
   *
   * Single-process convenience: this is exactly openInstance() followed by
   * completeRestore(). In production the two phases run in DIFFERENT
   * processes against the SAME row (control plane, then agent-host — issue
   * #60), so each side calls only its own phase.
   */
  async open(): Promise<WorkspaceRuntimeState> {
    if (this.openPromise) return this.openPromise;

    this.openPromise = this.doOpen().finally(() => {
      this.openPromise = null;
    });
    return this.openPromise;
  }

  private async doOpen(): Promise<WorkspaceRuntimeState> {
    await this.doStartInstancePhase();
    return this.doCompleteRestorePhase();
  }

  /**
   * Control-plane phase (issue #60 案C, issue #136 async open): STOPPED ->
   * STARTING, then the instance start API call. Returns while still STARTING
   * — the RESTORING -> READY transitions belong to the agent-host's
   * completeRestore(), and readiness observation NO LONGER happens here
   * (#136: the old in-request health poll held POST /open for minutes, so it
   * was removed; the request now covers only the fast instance start).
   *
   * Concurrent calls coalesce into a single start operation (実装手順書
   * section 27), same as open().
   */
  async openInstance(): Promise<WorkspaceRuntimeState> {
    if (this.openInstancePromise) return this.openInstancePromise;

    this.openInstancePromise = this.doStartInstancePhase().finally(() => {
      this.openInstancePromise = null;
    });
    return this.openInstancePromise;
  }

  /**
   * Agent-host phase (issue #60 案D): from STARTING (handed off by the control
   * plane's openInstance()) through RESTORING and the restore steps to READY.
   * Must NOT be called from STOPPED — that state means the control plane never
   * started this generation. Calling open() here instead would re-run the
   * instance start and collide with the control plane on the shared row
   * (InvalidOperationError: open is not allowed in state STARTING).
   *
   * Concurrent calls coalesce into a single restore operation.
   */
  async completeRestore(): Promise<WorkspaceRuntimeState> {
    if (this.completeRestorePromise) return this.completeRestorePromise;

    this.completeRestorePromise = this.doCompleteRestorePhase().finally(() => {
      this.completeRestorePromise = null;
    });
    return this.completeRestorePromise;
  }

  private async doStartInstancePhase(): Promise<WorkspaceRuntimeState> {
    await this.machine.reload();
    const state = this.machine.getState();

    if (state === "READY") return state;

    // open is legal from STOPPED plus the recoverable failure states
    // (RESTORE_FAILED / ERROR / CHECKPOINT_FAILED -> STARTING edges exist).
    if (!WorkspaceRuntime.OPENABLE_STATES.has(state)) {
      throw new InvalidOperationError("open", state);
    }

    await this.machine.transition("STARTING", "open");
    try {
      // Issue #136: ONLY the fast instance start runs in-request. Readiness
      // used to be polled here (waitForInstanceHealth, minutes) — it now
      // belongs to the agent-host phase, so open() answers within seconds.
      await this.deps.instanceRuntime.start(this.deps.instanceName);
      // Intentionally STAYS in STARTING: the agent-host drives
      // STARTING -> RESTORING -> READY via completeRestore() (issue #60).
      return this.machine.getState();
    } catch (e) {
      this.lastError = e;
      await this.recordFailureStateBestEffort(e, "RESTORE_FAILED", "restore-failed");
      throw e;
    }
  }

  private async doCompleteRestorePhase(): Promise<WorkspaceRuntimeState> {
    await this.machine.reload();
    const state = this.machine.getState();

    if (state === "READY") return state;

    if (!WorkspaceRuntime.RESTORABLE_STATES.has(state)) {
      throw new InvalidOperationError("open", state);
    }

    try {
      // A retry from a failure state re-enters through STARTING (the table
      // has no direct failure -> RESTORING edge); a crash resume from
      // RESTORING continues the steps directly.
      if (state !== "STARTING" && state !== "RESTORING") {
        await this.machine.transition("STARTING", "open");
      }
      if (this.machine.getState() === "STARTING") {
        await this.machine.transition("RESTORING", "instance-healthy");
      }
      // 仕様書 section 8: clone -> base checkout -> checkpoint restore ->
      // sandbox create -> harness restore -> READY
      await this.deps.steps.cloneRepository();
      await this.deps.steps.checkoutBase();
      await this.deps.steps.restoreCheckpoint();
      await this.deps.steps.createSandbox();
      await this.deps.steps.restoreHarness();
      await this.machine.transition("READY", "restore-complete");
      this.lastError = null;
      this.deps.idle.recordActivity("workspace_operation");
      return this.machine.getState();
    } catch (e) {
      this.lastError = e;
      await this.recordFailureStateBestEffort(e, "RESTORE_FAILED", "restore-failed");
      throw e;
    }
  }

  /**
   * Best-effort failure-state bookkeeping shared by the open/stop catch
   * blocks (issue #63). Never throws and never replaces the original error:
   * the caller always rethrows (or returns after) the original failure.
   *
   * Two hazards made the old inline `transition()` calls lose the real cause
   * on the shared row (issue #60):
   * - Stale view: this runtime's in-memory state can lag the row (e.g. the
   *   agent-host already recorded RESTORE_FAILED while the control plane was
   *   still polling health in STARTING). The row is reloaded first and the
   *   transition is attempted only while still legal — otherwise there is
   *   nothing left to record.
   * - Lost race: the row can move between the reload and the compare-and-set
   *   apply. A failing bookkeeping transition is then attached as `cause` on
   *   the original error — but ONLY when it is an IllegalTransitionError,
   *   which carries nothing but state names. Any other bookkeeping failure
   *   (e.g. the store read itself failing, which could carry connection
   *   details) is dropped silently so no secret-adjacent payload is chained
   *   onto errors that end up in structured logs.
   */
  private async recordFailureStateBestEffort(
    originalError: unknown,
    to: WorkspaceRuntimeState,
    reason: string,
  ): Promise<void> {
    try {
      await this.machine.reload();
      if (!this.machine.canTransition(to)) return;
      await this.machine.transition(to, reason);
    } catch (bookkeepingError) {
      if (
        originalError instanceof Error &&
        originalError.cause === undefined &&
        bookkeepingError instanceof IllegalTransitionError
      ) {
        originalError.cause = bookkeepingError;
      }
    }
  }

  /**
   * Agent input gate (仕様書 section 8: 復元失敗時はAgent入力を受け付けない).
   *
   * Issue #122: reloads the persisted row FIRST. This runtime's in-memory
   * view can lag the row when another process changed it — e.g. the control
   * plane recorded RESTORE_FAILED, then the agent-host recovered late and
   * persisted READY. Without the reload the gate keeps throwing
   * AgentInputRefusedError(RESTORE_FAILED) while GET (which reads the row)
   * answers READY. The reload is adopt-only (machine.reload) and every
   * transition below still goes through the store compare-and-set, so a
   * fresher in-memory state is never clobbered into something older here —
   * the row is the single source of truth both readers agree on.
   */
  async assertAgentInputAllowed(): Promise<void> {
    const state = await this.machine.reload();
    if (!isAgentInputAllowed(state)) {
      throw new AgentInputRefusedError(state);
    }
  }

  /** READY -> BUSY. Refused while restoring/stopping (仕様書 section 8). */
  async beginAgentTurn(): Promise<void> {
    await this.assertAgentInputAllowed();
    if (this.machine.getState() !== "READY") {
      throw new InvalidOperationError("beginAgentTurn", this.machine.getState());
    }
    await this.machine.transition("BUSY", "agent-turn-start");
    // The turn is a tracked operation so a concurrent stop() drains it
    // before running the lifecycle checkpoint (実装手順書 section 29).
    this.agentTurnActive = true;
    this.operations.begin();
    this.deps.idle.setAgentRunning(true);
    this.deps.idle.recordActivity("agent_turn");
  }

  /**
   * BUSY -> READY. Also succeeds while STOPPING, where it is exactly the
   * drain completing (実装手順書 section 29); no state transition is made
   * because STOPPING has no edge back to READY.
   */
  async endAgentTurn(): Promise<void> {
    if (!this.agentTurnActive) {
      throw new InvalidOperationError("endAgentTurn", this.machine.getState());
    }
    const state = this.machine.getState();
    if (state === "BUSY") {
      await this.machine.transition("READY", "agent-turn-complete");
    } else if (state !== "STOPPING") {
      throw new InvalidOperationError("endAgentTurn", state);
    }
    this.agentTurnActive = false;
    this.operations.end();
    this.deps.idle.setAgentRunning(false);
    this.deps.idle.recordActivity("agent_turn");
  }

  /** Runs an agent-driven tool invocation as a meaningful, tracked operation. */
  async runToolInvocation<T>(fn: () => Promise<T>): Promise<T> {
    await this.assertAgentInputAllowed();
    this.deps.idle.recordActivity("tool_invocation");
    return this.operations.run(fn);
  }

  /** Runs a subprocess as a meaningful, tracked operation. */
  async runSubprocess<T>(fn: () => Promise<T>): Promise<T> {
    await this.assertAgentInputAllowed();
    this.deps.idle.recordActivity("subprocess");
    this.deps.idle.setSubprocessRunning(true);
    try {
      return await this.operations.run(fn);
    } finally {
      this.deps.idle.setSubprocessRunning(false);
    }
  }

  /** Runs a checkpoint as a meaningful, tracked operation. */
  async runCheckpoint<T>(fn: () => Promise<T>): Promise<T> {
    await this.assertAgentInputAllowed();
    this.deps.idle.setCheckpointRunning(true);
    try {
      const result = await this.operations.run(fn);
      this.deps.idle.recordActivity("checkpoint");
      return result;
    } finally {
      this.deps.idle.setCheckpointRunning(false);
    }
  }

  /**
   * Graceful stop (実装手順書 section 29):
   * prepareStop() (STOPPING -> reject new agent turns -> wait running
   * operations -> checkpoint -> flush session persistence -> delete sandbox)
   * followed by the Cloud Run instance stop -> STOPPED.
   *
   * If the lifecycle checkpoint fails the runtime goes to CHECKPOINT_FAILED
   * and does NOT call instance stop.
   */
  async stop(): Promise<WorkspaceRuntimeState> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.doStop().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async doStop(): Promise<WorkspaceRuntimeState> {
    const prepared = await this.prepareStop();
    // The checkpoint guard (issue #72): a failed lifecycle checkpoint leaves
    // CHECKPOINT_FAILED and the Cloud Run instance stop below must NOT run —
    // stopping now would discard in-memory files the checkpoint never saved.
    if (prepared === "CHECKPOINT_FAILED") return prepared;
    // Already stopped (or concurrently stopped): nothing left to do.
    if (prepared === "STOPPED") return prepared;

    try {
      await this.deps.instanceRuntime.stop(this.deps.instanceName);
    } catch (e) {
      this.lastError = e;
      await this.recordFailureStateBestEffort(e, "ERROR", "graceful-stop-failed");
      throw e;
    }

    await this.machine.transition("STOPPED", "graceful-stop-complete");
    return this.machine.getState();
  }

  /**
   * Stop preparation (issue #72): everything in stop() EXCEPT the Cloud Run
   * instance stop and the final STOPPED transition. The agent-host gateway
   * exposes this as `POST /workspaces/:id/prepare-stop` so the control plane
   * can drain turns, checkpoint the workspace and flush sessions INSIDE the
   * instance before stopping it from the outside. There is exactly ONE stop
   * sequence — stop() above delegates here, never a second copy.
   *
   * Entry states: the stoppable states (see canStopFrom) transition to
   * STOPPING first. Two re-entrant entries skip the transition:
   * - STOPPED: already stopped; returns immediately (idempotent).
   * - STOPPING: a previous stop marked the row but never finished (process
   *   crash between prepare and instance stop, or the control-plane-first
   *   flow where the control plane's own stop() marked STOPPING on the
   *   shared row before calling this remotely — issue #60 pattern). The
   *   steps re-run from the drain: the lifecycle checkpoint is the critical
   *   idempotent step, flush is a no-op, and the sandbox delete re-issues
   *   the CLI delete. This resume is strictly better than the old hard
   *   InvalidOperationError, which left STOPPING unrecoverable.
   *
   * Leaves the runtime in STOPPING on success. The caller owns the instance
   * stop that follows; a checkpoint failure leaves CHECKPOINT_FAILED instead
   * (and the caller must NOT stop the instance — see doStop).
   *
   * Restart-recovery note: a row left in STOPPING across an instance restart
   * is NOT restorable — completeRestore() accepts only STARTING/RESTORING
   * (+ failure states), so recovery refuses and health reports
   * restore-failed. That is deliberate: STOPPING means a stop tore down (or
   * is tearing down) the sandbox, so rebuilding workspace state underneath
   * it would be wrong. The way out is retrying the stop (STOPPING re-entry
   * above), which finishes the sequence to STOPPED.
   */
  async prepareStop(): Promise<WorkspaceRuntimeState> {
    if (this.prepareStopPromise) return this.prepareStopPromise;
    this.prepareStopPromise = this.doPrepareStop().finally(() => {
      this.prepareStopPromise = null;
    });
    return this.prepareStopPromise;
  }

  private async doPrepareStop(): Promise<WorkspaceRuntimeState> {
    await this.machine.reload();
    const state = this.machine.getState();
    if (state === "STOPPED") return state;
    if (state !== "STOPPING" && !canStopFrom(state)) {
      throw new InvalidOperationError("stop", state);
    }

    if (state !== "STOPPING") {
      await this.machine.transition("STOPPING", "graceful-stop");
    }
    // New agent turns and new agent-driven operations (tool invocation,
    // subprocess, checkpoint) are now refused: STOPPING is not an
    // agent-input-allowed state. In-flight work — including an active agent
    // turn registered by beginAgentTurn — is drained here BEFORE the
    // lifecycle checkpoint (実装手順書 section 29).
    await this.operations.waitAll();

    try {
      await this.deps.steps.runLifecycleCheckpoint();
      this.deps.idle.recordActivity("checkpoint");
    } catch (e) {
      this.lastError = e;
      // 実装手順書 section 29: checkpoint failure -> CHECKPOINT_FAILED,
      // Cloud Run stop must NOT be called.
      //
      // Recovery decision: we deliberately do NOT auto-recover to READY here.
      // Agent input stays refused after an aborted stop because the drain was
      // interrupted mid-way (sandbox still exists, session flush state is
      // unknown), so the only supported recovery is a full, clean re-open via
      // open() (CHECKPOINT_FAILED -> STARTING is a legal transition). The
      // CHECKPOINT_FAILED -> READY table edge exists for future deliberate
      // recovery wiring but is intentionally not exposed on the runtime.
      await this.recordFailureStateBestEffort(e, "CHECKPOINT_FAILED", "lifecycle-checkpoint-failed");
      return this.machine.getState();
    }

    try {
      await this.deps.steps.flushSessionPersistence();
      await this.deps.steps.deleteSandbox();
    } catch (e) {
      this.lastError = e;
      await this.recordFailureStateBestEffort(e, "ERROR", "graceful-stop-failed");
      throw e;
    }

    // Intentionally STAYS in STOPPING: the Cloud Run instance stop (and the
    // STOPPED transition) belong to the caller — stop() above, or the
    // control plane after a remote prepare-stop (issue #72).
    return this.machine.getState();
  }

  /**
   * Idle-driven stop entry point (実装手順書 section 28). Returns true when a
   * stop was initiated. Only stops from READY.
   */
  async maybeStopForIdle(): Promise<boolean> {
    if (this.machine.getState() !== "READY") return false;
    if (!this.deps.idle.shouldStop()) return false;
    await this.stop();
    return true;
  }

  /** Optional polling loop for production; tests drive maybeStopForIdle directly. */
  startIdlePolling(intervalMs: number, onStopped?: () => void): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.maybeStopForIdle().then((stopped) => {
        if (stopped) onStopped?.();
      });
    }, intervalMs);
    const t = this.idleTimer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }

  stopIdlePolling(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Report an explicit workspace operation (meaningful activity).
   * Non-meaningful sources (health check, SSE heartbeat, browser connection,
   * status polling, metrics collection) must never call this.
   */
  recordActivity: IdleManager["recordActivity"] = (kind) => {
    this.deps.idle.recordActivity(kind);
  };
}

function canStopFrom(state: WorkspaceRuntimeState): boolean {
  return ["READY", "BUSY", "CHECKPOINTING", "ERROR", "CHECKPOINT_FAILED", "RESTORE_FAILED"].includes(
    state,
  );
}