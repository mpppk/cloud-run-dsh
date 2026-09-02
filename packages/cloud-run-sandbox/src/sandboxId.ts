const WORKSPACE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Single place to derive the Cloud Run Sandbox name.
 * Format: dsh-${workspaceId}
 */
export function toSandboxId(workspaceId: string): string {
  if (!isValidWorkspaceId(workspaceId)) {
    throw new Error(
      `invalid workspaceId: ${JSON.stringify(workspaceId)} — must match ${WORKSPACE_ID_RE.source}`,
    );
  }
  return `dsh-${workspaceId}`;
}

export function isValidWorkspaceId(id: string): boolean {
  return typeof id === "string" && WORKSPACE_ID_RE.test(id);
}
