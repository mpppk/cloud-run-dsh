export type WorkspaceRuntimeState =
  | "STOPPED"
  | "STARTING"
  | "RESTORING"
  | "READY"
  | "BUSY"
  | "CHECKPOINTING"
  | "STOPPING"
  | "ERROR"
  | "RESTORE_FAILED"
  | "CHECKPOINT_FAILED";

export const WORKSPACE_RUNTIME_STATES: readonly WorkspaceRuntimeState[] = [
  "STOPPED",
  "STARTING",
  "RESTORING",
  "READY",
  "BUSY",
  "CHECKPOINTING",
  "STOPPING",
  "ERROR",
  "RESTORE_FAILED",
  "CHECKPOINT_FAILED",
];

/**
 * Explicit transition table implementing the state machine in 仕様書 section 9.
 *
 * Happy path:
 *   STOPPED -> STARTING -> RESTORING -> READY
 *   READY <-> BUSY, READY <-> CHECKPOINTING
 *   READY -> STOPPING -> STOPPED (after lifecycle checkpoint)
 *
 * Error states: ERROR, RESTORE_FAILED, CHECKPOINT_FAILED (仕様書 section 9).
 * - Any failure while STARTING/RESTORING lands in RESTORE_FAILED (仕様書 section 8).
 * - A lifecycle checkpoint failure during STOPPING lands in CHECKPOINT_FAILED
 *   and the instance stop must NOT be called (実装手順書 section 29).
 *
 * Recovery edges (not drawn in the spec diagram, required for operations):
 * - ERROR -> STARTING (restart) and ERROR -> STOPPING (cleanup).
 * - RESTORE_FAILED -> STARTING (retry open) and -> STOPPING (cleanup).
 * - CHECKPOINT_FAILED -> READY (stop was aborted, workspace still usable),
 *   -> STOPPING (retry stop), -> STARTING (restart).
 */
export const WORKSPACE_STATE_TRANSITIONS: Readonly<
  Record<WorkspaceRuntimeState, readonly WorkspaceRuntimeState[]>
> = {
  STOPPED: ["STARTING"],
  STARTING: ["RESTORING", "RESTORE_FAILED", "ERROR", "STOPPING"],
  RESTORING: ["READY", "RESTORE_FAILED", "ERROR", "STOPPING"],
  READY: ["BUSY", "CHECKPOINTING", "STOPPING", "ERROR"],
  BUSY: ["READY", "CHECKPOINTING", "STOPPING", "ERROR"],
  CHECKPOINTING: ["READY", "CHECKPOINT_FAILED", "ERROR", "STOPPING"],
  STOPPING: ["STOPPED", "CHECKPOINT_FAILED", "ERROR"],
  ERROR: ["STARTING", "STOPPING"],
  RESTORE_FAILED: ["STARTING", "STOPPING"],
  CHECKPOINT_FAILED: ["READY", "STARTING", "STOPPING"],
};

/** Typed error thrown for illegal state transitions (仕様書 section 9). */
export class IllegalTransitionError extends Error {
  readonly name = "IllegalTransitionError";

  constructor(
    public readonly from: WorkspaceRuntimeState,
    public readonly to: WorkspaceRuntimeState,
  ) {
    super(`illegal state transition: ${from} -> ${to}`);
  }
}

export function canTransition(
  from: WorkspaceRuntimeState,
  to: WorkspaceRuntimeState,
): boolean {
  return WORKSPACE_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Asserts the transition is legal; throws IllegalTransitionError otherwise. */
export function assertTransition(
  from: WorkspaceRuntimeState,
  to: WorkspaceRuntimeState,
): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

/** States from which agent input is refused (仕様書 section 8: 復元失敗時はAgent入力を受け付けない). */
export const AGENT_INPUT_REFUSED_STATES: readonly WorkspaceRuntimeState[] = [
  "STOPPED",
  "STARTING",
  "RESTORING",
  "STOPPING",
  "ERROR",
  "RESTORE_FAILED",
  "CHECKPOINT_FAILED",
];

export function isAgentInputAllowed(state: WorkspaceRuntimeState): boolean {
  return !AGENT_INPUT_REFUSED_STATES.includes(state);
}