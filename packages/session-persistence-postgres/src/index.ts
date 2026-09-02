// Session persistence via Cloud SQL PostgreSQL — append-only Harness provider
export type { Workspace, Session, SessionEvent, NewSessionEvent, CreateWorkspaceInput, CreateSessionInput, UpdateWorkspacePatch, WorkspaceRuntimeState } from "./types.js";
export type { QueryExecutor, ClosableExecutor } from "./executor.js";
export { PostgresSessionPersistenceRepository, type SessionPersistenceRepository } from "./repository.js";
export { PostgresSessionPersistence, type SessionPersistence } from "./sessionPersistence.js";

// Legacy placeholder (kept for compatibility with T1 skeleton)
export interface SessionPersistencePlaceholder {
  readonly kind: "session-persistence-postgres";
}
export const PLACEHOLDER_KIND = "session-persistence-postgres" as const;
export function createPlaceholder(): SessionPersistencePlaceholder {
  return { kind: PLACEHOLDER_KIND };
}
