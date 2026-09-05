// Agent-host health — served on AGENT_HOST_HEALTH_PATH ("/readyz", NOT
// "/healthz": Cloud Run's frontend reserves the exact path "/healthz" and
// never forwards it to the container — issue #68).
// Reports READY only after restore succeeds
// (実装手順書 sections 30/24; 仕様書 section 11: health checks are NOT
// meaningful activity, so this service never touches the IdleManager).

export type HealthStatus = "RESTORING" | "READY" | "RESTORE_FAILED";

export interface HealthSnapshot {
  readonly status: HealthStatus;
  readonly workspaceId: string;
}

export class HealthService {
  private status: HealthStatus = "RESTORING";

  constructor(private readonly workspaceId: string) {}

  setReady(): void {
    this.status = "READY";
  }

  setRestoring(): void {
    this.status = "RESTORING";
  }

  setRestoreFailed(): void {
    this.status = "RESTORE_FAILED";
  }

  isReady(): boolean {
    return this.status === "READY";
  }

  snapshot(): HealthSnapshot {
    return { status: this.status, workspaceId: this.workspaceId };
  }
}

/**
 * Builds the readiness response for GET AGENT_HOST_HEALTH_PATH: 200 only
 * once restore completed (READY), 503 while RESTORING / RESTORE_FAILED so
 * the control-plane poll keeps waiting / fails honestly instead of marking
 * the workspace READY blindly.
 */
export function healthResponse(snapshot: HealthSnapshot): Response {
  const ready = snapshot.status === "READY";
  return new Response(JSON.stringify(snapshot), {
    status: ready ? 200 : 503,
    headers: { "Content-Type": "application/json" },
  });
}
