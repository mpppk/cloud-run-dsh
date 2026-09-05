import { describe, expect, test } from "bun:test";
import { InMemoryLogger } from "@cloud-run-dsh/observability";
import {
  DB_READINESS_NOT_READY_REASON,
  createDbReadinessProbe,
} from "./prod-adapters.js";

/**
 * Database readiness probe (issue #97): /readyz must reflect a dead
 * database instead of answering 200 while every request 500s.
 *
 * The probe is SELECT 1 with a short timeout and a short result cache:
 * a hanging database must not hang the endpoint, and steady-state health
 * checks must cost ~zero queries.
 */

class ScriptedExecutor {
  queries: { sql: string; params: unknown[] | undefined }[] = [];
  constructor(private readonly behavior: () => Promise<unknown[]>) {}
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.queries.push({ sql, params });
    return (await this.behavior()) as T[];
  }
}

describe("createDbReadinessProbe (issue #97)", () => {
  test("reachable database -> ready, probed with SELECT 1", async () => {
    const executor = new ScriptedExecutor(async () => [{ "?column?": 1 }]);
    const probe = createDbReadinessProbe(executor);

    const report = await probe();

    expect(report).toEqual({ ready: true });
    expect(executor.queries.length).toBe(1);
    expect(executor.queries[0]!.sql).toBe("SELECT 1");
  });

  test("unreachable database -> not_ready with a fixed pre-auth-safe reason", async () => {
    const logger = new InMemoryLogger();
    const executor = new ScriptedExecutor(async () => {
      throw new Error("Connection timeout after 30s (host=db.internal:5432)");
    });
    const probe = createDbReadinessProbe(executor, { logger });

    const report = await probe();

    expect(report.ready).toBe(false);
    expect(report.reason).toBe(DB_READINESS_NOT_READY_REASON);
    // The 503 body must not echo error text — /readyz is served before auth.
    expect(report.reason).not.toContain("db.internal");
    expect(report.reason).not.toContain("30s");
    // ... but the detail is logged server-side for operators.
    expect(
      logger.parsed.some(
        (e) => e["event"] === "readyz.db_probe_failed" && JSON.stringify(e).includes("Connection timeout"),
      ),
    ).toBe(true);
  });

  test("hanging database -> not_ready at the timeout, not at the database's pace", async () => {
    const executor = new ScriptedExecutor(() => new Promise<never>(() => {}));
    const probe = createDbReadinessProbe(executor, { timeoutMs: 50 });

    const started = Date.now();
    const report = await probe();
    const elapsed = Date.now() - started;

    expect(report.ready).toBe(false);
    expect(report.reason).toBe(DB_READINESS_NOT_READY_REASON);
    // The incident's shape was a 30s hang; the probe must answer far sooner.
    expect(elapsed).toBeLessThan(5000);
  });

  test("results are cached: steady-state health checks cost no queries", async () => {
    let now = 1_000_000;
    const executor = new ScriptedExecutor(async () => [{ "?column?": 1 }]);
    const probe = createDbReadinessProbe(executor, {
      cacheTtlMs: 10_000,
      nowMs: () => now,
    });

    await probe();
    await probe();
    await probe();
    expect(executor.queries.length).toBe(1);

    // Past the TTL the next request re-probes.
    now += 10_001;
    await probe();
    expect(executor.queries.length).toBe(2);
  });

  test("failures are cached too: a dead database is not hammered per request", async () => {
    let now = 1_000_000;
    const executor = new ScriptedExecutor(async () => {
      throw new Error("connection refused");
    });
    const probe = createDbReadinessProbe(executor, {
      cacheTtlMs: 10_000,
      nowMs: () => now,
    });

    expect((await probe()).ready).toBe(false);
    expect((await probe()).ready).toBe(false);
    expect(executor.queries.length).toBe(1);
  });

  test("recovery is noticed after the TTL: fail, then succeed", async () => {
    let now = 1_000_000;
    let down = true;
    const executor = new ScriptedExecutor(async () => {
      if (down) throw new Error("connection refused");
      return [{ "?column?": 1 }];
    });
    const probe = createDbReadinessProbe(executor, {
      cacheTtlMs: 10_000,
      nowMs: () => now,
    });

    expect((await probe()).ready).toBe(false);
    down = false;
    // Still cached as down within the TTL...
    expect((await probe()).ready).toBe(false);
    // ...then the next TTL window re-probes and reports ready.
    now += 10_001;
    expect(await probe()).toEqual({ ready: true });
  });
});
