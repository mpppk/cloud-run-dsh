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
import type { Logger } from "@cloud-run-dsh/observability";
import type { AuthDeps } from "./auth.js";
import type { MembershipStore } from "./membership.js";
import type { ForwardIdentity, MessageForwarder } from "./forwarding.js";

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
  /**
   * Stops the workspace. The optional identity is the stop request's REAL
   * caller (handlers.stopWorkspace passes ctx.user): the production handle
   * forwards it to the agent-host prepare-stop route so the host can run
   * its gateway check. It is never fabricated — when absent the remote
   * preparation is skipped only where no forwarder is wired (tests); with
   * a forwarder wired, a missing identity fails the stop closed (issue #72).
   */
  stop(identity?: ForwardIdentity): Promise<string>;
  getState(): string;
  /** Meaningful-activity reporting; NEVER called for SSE heartbeats etc. (仕様書 section 11). */
  recordActivity(kind: ActivityKind): void;
  /**
   * Throws when the workspace state refuses agent input (e.g. RESTORE_FAILED).
   *
   * Issue #122: async because the gate reloads the persisted row first, so
   * it never disagrees with GET /v1/workspaces/:id (which reads the same
   * row) over a stale in-memory cache. Callers must await it.
   */
  assertAgentInputAllowed(): Promise<void>;
  /**
   * Runs a manual checkpoint as a meaningful, tracked operation. Same
   * identity rule as stop(): the real caller, forwarded to the agent-host
   * checkpoint route (issue #75).
   *
   * Returns whether the host skipped writing a new snapshot (clean tree —
   * still success, issue #89): the handler surfaces it as `skipped` so API
   * callers can tell a real snapshot apart from a clean-tree skip.
   */
  runManualCheckpoint(identity?: ForwardIdentity): Promise<{ skipped: boolean }>;
  /**
   * Deletes the workspace's Cloud Run Instance (issue #85 GC path: the
   * time-based reaper and DELETE /v1/workspaces/:id). Idempotent: a missing
   * Instance resolves successfully (the desired end state — no Instance —
   * already holds, same rationale as EnsureCreatedInstanceRuntime.stop).
   * Never deletes anything but this workspace's own Instance.
   */
  deleteInstance(): Promise<void>;
  /**
   * Returns the reachable URL of the workspace's Cloud Run Instance, or null
   * when the workspace has never been opened (or the Instance is unknown).
   *
   * CONTRACT FOR #22 (control-plane -> agent-host forwarding): this is the
   * seam #22 uses to reach the agent-host gateway. It resolves the live URL
   * from the Instances API when possible and falls back to the last URL
   * persisted on the workspace row (`workspaces.instance_url`, written on
   * every successful open). Prefer this over reading the DB directly — the
   * live lookup survives Instance recreation (which changes the URL).
   */
  getInstanceUrl(): Promise<string | null>;
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
    /**
     * Per-workspace checkpoint work composed from the T5 checkpoint bundle.
     * Returns the host's skip flag (issue #89) so runManualCheckpoint can
     * report it; the T8 runtime passes the value through untouched.
     */
    private readonly checkpointFn: () => Promise<{ skipped: boolean }>,
    /**
     * Resolves the workspace's Instance URL for #22 forwarding. Optional so
     * existing call sites (route tests with stub handles) keep working; the
     * production factory always supplies it. Defaults to null.
     */
    private readonly instanceUrlProvider?: () => Promise<string | null>,
    /**
     * Receives the request caller's identity for remote lifecycle calls
     * (issue #72). The steps are built at registry-construction time when
     * no caller exists yet, so the identity arrives here per call and is
     * handed to the factory-owned box. Last-writer-wins among legitimate
     * callers; the host only checks the header's presence plus the
     * workspace match (invoker IAM is the trust root), so a concurrent
     * second caller joining the coalesced stop() changes nothing material.
     */
    private readonly identitySink?: (identity: ForwardIdentity | undefined) => void,
    /**
     * Deletes the workspace's Cloud Run Instance (issue #85). Optional so
     * existing call sites (route tests with stub handles, the dev server)
     * keep working without wiring a deleter; the production factory always
     * supplies it. Defaults to a no-op.
     */
    private readonly deleteInstanceFn?: () => Promise<void>,
  ) {}

  /**
   * Issue #60 案C: the control plane drives ONLY the instance lifecycle and
   * the health observation (openInstance: STOPPED -> STARTING, start, poll
   * the agent-host readiness endpoint; issue #68). The RESTORING -> READY
   * state transitions on the shared row belong
   * to the agent-host's completeRestore(); running the full open() here is
   * the state-machine half of the #60 collision. The final reload observes
   * the state the agent-host persisted — READY once its recovery completes.
   */
  async open(): Promise<string> {
    await this.runtime.openInstance();
    return this.runtime.reloadState();
  }

  stop(identity?: ForwardIdentity): Promise<string> {
    this.identitySink?.(identity);
    return this.runtime.stop();
  }

  getState(): string {
    return this.runtime.getState();
  }

  recordActivity(kind: ActivityKind): void {
    this.runtime.recordActivity(kind);
  }

  assertAgentInputAllowed(): Promise<void> {
    return this.runtime.assertAgentInputAllowed();
  }

  runManualCheckpoint(identity?: ForwardIdentity): Promise<{ skipped: boolean }> {
    this.identitySink?.(identity);
    return this.runtime.runCheckpoint(this.checkpointFn);
  }

  deleteInstance(): Promise<void> {
    return this.deleteInstanceFn?.() ?? Promise.resolve();
  }

  getInstanceUrl(): Promise<string | null> {
    return this.instanceUrlProvider?.() ?? Promise.resolve(null);
  }
}

/**
 * Lazily creates one handle per workspace. Tests can `set()` fakes directly.
 *
 * Issue #60: the factory takes the controllerId the open-established lease
 * carries, so the Instance env it bakes matches the lease the agent-host
 * will adopt. A cached handle is rebuilt when a LATER open resolves a
 * DIFFERENT lease (e.g. expiry + re-acquire): serving the old env would boot
 * the host with a fenced-off identity. Calls without a controllerId (stop,
 * message flows) always reuse the cached handle.
 */
export class RuntimeRegistry {
  private readonly handles = new Map<
    string,
    { handle: WorkspaceRuntimeHandle; controllerId: string | undefined; pinned: boolean }
  >();

  constructor(
    private readonly factory: (
      workspace: Workspace,
      controllerId?: string,
    ) => WorkspaceRuntimeHandle,
  ) {}

  async get(workspace: Workspace, controllerId?: string): Promise<WorkspaceRuntimeHandle> {
    const cached = this.handles.get(workspace.id);
    if (
      cached &&
      (cached.pinned || controllerId === undefined || cached.controllerId === controllerId)
    ) {
      return cached.handle;
    }
    const handle = this.factory(workspace, controllerId);
    this.handles.set(workspace.id, { handle, controllerId, pinned: false });
    return handle;
  }

  /**
   * Injects a handle directly (test seam). A set() handle is pinned: later
   * get() calls reuse it even when they carry a controllerId, so route tests
   * with stub handles never hit the production factory.
   */
  set(workspaceId: string, handle: WorkspaceRuntimeHandle): void {
    this.handles.set(workspaceId, { handle, controllerId: undefined, pinned: true });
  }

  has(workspaceId: string): boolean {
    return this.handles.has(workspaceId);
  }
}

/**
 * Readiness report served by GET /readyz. Unlike /livez (liveness: the
 * process is up), readiness honestly reflects degraded capability —
 * e.g. the database being unreachable. (An earlier revision named "the
 * production runtime registry being a placeholder" as the example; the
 * placeholder was removed in #23, so the example was updated.)
 *
 * Issue #97: this honesty is load-bearing, not aspirational. Production
 * wires a real database probe here (createDbReadinessProbe in
 * prod-adapters.ts); a deployment whose database is unreachable answers
 * 503, never 200, so Cloud Run withholds traffic instead of serving 500s
 * behind a "ready" badge.
 */
export interface ControlPlaneReadiness {
  readonly ready: boolean;
  /** Human-readable reason when not ready. Never contains secrets. */
  readonly reason?: string;
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
  /**
   * Optional readiness probe (GET /readyz). When absent, /readyz reports
   * ready. When present it must report honestly — a control plane that has
   * lost its database reports NOT ready with the reason.
   *
   * May be async: the production database probe (issue #97) issues a
   * short-timeout `SELECT 1` and the server awaits it before answering.
   */
  readonly readiness?: () => ControlPlaneReadiness | Promise<ControlPlaneReadiness>;
  /**
   * Forwards appended events to the workspace Instance (issues #22/#39:
   * `user_message` + `approval` + `cancel`). Optional so unit tests and the
   * local dev server (which have no Instance) keep the append-only 201
   * behavior; production always supplies it. When present and the Instance
   * has no URL, the handlers answer 409 (open first); when the forward
   * itself fails they answer 502. The control plane stays the SOLE writer
   * of all three event types — the host never appends them.
   */
  readonly messageForwarder?: MessageForwarder;
  /** Structured logger for forward-failure traceability (never carries tokens). */
  readonly logger?: Logger;
}
