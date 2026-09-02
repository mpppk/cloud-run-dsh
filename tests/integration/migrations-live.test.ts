// Live-Postgres verification for the Docker dev environment (task B).
//
// Applies the real migrations in infra/migrations against the database named
// by DATABASE_URL, asserts the five T4 tables plus schema_migrations exist,
// and proves the migration runner is idempotent (second run applies nothing).
//
// When DATABASE_URL is unset or no database is reachable, every test SKIPS —
// `bun test` stays green on machines without Docker/Postgres.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { listMigrationFiles, migrate } from "../../infra/migrations/runner.js";
import type { MigrationExecutor } from "../../infra/migrations/runner.js";

const MIGRATIONS_DIR = join(import.meta.dir, "../../infra/migrations");

const T4_TABLES = [
  "workspaces",
  "sessions",
  "session_events",
  "workspace_checkpoints",
  "controller_leases",
] as const;

type UnsafeSqlClient = {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
  begin<T>(fn: (tx: UnsafeSqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/**
 * Minimal Bun.SQL-backed MigrationExecutor. Transactions use `sql.begin`
 * because Bun rejects manual BEGIN/COMMIT issued through `unsafe`
 * (ERR_POSTGRES_UNSAFE_TRANSACTION) — same as the runner CLI fallback.
 */
class BunSqlMigrationExecutor implements MigrationExecutor {
  private constructor(private readonly client: UnsafeSqlClient) {}

  static async connect(databaseUrl: string): Promise<BunSqlMigrationExecutor> {
    const mod = (await import("bun")) as unknown as { SQL: new (url: string) => UnsafeSqlClient };
    return new BunSqlMigrationExecutor(new mod.SQL(databaseUrl));
  }

  async exec(sql: string, params?: unknown[]): Promise<void> {
    await this.client.unsafe(sql, params);
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return (await this.client.unsafe(sql, params)) as T[];
  }

  async transaction<T>(fn: (tx: MigrationExecutor) => Promise<T>): Promise<T> {
    return this.client.begin((tx) => fn(new BunSqlMigrationExecutor(tx)));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

const databaseUrl = process.env["DATABASE_URL"];

let executor: BunSqlMigrationExecutor | undefined;
let skipReason: string | undefined;

if (!databaseUrl) {
  skipReason = "DATABASE_URL is not set (no local Postgres configured)";
} else {
  try {
    executor = await BunSqlMigrationExecutor.connect(databaseUrl);
    await executor.query("SELECT 1");
  } catch (e) {
    executor = undefined;
    skipReason = `DATABASE_URL is set but no database is reachable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

describe.skipIf(!executor)("migrations against live Postgres (docker-compose dev environment)", () => {
  test("applies infra/migrations and records versions in schema_migrations", async () => {
    const exec = executor!;
    const applied = await migrate(exec, { migrationsDir: MIGRATIONS_DIR });
    expect(Array.isArray(applied)).toBeTrue();

    const versions = await exec.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(versions.map((r) => r.version)).toContain("0001_init.sql");
  });

  test("all five T4 tables exist after migration", async () => {
    const exec = executor!;
    const rows = await exec.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('workspaces', 'sessions', 'session_events', 'workspace_checkpoints', 'controller_leases')`,
    );
    const found = new Set(rows.map((r) => r.table_name));
    for (const table of T4_TABLES) {
      expect(found.has(table)).toBe(true);
    }
  });

  test("migration runner is idempotent when run twice", async () => {
    const exec = executor!;
    const first = await migrate(exec, { migrationsDir: MIGRATIONS_DIR });
    expect(first).toEqual([]);

    const versions = await exec.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(versions.map((r) => r.version)).toEqual(await listMigrationFiles(MIGRATIONS_DIR));
  });
});

if (skipReason) {
  test.skip(`live-Postgres migration verification: ${skipReason}`, () => {
    expect(true).toBe(true);
  });
}
