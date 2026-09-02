import type { Clock } from "@cloud-run-dsh/workspace-checkpoint";

/** Idle timeout: 30 minutes (仕様書 section 11). */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Every activity kind that can be reported to the idle manager. */
export type ActivityKind =
  // meaningful (仕様書 section 11)
  | "user_message"
  | "approval"
  | "agent_turn"
  | "tool_invocation"
  | "subprocess"
  | "filesystem_mutation"
  | "checkpoint"
  | "workspace_operation"
  // NOT meaningful (仕様書 section 11)
  | "health_check"
  | "sse_heartbeat"
  | "browser_connection"
  | "status_polling"
  | "metrics_collection";

const MEANINGFUL_ACTIVITIES: readonly ActivityKind[] = [
  "user_message",
  "approval",
  "agent_turn",
  "tool_invocation",
  "subprocess",
  "filesystem_mutation",
  "checkpoint",
  "workspace_operation",
];

const NON_MEANINGFUL_ACTIVITIES: readonly ActivityKind[] = [
  "health_check",
  "sse_heartbeat",
  "browser_connection",
  "status_polling",
  "metrics_collection",
];

export function isMeaningfulActivity(kind: ActivityKind): boolean {
  return MEANINGFUL_ACTIVITIES.includes(kind);
}

export function isNonMeaningfulActivity(kind: ActivityKind): boolean {
  return NON_MEANINGFUL_ACTIVITIES.includes(kind);
}

export type RunningFlags = {
  agentRunning: boolean;
  subprocessRunning: boolean;
  checkpointRunning: boolean;
};

/**
 * Idle manager (仕様書 section 11, 実装手順書 section 28).
 *
 * Tracks `lastMeaningfulActivityAt` per workspace. Only meaningful activities
 * extend the idle timer — SSE heartbeats, health checks, browser connections,
 * status polling and metrics collection are explicitly ignored.
 *
 * Stop is only proposed when the 30 minute timeout has elapsed AND
 * `!agentRunning && !subprocessRunning && !checkpointRunning`.
 */
export class IdleManager {
  private lastMeaningfulActivityAtMs: number | null = null;
  private agentRunning = false;
  private subprocessRunning = false;
  private checkpointRunning = false;

  constructor(private readonly clock: Clock) {}

  getLastMeaningfulActivityAt(): Date | null {
    return this.lastMeaningfulActivityAtMs === null
      ? null
      : new Date(this.lastMeaningfulActivityAtMs);
  }

  /**
   * Records an activity. Meaningful activities reset the idle timer;
   * non-meaningful ones (health check, SSE heartbeat, browser connection,
   * status polling, metrics collection) are ignored entirely.
   */
  recordActivity(kind: ActivityKind): void {
    if (!isMeaningfulActivity(kind)) return;
    this.lastMeaningfulActivityAtMs = this.clock.nowMs();
  }

  setAgentRunning(value: boolean): void {
    this.agentRunning = value;
  }

  setSubprocessRunning(value: boolean): void {
    this.subprocessRunning = value;
  }

  setCheckpointRunning(value: boolean): void {
    this.checkpointRunning = value;
  }

  isAgentRunning(): boolean {
    return this.agentRunning;
  }

  isSubprocessRunning(): boolean {
    return this.subprocessRunning;
  }

  isCheckpointRunning(): boolean {
    return this.checkpointRunning;
  }

  /** Milliseconds since the last meaningful activity (null = never). */
  getIdleMs(): number | null {
    if (this.lastMeaningfulActivityAtMs === null) return null;
    return this.clock.nowMs() - this.lastMeaningfulActivityAtMs;
  }

  /**
   * True when the idle timeout has elapsed and no agent, subprocess or
   * checkpoint is running (実装手順書 section 28):
   *
   *   if (!agentRunning && !subprocessRunning && !checkpointRunning) beginStop();
   */
  shouldStop(): boolean {
    const idleMs = this.getIdleMs();
    if (idleMs === null) return false;
    if (idleMs < IDLE_TIMEOUT_MS) return false;
    return !this.agentRunning && !this.subprocessRunning && !this.checkpointRunning;
  }
}