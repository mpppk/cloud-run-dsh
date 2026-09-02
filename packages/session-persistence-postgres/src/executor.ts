/**
 * Injectable query-executor abstraction so callers do not depend on the pg driver.
 * Both the real `pg`/`Bun.SQL` executor and the in-memory fake implement this.
 */
export interface QueryExecutor {
  exec(sql: string, params?: unknown[]): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}

/** Optional helper to close underlying connections (e.g. pg Pool). */
export interface ClosableExecutor extends QueryExecutor {
  close(): Promise<void>;
}
