/**
 * Tiny idempotent migration runner (bun script).
 *
 * - Discovers `*.sql` files in the migrations directory (lexicographic order).
 * - Ignores `*.down.sql`.
 * - Records applied versions in `schema_migrations(version TEXT PRIMARY KEY)`.
 * - Applies each pending migration inside a transaction then inserts its version.
 * - Idempotent: re-running skips already-applied versions.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun run infra/migrations/runner.ts
 *   DATABASE_URL=... bun run infra/migrations/runner.ts --dir infra/migrations
 *
 * Programmatic use:
 *   import { migrate, listMigrationFiles } from "./runner.js";
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface MigrationExecutor {
  /** Execute a statement without returning rows. */
  exec(sql: string, params?: unknown[]): Promise<void>;
  /** Query rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run callback inside a transaction. Must BEGIN/COMMIT/ROLLBACK internally. */
  transaction<T>(fn: (tx: MigrationExecutor) => Promise<T>): Promise<T>;
}

export interface MigrateOptions {
  migrationsDir: string;
}

export async function ensureMigrationsTable(executor: MigrationExecutor): Promise<void> {
  await executor.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();
}

export async function getAppliedVersions(executor: MigrationExecutor): Promise<Set<string>> {
  const rows = await executor.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return new Set(rows.map((r) => r.version));
}

export async function migrate(
  executor: MigrationExecutor,
  options: MigrateOptions,
): Promise<string[]> {
  await ensureMigrationsTable(executor);
  const files = await listMigrationFiles(options.migrationsDir);
  const applied = await getAppliedVersions(executor);
  const pending = files.filter((f) => !applied.has(f));
  const appliedNow: string[] = [];

  for (const file of pending) {
    const fullPath = join(options.migrationsDir, file);
    const sql = await readFile(fullPath, "utf-8");
    if (!sql.trim()) continue;
    // Each migration runs in its own transaction. The version record is
    // inserted in the same transaction so crash mid-file does not mark it done.
    await executor.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.exec("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
    });
    appliedNow.push(file);
  }
  return appliedNow;
}

// ---------------------------------------------------------------------------
// Minimal pg-backed executor for CLI use (lazy import so tests don't need `pg`)
// ---------------------------------------------------------------------------

async function createPgExecutor(databaseUrl: string): Promise<MigrationExecutor & { close(): Promise<void> }> {
  // Prefer `pg` if available; fall back to Bun.sql
  try {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    const wrap = (c: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }): MigrationExecutor => ({
      async exec(sql, params) {
        await c.query(sql, params as unknown[]);
      },
      async query(sql, params) {
        const res = await c.query(sql, params as unknown[]);
        return res.rows as Record<string, unknown>[];
      },
      async transaction(fn) {
        await c.query("BEGIN");
        try {
          const result = await fn(wrap(c));
          await c.query("COMMIT");
          return result;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      },
    });

    return {
      ...wrap(client as unknown as { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }),
      async close() {
        await client.end();
      },
    };
  } catch {
    // Fallback to Bun's built-in SQL client (Bun.sql) if pg not installed
    const sql = new (Bun as unknown as { SQL: new (url: string) => unknown }).SQL(databaseUrl) as unknown as {
      unsafe(q: string, params?: unknown[]): Promise<unknown[]>;
    };
    // For Bun.sql transactions, we emulate BEGIN/COMMIT via unsafe.
    const bunWrap = (client: typeof sql): MigrationExecutor => ({
      async exec(q, params) {
        await client.unsafe(q, params);
      },
      async query(q, params) {
        const rows = await client.unsafe(q, params);
        return rows as Record<string, unknown>[];
      },
      async transaction(fn) {
        await client.unsafe("BEGIN");
        try {
          const result = await fn(bunWrap(client));
          await client.unsafe("COMMIT");
          return result;
        } catch (e) {
          await client.unsafe("ROLLBACK");
          throw e;
        }
      },
    });
    return {
      ...bunWrap(sql),
      async close() {},
    };
  }
}

// CLI entrypoint — only runs when invoked directly via `bun run runner.ts`
const isMain = import.meta.main ?? import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dirFlagIndex = process.argv.indexOf("--dir");
  const migrationsDir =
    dirFlagIndex !== -1 && process.argv[dirFlagIndex + 1]
      ? process.argv[dirFlagIndex + 1]!
      : join(import.meta.dir, ".");

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const executor = await createPgExecutor(databaseUrl);
  try {
    const applied = await migrate(executor, { migrationsDir });
    if (applied.length === 0) {
      console.log("No pending migrations.");
    } else {
      console.log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
    }
  } finally {
    await executor.close();
  }
}
