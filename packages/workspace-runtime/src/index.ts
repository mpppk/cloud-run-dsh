export type {
  WorkspaceRuntimeState,
} from "./state.js";
export {
  WORKSPACE_RUNTIME_STATES,
  WORKSPACE_STATE_TRANSITIONS,
  AGENT_INPUT_REFUSED_STATES,
  IllegalTransitionError,
  canTransition,
  assertTransition,
  isAgentInputAllowed,
} from "./state.js";

export type {
  TransitionRecord,
  WorkspaceStateTransaction,
  TransactionalStateStore,
} from "./store.js";
export { InMemoryTransactionalStore } from "./store.js";

export { WorkspaceStateMachine } from "./machine.js";

export { AGENT_HOST_HEALTH_PATH } from "./health-path.js";

export {
  IDLE_TIMEOUT_MS,
  isMeaningfulActivity,
  isNonMeaningfulActivity,
  IdleManager,
} from "./idle.js";
export type { ActivityKind, RunningFlags } from "./idle.js";

export type {
  WorkspaceLifecycleSteps,
  WorkspaceRuntimeDeps,
} from "./runtime.js";
export {
  WorkspaceRuntime,
  OperationTracker,
  AgentInputRefusedError,
  InvalidOperationError,
} from "./runtime.js";

// Re-export placeholder for backwards compat (T1 skeleton)
export interface WorkspaceRuntimePlaceholder {
  readonly kind: "workspace-runtime";
}

export const PLACEHOLDER_KIND = "workspace-runtime" as const;

export function createPlaceholder(): WorkspaceRuntimePlaceholder {
  return {
    kind: PLACEHOLDER_KIND,
  };
}