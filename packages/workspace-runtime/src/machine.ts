import type { WorkspaceRuntimeState } from "./state.js";
import { assertTransition, canTransition } from "./state.js";
import type { TransactionalStateStore, WorkspaceStateTransaction } from "./store.js";

/**
 * The workspace state machine. All transitions go through the injected
 * transactional store so a transition and its persistence commit together
 * (実装手順書 section 4). Illegal transitions throw IllegalTransitionError.
 */
export class WorkspaceStateMachine {
  private current: WorkspaceRuntimeState;

  constructor(
    private readonly workspaceId: string,
    private readonly store: TransactionalStateStore,
    initial: WorkspaceRuntimeState = "STOPPED",
  ) {
    this.current = initial;
  }

  getState(): WorkspaceRuntimeState {
    return this.current;
  }

  /** Checks a transition without applying it. */
  canTransition(to: WorkspaceRuntimeState): boolean {
    return canTransition(this.current, to);
  }

  /**
   * Applies a transition through the transactional store. The optional
   * `persist` callback runs inside the same transaction as the state change.
   */
  async transition(
    to: WorkspaceRuntimeState,
    reason?: string,
    persist?: (tx: WorkspaceStateTransaction) => Promise<void>,
  ): Promise<void> {
    const from = this.current;
    assertTransition(from, to);
    await this.store.apply(this.workspaceId, from, to, reason, persist);
    this.current = to;
  }

  /**
   * Reloads the current state from the store (e.g. after another process
   * changed it). Adopt-only: a diverged store state is taken over, never
   * rejected — the issue #60 split-open handoff depends on this (a fresh
   * agent-host starts at STOPPED and must adopt STARTING/RESTORING from the
   * shared row). Divergence against a stale in-memory view is detected later
   * by the compare-and-set in transition()/store.apply(), which throws
   * IllegalTransitionError. Unknown workspaces (load() === null) keep the
   * in-memory state.
   */
  async reload(): Promise<WorkspaceRuntimeState> {
    const persisted = await this.store.load(this.workspaceId);
    if (persisted !== null) this.current = persisted;
    return this.current;
  }
}