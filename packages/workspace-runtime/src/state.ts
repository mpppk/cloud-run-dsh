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
