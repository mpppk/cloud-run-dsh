import { describe, test, expect } from "bun:test";
import { InMemoryFakeExecutor } from "../../packages/session-persistence-postgres/src/fakeExecutor.js";
import { listMigrationFiles, ensureMigrationsTable, getAppliedVersions, migrate } from "./runner.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("migration runner", () => {
  test("listMigrationFiles sorts and ignores down files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migrations-test-"));
    try {
      await writeFile(join(dir, "0001_init.sql"), "select 1");
      await writeFile(join(dir, "0002_add.sql"), "select 2");
      await writeFile(join(dir, "0001_init.down.sql"), "drop");
      await writeFile(join(dir, "readme.md"), "ignore");
      const files = await listMigrationFiles(dir);
      expect(files).toEqual(["0001_init.sql", "0002_add.sql"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applies ordered migrations idempotently and records schema_migrations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migrations-test-"));
    try {
      await writeFile(join(dir, "0001_init.sql"), "CREATE TABLE t1 (id TEXT PRIMARY KEY);");
      await writeFile(join(dir, "0002_add.sql"), "CREATE TABLE t2 (id TEXT PRIMARY KEY);");
      await writeFile(join(dir, "0001_init.down.sql"), "DROP TABLE t1;");

      const exec = new InMemoryFakeExecutor();
      await ensureMigrationsTable(exec);
      const first = await migrate(exec, { migrationsDir: dir });
      expect(first).toEqual(["0001_init.sql", "0002_add.sql"]);
      expect(await getAppliedVersions(exec)).toEqual(new Set(["0001_init.sql", "0002_add.sql"]));

      const second = await migrate(exec, { migrationsDir: dir });
      expect(second).toEqual([]);

      await writeFile(join(dir, "0003_more.sql"), "CREATE TABLE t3 (id TEXT PRIMARY KEY);");
      const third = await migrate(exec, { migrationsDir: dir });
      expect(third).toEqual(["0003_more.sql"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("transaction per migration: failure does not mark version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migrations-test-"));
    try {
      await writeFile(join(dir, "0001_ok.sql"), "CREATE TABLE t1 (id TEXT PRIMARY KEY);");
      await writeFile(join(dir, "0002_fail.sql"), "INVALID SQL SYNTAX THAT FAKE WILL REJECT AS UNHANDLED");

      const exec = new InMemoryFakeExecutor();
      // Make 0002_fail throw by using unhandled SQL that fake rejects
      let threw = false;
      try {
        await migrate(exec, { migrationsDir: dir });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // Only 0001 should be recorded; 0002 not recorded due to transaction rollback
      const applied = await getAppliedVersions(exec);
      expect(applied.has("0001_ok.sql")).toBe(true);
      expect(applied.has("0002_fail.sql")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
