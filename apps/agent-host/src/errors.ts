// Typed errors for the Agent Host.

/** Thrown when bootstrap cannot complete (実装手順書 section 19). */
export class BootstrapError extends Error {
  readonly name = "BootstrapError";
  constructor(message: string) {
    super(message);
  }
}

/** Thrown when the workspace is not found in DB metadata (実装手順書 section 30). */
export class WorkspaceNotFoundError extends Error {
  readonly name = "WorkspaceNotFoundError";
  constructor(public readonly workspaceId: string) {
    super(`workspace not found: ${workspaceId}`);
  }
}

/** Thrown when the Cloud Run Instance is not READY during recovery. */
export class InstanceNotHealthyError extends Error {
  readonly name = "InstanceNotHealthyError";
  constructor(
    public readonly instanceName: string,
    public readonly state: string,
  ) {
    super(`instance ${instanceName} is not healthy (state=${state})`);
  }
}
