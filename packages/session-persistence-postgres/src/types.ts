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

export interface Workspace {
  readonly id: string;
  readonly ownerId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly baseBranch: string;
  readonly instanceName: string | null;
  readonly instanceUrl: string | null;
  readonly runtimeState: WorkspaceRuntimeState;
  readonly lastActivityAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkspaceInput {
  readonly id: string;
  readonly ownerId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly baseBranch: string;
  readonly instanceName?: string | null;
  readonly instanceUrl?: string | null;
  readonly runtimeState?: WorkspaceRuntimeState;
}

export interface UpdateWorkspacePatch {
  readonly runtimeState?: WorkspaceRuntimeState;
  readonly lastActivityAt?: string | null;
  readonly instanceName?: string | null;
  readonly instanceUrl?: string | null;
}

export interface Session {
  readonly id: string;
  readonly workspaceId: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSessionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SessionEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly eventType: string;
  readonly eventTime: number;
  readonly data: unknown;
  readonly sourceEventSeqs?: unknown;
  readonly surfaceOp?: unknown;
}

export interface NewSessionEvent {
  readonly eventType: string;
  readonly eventTime: number;
  readonly data: unknown;
  readonly sourceEventSeqs?: unknown;
  readonly surfaceOp?: unknown;
}

/**
 * One row of `workspace_checkpoints` (infra/migrations/0001_init.sql,
 * 実装手順書 section 3): the durable index of GCS checkpoint generations.
 *
 * `gcsObject` is the object KEY within the checkpoint bucket
 * (e.g. `workspaces/<id>/checkpoint.bin`), not a URL — the bucket is
 * deployment config, and restore joins bucket + key (issue #95).
 */
export interface WorkspaceCheckpoint {
  readonly id: string;
  readonly workspaceId: string;
  readonly baseCommitSha: string;
  readonly gcsObject: string;
  readonly createdAt: string;
}

export interface RecordCheckpointInput {
  readonly workspaceId: string;
  readonly baseCommitSha: string;
  readonly gcsObject: string;
}
