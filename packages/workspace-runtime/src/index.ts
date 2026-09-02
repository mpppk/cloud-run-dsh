// Workspace runtime — state machine & domain types
// Re-export from state.ts; placeholder kept for smoke test
export interface WorkspaceRuntimePlaceholder {
  readonly kind: "workspace-runtime";
}

export const PLACEHOLDER_KIND = "workspace-runtime" as const;

export function createPlaceholder(): WorkspaceRuntimePlaceholder {
  return {
    kind: PLACEHOLDER_KIND,
  };
}
export * from "./state.js";
