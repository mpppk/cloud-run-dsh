// Migration-upgrade regression test (PR #161 follow-up B1).
//
// Proves the old-0003 → 0004 upgrade path on a scratch database:
// a DB migrated with the 0003 schema as merged in #160 (no binding_hash,
// no oauth_login_flows_expires_at) gets exactly 0004 applied by the runner,
// after which the binding column/index exist and a login-flow write with a
// binding hash succeeds. Pre-upgrade flow rows (NULL binding_hash) fail
// closed at the app layer (bindingMatches("") denies — unit-tested).
//
// When DATABASE_URL is unset, unreachable, or has no admin access to create
// a scratch database, every test SKIPS — `bun test` stays green on machines
// without Docker/Postgres.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ensureMigrationsTable, migrate } from "../../infra/migrations/runner.js";
import type { MigrationExecutor } from "../../infra/migrations/runner.js";

const MIGRATIONS_DIR = join(import.meta.dir, "../../infra/migrations");

type UnsafeSqlClient = {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
  begin<T>(fn: (tx: UnsafeSqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** Minimal Bun.SQL-backed MigrationExecutor (mirrors migrations-live.test.ts). */
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

/**
 * Frozen copy of 0003_auth_sessions.sql as merged in #160 (commit a5cb316):
 * oauth_login_flows WITHOUT binding_hash and WITHOUT the expires_at index.
 * Deliberately inlined (not read from disk) so this test keeps proving the
 * upgrade even if 0003 ever changes again — it simulates a production DB
 * migrated per the #160 runbook.
 */
const OLD_0003_FROZEN = `
CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  token_hash BYTEA NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  github_user_id BIGINT NOT NULL,
  github_login TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX auth_sessions_expires_at
  ON auth_sessions(expires_at);

CREATE TABLE oauth_login_flows (
  state_hash BYTEA PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  return_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
`;

const databaseUrl = process.env["DATABASE_URL"];
const scratchDb = `dsh_upgrade_${process.pid}`;

let admin: BunSqlMigrationExecutor | undefined;
let skipReason: string | undefined;

function adminUrl(dbUrl: string): string {
  const parsed = new URL(dbUrl);
  if (!parsed.hostname) throw new Error("DATABASE_URL has no host for admin access");
  parsed.pathname = "/postgres";
  return parsed.toString();
}

if (!databaseUrl) {
  skipReason = "DATABASE_URL is not set (no local Postgres configured)";
} else {
  try {
    admin = await BunSqlMigrationExecutor.connect(adminUrl(databaseUrl));
    await admin.query("SELECT 1");
  } catch (e) {
    admin = undefined;
    skipReason = `no admin database access for scratch DB: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function scratchUrl(): Promise<string> {
  const parsed = new URL(databaseUrl!);
  parsed.pathname = `/${scratchDb}`;
  return parsed.toString();
}

describe.skipIf(!admin)("old-0003 → 0004 migration upgrade path (B1)", () => {
  test("runner applies exactly 0004 on an old-0003-applied DB", async () => {
    const adm = admin!;
    await adm.exec(`DROP DATABASE IF EXISTS "${scratchDb}"`);
    await adm.exec(`CREATE DATABASE "${scratchDb}"`);
    try {
      const exec = await BunSqlMigrationExecutor.connect(await scratchUrl());
      try {
        // Simulate the #160-runbook state: real 0001/0002 + FROZEN old 0003,
        // all recorded in schema_migrations.
        const dir = MIGRATIONS_DIR;
        const read = (name: string) => Bun.file(join(dir, name)).text();
        await exec.exec(await read("0001_init.sql"));
        await exec.exec(await read("0002_last_error.sql"));
        await exec.exec(OLD_0003_FROZEN);
        await ensureMigrationsTable(exec);
        await exec.exec(
          "INSERT INTO schema_migrations(version) VALUES ('0001_init.sql'), ('0002_last_error.sql'), ('0003_auth_sessions.sql')",
        );

        const applied = await migrate(exec, { migrationsDir: MIGRATIONS_DIR });
        expect(applied).toEqual(["0004_oauth_binding.sql"]);

        // binding_hash exists and is NULLABLE (pre-upgrade rows stay valid).
        const columns = await exec.query<{ column_name: string; is_nullable: string }>(
          `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'oauth_login_flows'`,
        );
        const binding = columns.find((c) => c.column_name === "binding_hash");
        expect(binding).toBeDefined();
        expect(binding!.is_nullable).toBe("YES");

        // Both expiry indexes exist (0003's + 0004's).
        const indexes = await exec.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
           AND tablename IN ('auth_sessions', 'oauth_login_flows')`,
        );
        const names = new Set(indexes.map((r) => r.indexname));
        expect(names.has("auth_sessions_expires_at")).toBe(true);
        expect(names.has("oauth_login_flows_expires_at")).toBe(true);

        // A login-flow write WITH a binding hash succeeds post-upgrade.
        await exec.exec(
          `INSERT INTO oauth_login_flows(state_hash, code_verifier, return_to, binding_hash, expires_at)
           VALUES (decode('aa', 'hex'), 'verifier', '/app', decode('bb', 'hex'), now() + interval '5 minutes')`,
        );
        const rows = await exec.query<{ code_verifier: string }>(
          `DELETE FROM oauth_login_flows WHERE state_hash = decode('aa', 'hex')
           RETURNING code_verifier, return_to, binding_hash`,
        );
        expect(rows).toHaveLength(1);

        // A pre-upgrade row (NULL binding_hash) is still readable — the app
        // fails it closed (bindingMatches("") denies), it does not break.
        await exec.exec(
          `INSERT INTO oauth_login_flows(state_hash, code_verifier, expires_at)
           VALUES (decode('cc', 'hex'), 'old', now() + interval '5 minutes')`,
        );
        const old = await exec.query<{ binding_hash: unknown }>(
          `SELECT binding_hash FROM oauth_login_flows WHERE state_hash = decode('cc', 'hex')`,
        );
        expect(old[0]!.binding_hash).toBeNull();

        // Second run is a no-op (idempotent).
        expect(await migrate(exec, { migrationsDir: MIGRATIONS_DIR })).toEqual([]);
      } finally {
        await exec.close();
      }
    } finally {
      await adm.exec(`DROP DATABASE IF EXISTS "${scratchDb}"`);
    }
  });
});

afterAll(async () => {
  await admin?.close();
});

if (skipReason) {
  test.skip(`migration-upgrade verification: ${skipReason}`, () => {
    expect(true).toBe(true);
  });
}
