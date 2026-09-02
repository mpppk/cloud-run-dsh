// Composition seams for the control-plane HTTP surface.
//
// The gateway composes the existing T4–T8 packages:
//   T4  @cloud-run-dsh/session-persistence-postgres (workspace/session/event store)
//   T6  @cloud-run-dsh/controller-lease (single-writer enforcement)
//   T8  @cloud-run-dsh/workspace-runtime (state machine, open/stop, idle, checkpoints)
//
// The server depends only on the narrow `WorkspaceRuntimeHandle` interface and
// the `RuntimeRegistry` seam, so route tests use fakes; the provided
// `WorkspaceRuntimeHandleAdapter` wraps the real T8 `WorkspaceRuntime`.

import type { Workspace } from "@cloud-run-dsh/session-persistence-postgres";
import type { SessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import type { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import type { WorkspaceRuntime } from "@cloud-run-dsh/workspace-runtime";
import type { ActivityKind } from "@cloud-run-dsh/workspace-runtime";
import type { AuthDeps } from "./auth.js";
import type { MembershipStore } from "./membership.js";

/**
 * The control-plane clock.
 *
 * IMPORTANT (composition requirement): this MUST be the two-method
 * checkpoint-style clock (`now()` + `nowMs()`, see
 * `@cloud-run-dsh/workspace-checkpoint`'s `Clock`), NOT the T6 one-method
 * `Clock` from `@cloud-run-dsh/controller-lease` (which only has `now()`).
 *
 * The T8 `WorkspaceRuntime` / `IdleManager` and the SSE stream timer call
 * `clock.nowMs()`; passing the T6 `systemClock` compiles (structural typing
 * makes the narrower T6 clock assignable where only `now()` is used) but
 * throws `TypeError: clock.nowMs is not a function` at runtime inside the
 * first successful `open()`. Requiring the wider interface here makes that
 * mistake a compile error instead. Use `SystemClock` (provided below) or a
 * fake implementing both methods in tests.
 */
export interface ControlPlaneClock {
  now(): Date;
  nowMs(): number;
}

/** Production clock satisfying both T6 and T8/checkpoint clock interfaces. */
export class SystemClock implements ControlPlaneClock {
  now(): Date {
    return new Date();
  }
  nowMs(): number {
    return Date.now();
  }
}

/**
 * Narrow view of the T8 WorkspaceRuntime used by the gateway.
 * Open coalescing, agent-input gating and meaningful-activity reporting all
 * delegate to the runtime (実装手順書 sections 27/28).
 */
export interface WorkspaceRuntimeHandle {
  open(): Promise<string>;
  stop(): Promise<string>;
  getState(): string;
  /** Meaningful-activity reporting; NEVER called for SSE heartbeats etc. (仕様書 section 11). */
  recordActivity(kind: ActivityKind): void;
  /** Throws when the workspace state refuses agent input (e.g. RESTORE_FAILED). */
  assertAgentInputAllowed(): void;
  /** Runs a manual checkpoint as a meaningful, tracked operation. */
  runManualCheckpoint(): Promise<void>;
}

/**
 * Wraps a real T8 WorkspaceRuntime into the gateway handle.
 *
 * IMPORTANT: the wrapped `WorkspaceRuntime` (and its `IdleManager` /
 * transactional store) must have been constructed with a TWO-method clock
 * (`now()` + `nowMs()` — the checkpoint-style `Clock`). Constructing the
 * runtime with the T6 one-method `systemClock` compiles but throws
 * `TypeError: clock.nowMs is not a function` inside the first successful
 * `open()`; pass a `SystemClock` (or equivalent) instead.
 */
export class WorkspaceRuntimeHandleAdapter implements WorkspaceRuntimeHandle {
  constructor(
    private readonly runtime: WorkspaceRuntime,
    /** Per-workspace checkpoint work composed from the T5 checkpoint bundle. */
    private readonly checkpointFn: () => Promise<void>,
  ) {}

  open(): Promise<string> {
    return this.runtime.open();
  }

  stop(): Promise<string> {
    return this.runtime.stop();
  }

  getState(): string {
    return this.runtime.getState();
  }

  recordActivity(kind: ActivityKind): void {
    this.runtime.recordActivity(kind);
  }

  assertAgentInputAllowed(): void {
    this.runtime.assertAgentInputAllowed();
  }

  runManualCheckpoint(): Promise<void> {
    return this.runtime.runCheckpoint(this.checkpointFn);
  }
}

/**
 * Lazily creates one handle per workspace. Tests can `set()` fakes directly.
 */
export class RuntimeRegistry {
  private readonly handles = new Map<string, WorkspaceRuntimeHandle>();

  constructor(
    private readonly factory: (workspace: Workspace) => WorkspaceRuntimeHandle,
  ) {}

  async get(workspace: Workspace): Promise<WorkspaceRuntimeHandle> {
    let handle = this.handles.get(workspace.id);
    if (!handle) {
      handle = this.factory(workspace);
      this.handles.set(workspace.id, handle);
    }
    return handle;
  }

  set(workspaceId: string, handle: WorkspaceRuntimeHandle): void {
    this.handles.set(workspaceId, handle);
  }

  has(workspaceId: string): boolean {
    return this.handles.has(workspaceId);
  }
}

export interface ControlPlaneDeps extends AuthDeps {
  /** T4 repository (workspace/session/event persistence). */
  readonly repo: SessionPersistenceRepository;
  /** T6 controller lease service (controllersPerWorkspace = 1). */
  readonly leases: ControllerLeaseService;
  /** Workspace membership store (authorization requires membership). */
  readonly membership: MembershipStore;
  /** Per-workspace runtime handles (T8 composition). */
  readonly runtimes: RuntimeRegistry;
  /**
   * Two-method clock (`now()` + `nowMs()`). See `ControlPlaneClock` above:
   * the T6 one-method `systemClock` is NOT sufficient — the T8 runtime and
   * the SSE timer call `nowMs()`. Use `SystemClock`.
   */
  readonly clock: ControlPlaneClock;
  /** SSE event polling interval in ms (default 500). */
  readonly ssePollIntervalMs?: number;
  /** SSE idle heartbeat interval in ms (default 15000). Heartbeats are NOT activity. */
  readonly sseHeartbeatMs?: number;
}
