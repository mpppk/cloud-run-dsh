// Session persistence via Cloud SQL PostgreSQL — append-only Harness provider
export type { Workspace, Session, SessionEvent, NewSessionEvent, CreateWorkspaceInput, CreateSessionInput, UpdateWorkspacePatch, WorkspaceRuntimeState, WorkspaceCheckpoint, RecordCheckpointInput } from "./types.js";
export type { QueryExecutor, ClosableExecutor } from "./executor.js";
export {
  BUN_SQL_ENV_URL_KEYS,
  BunSqlConnectionError,
  DatabaseUrlParseError,
  DEFAULT_DB_POOL_IDLE_TIMEOUT,
  DEFAULT_DB_POOL_MAX,
  createBunSqlClient,
  describeConnectionTarget,
  isSocketTarget,
  resolveBunSqlPoolOptions,
  resolveBunSqlTarget,
  toBunSqlConnectionError,
  withIsolatedBunSqlEnv,
} from "./connection.js";
export type { BunSqlConnectionTarget, BunSqlPoolOptions, BunSqlSocketOptions } from "./connection.js";
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
