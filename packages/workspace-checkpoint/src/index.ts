// Workspace checkpoint — GCS bundle (skeleton)
export interface CheckpointManifest {
  readonly version: 1;
  readonly baseCommit: string;
  readonly createdAt: string;
  readonly patch: string;
  readonly untracked: string;
}

export interface WorkspaceCheckpointPlaceholder {
  readonly kind: "workspace-checkpoint";
}

export const PLACEHOLDER_KIND = "workspace-checkpoint" as const;

export function createPlaceholder(): WorkspaceCheckpointPlaceholder {
  return {
    kind: PLACEHOLDER_KIND,
  };
}
