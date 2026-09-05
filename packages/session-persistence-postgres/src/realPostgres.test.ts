import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import type { QueryExecutor } from "./executor.js";
import { defineRepositorySuite } from "./repository.suite.js";

// Real-PostgreSQL counterpart of the fake-backed suite (issue #70).
//
// The fake executor intentionally serializes transactions via an in-memory
// queue and used to silently ignore locking clauses, so SQL that real
// PostgreSQL rejects passed every test. This file runs the SAME behavior
// suite against a real database so such SQL fails in tests, not in prod.
//
// Usage:
//   docker compose up -d postgres
//   DATABASE_URL=postgres://dsh:dsh@localhost:5432/dsh bun run db:migrate
//   TEST_POSTGRES_URL=postgres://dsh:dsh@localhost:5432/dsh bun test packages/session-persistence-postgres
//
// Without TEST_POSTGRES_URL the suite self-skips (local `bun test` and
// environments without Postgres keep working exactly as before).

const TEST_URL = process.env["TEST_POSTGRES_URL"];

if (!TEST_URL) {
  describe.skip("session-persistence-postgres (real PostgreSQL)", () => {
    test("skipped: set TEST_POSTGRES_URL to run against real PostgreSQL", () => {});
  });
} else {
  /** Minimal test-only QueryExecutor over Bun's built-in SQL client. */
  class BunSqlTestExecutor implements QueryExecutor {
    constructor(private readonly client: Pick<SQL, "unsafe" | "begin">) {}

    async exec(sql: string, params?: unknown[]): Promise<void> {
      await this.client.unsafe(sql, (params ?? []) as never[]);
    }

    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      return (await this.client.unsafe(sql, (params ?? []) as never[])) as T[];
    }

    async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
      return this.client.begin((tx) => fn(new BunSqlTestExecutor(tx as SQL)));
    }
  }

  let client: SQL;

  beforeAll(async () => {
    client = new SQL(TEST_URL);
    // Fail loudly with a fix hint when migrations were not applied.
    try {
      await client.unsafe("SELECT 1 FROM sessions LIMIT 0");
    } catch (e) {
      throw new Error(
        `real-PostgreSQL suite needs a migrated database: run ` +
          `DATABASE_URL=${TEST_URL} bun run db:migrate first (cause: ${e})`,
      );
    }
  });

  afterAll(async () => {
    await client?.close();
  });

  defineRepositorySuite(
    "session-persistence-postgres (real PostgreSQL)",
    () => new BunSqlTestExecutor(client),
    {
      enforceAppendOnlyRejection: false,
      beforeEach: async () => {
        await client.unsafe("TRUNCATE session_events, sessions, workspaces CASCADE");
      },
    },
  );
}
