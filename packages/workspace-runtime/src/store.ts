import type { WorkspaceRuntimeState } from "./state.js";
import { IllegalTransitionError } from "./state.js";
import { SystemClock, type Clock } from "@cloud-run-dsh/workspace-checkpoint";

/**
 * Record persisted atomically together with every state transition
 * (実装手順書 section 4: state transitionをDB transactionで管理する).
 */
export interface TransitionRecord {
  readonly workspaceId: string;
  readonly from: WorkspaceRuntimeState;
  readonly to: WorkspaceRuntimeState;
  readonly at: Date;
  readonly reason?: string;
}

/**
 * Handle inside an open transaction. Data persisted here commits together
 * with the state transition — either both land or neither does.
 */
export interface WorkspaceStateTransaction {
  readonly record: TransitionRecord;
  persist(data: unknown): Promise<void>;
}

/**
 * Injected transactional store (実装手順書 section 4). The transition and its
 * persistence must commit together in one transaction.
 */
export interface TransactionalStateStore {
  /** Load the persisted state for a workspace. Returns null when unknown. */
  load(workspaceId: string): Promise<WorkspaceRuntimeState | null>;
  /**
   * Atomically move the workspace state from `from` to `to` and run the
   * optional persistence callback inside the same transaction.
   * Throws IllegalTransitionError when the persisted state is not `from`.
   */
  apply(
    workspaceId: string,
    from: WorkspaceRuntimeState,
    to: WorkspaceRuntimeState,
    reason: string | undefined,
    persist?: (tx: WorkspaceStateTransaction) => Promise<void>,
  ): Promise<void>;
}

/**
 * In-memory implementation of TransactionalStateStore. Transitions are
 * serialized per workspace and illegal transitions are rejected against the
 * CURRENT persisted state (not the caller's optimistic snapshot), mirroring
 * the concurrency semantics of a real SQL transaction. Persisted writes are
 * buffered per transaction and appended only on commit, so an aborted
 * transaction leaves nothing behind (SQL rollback semantics).
 */
export class InMemoryTransactionalStore implements TransactionalStateStore {
  private readonly states = new Map<string, WorkspaceRuntimeState>();
  private readonly history: TransitionRecord[] = [];
  private readonly persisted: Array<{ record: TransitionRecord; data: unknown }> = [];
  private readonly locks = new Map<string, Promise<void>>();
  private readonly clock: Clock;

  constructor(
    initial?: Record<string, WorkspaceRuntimeState>,
    clock: Clock = new SystemClock(),
  ) {
    this.clock = clock;
    if (initial) {
      for (const [id, state] of Object.entries(initial)) this.states.set(id, state);
    }
  }

  async load(workspaceId: string): Promise<WorkspaceRuntimeState | null> {
    return this.states.get(workspaceId) ?? null;
  }

  async apply(
    workspaceId: string,
    from: WorkspaceRuntimeState,
    to: WorkspaceRuntimeState,
    reason: string | undefined,
    persist?: (tx: WorkspaceStateTransaction) => Promise<void>,
  ): Promise<void> {
    // Serialize transactions per workspace (a real DB transaction lock).
    const prev = this.locks.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(workspaceId, prev.then(() => gate));
    try {
      await prev;
    } catch {
      // prior transition failure must not poison the queue
    }
    try {
      const current = this.states.get(workspaceId) ?? "STOPPED";
      if (current !== from) {
        throw new IllegalTransitionError(current, to);
      }
      const record: TransitionRecord = {
        workspaceId,
        from,
        to,
        at: this.clock.now(),
        reason,
      };
      // Buffer persist writes per transaction; they are appended to the log
      // only when the transaction commits, so a throwing persist callback
      // leaves nothing behind (rollback semantics).
      const pendingWrites: Array<{ record: TransitionRecord; data: unknown }> = [];
      const tx: WorkspaceStateTransaction = {
        record,
        persist: async (data) => {
          pendingWrites.push({ record, data });
        },
      };
      if (persist) await persist(tx);
      this.states.set(workspaceId, to);
      this.history.push(record);
      for (const write of pendingWrites) this.persisted.push(write);
    } finally {
      release();
    }
  }

  /** Test helper: full transition history. */
  getHistory(): readonly TransitionRecord[] {
    return this.history;
  }

  /** Test helper: everything persisted inside transactions. */
  getPersisted(): readonly { record: TransitionRecord; data: unknown }[] {
    return this.persisted;
  }

  /** Test helper: clears the transition history. */
  clearHistory(): void {
    this.history.length = 0;
    this.persisted.length = 0;
  }
}