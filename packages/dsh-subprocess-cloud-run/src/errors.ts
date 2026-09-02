export class SubprocessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubprocessError";
  }
}

export class TimeoutError extends SubprocessError {
  constructor(message = "subprocess timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export class CancelledError extends SubprocessError {
  constructor(message = "subprocess cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export class ExecutableNotFoundError extends SubprocessError {
  constructor(command: string) {
    super(`executable not found: ${command}`);
    this.name = "ExecutableNotFoundError";
  }
}

export type ExitStatus =
  | { kind: "success"; exitCode: 0 }
  | { kind: "error"; exitCode: number }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export function mapExitCode(exitCode: number): ExitStatus {
  if (exitCode === 0) return { kind: "success", exitCode: 0 };
  return { kind: "error", exitCode };
}

export function toSubprocessError(status: ExitStatus, message?: string): SubprocessError | null {
  if (status.kind === "success") return null;
  if (status.kind === "timeout") return new TimeoutError(message);
  if (status.kind === "cancelled") return new CancelledError(message);
  return new SubprocessError(message ?? `process exited with ${status.exitCode}`);
}
