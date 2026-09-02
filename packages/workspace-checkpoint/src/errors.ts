export class RestoreValidationError extends Error {
  override name = "RestoreValidationError";
  constructor(message: string, public readonly details?: unknown) {
    super(message);
  }
}

export class CheckpointFailedError extends Error {
  override name = "CheckpointFailedError";
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}
