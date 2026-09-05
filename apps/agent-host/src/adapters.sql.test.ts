// Tests for the SQL adapters against the REAL 0001_init.sql schema shapes
// (infra/migrations/0001_init.sql), using a lock-emulating in-memory executor.
//
// - MAJOR-1 fix: BunSqlLeaseStore.transaction's read must take `SELECT ... FOR
//   UPDATE` so a release whose owner check saw a stale snapshot serialises
//   against a concurrent takeover instead of deleting the takeover's lease.
// - MAJOR-2 fix: SqlTransactionalStateStore.apply's persist branch must write
//   the real workspace_checkpoints columns (id, workspace_id, base_commit_sha,
//   gcs_object) — there is no `data` column in the T4 schema.

import { describe, expect, test } from "bun:test";
import { BunSqlLeaseStore, BunSqlQueryExecutor, SqlTransactionalStateStore } from "./adapters.js";
import { IllegalTransitionError } from "@cloud-run-dsh/workspace-runtime";
import type { BunSqlConnectionTarget } from "@cloud-run-dsh/session-persistence-postgres";
import { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import type { LeaseTransaction } from "@cloud-run-dsh/controller-lease";
import type { QueryExecutor } from "@cloud-run-dsh/session-persistence-postgres";

// ---------------------------------------------------------------------------
// Lock-emulating in-memory executor — models the 0001_init.sql tables and
// PostgreSQL row locking for SELECT ... FOR UPDATE under READ COMMITTED.
// ---------------------------------------------------------------------------

interface LeaseRow {
  workspace_id: string;
  controller_id: string;
  user_id: string;
  expires_at: string;
  updated_at: string;
}

interface WorkspaceRow {
  id: string;
  runtime_state: string;
}

interface CheckpointRow {
  id: string;
  workspace_id: string;
  base_commit_sha: string;
  gcs_object: string;
  created_at: string;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Applies `col = $n` assignments from an UPDATE ... SET clause. */
function applyAssignments(
  row: Record<string, unknown>,
  sql: string,
  params: unknown[],
): Record<string, unknown> {
  const next = { ...row };
  const setClause = normalize(sql).match(/set\s+(.+?)\s+where/i)?.[1] ?? "";
  for (const assignment of setClause.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = assignment.match(/^(\w+)\s*=\s*\$(\d+)$/i);
    if (!m) continue;
    next[m[1]!.toLowerCase()] = params[Number(m[2]) - 1];
  }
  return next;
}

class LockingFakeExecutor implements QueryExecutor {
  readonly leases = new Map<string, LeaseRow>();
  readonly workspaces = new Map<string, WorkspaceRow>();
  readonly checkpoints: CheckpointRow[] = [];
  /** Recorded SQL per statement (normalized). */
  readonly statements: string[] = [];
  /** Rows locked by SELECT ... FOR UPDATE: rowKey -> txId. */
  private locks = new Map<string, symbol>();
  private lockWaiters = new Map<string, Array<() => void>>();
  private checkpointSeq = 0;

  seedLease(row: LeaseRow): void {
    this.leases.set(row.workspace_id, row);
  }

  seedWorkspace(id: string, runtimeState: string): void {
    this.workspaces.set(id, { id, runtime_state: runtimeState });
  }

  peekLease(workspaceId: string): LeaseRow | undefined {
    return this.leases.get(workspaceId);
  }

  async exec(sql: string, params?: unknown[]): Promise<void> {
    this.applyStatement(sql, params ?? [], Symbol("non-tx"));
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.evalStatement(sql, params ?? []) as T[];
  }

  async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    const txId = Symbol("tx");
    const tx: QueryExecutor = {
      exec: async (sql, params) => {
        this.statements.push(normalize(sql));
        await this.waitForRow(sql, params ?? [], txId);
        this.applyStatement(sql, params ?? [], txId);
      },
      query: async <T2 = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        this.statements.push(normalize(sql));
        await this.waitForRow(sql, params ?? [], txId);
        return this.evalStatement(sql, params ?? []) as T2[];
      },
      transaction: async <T2>(nestedFn: (t: QueryExecutor) => Promise<T2>) => {
        // Not exercised by the lease/state flows; treat as the same tx.
        return nestedFn(tx);
      },
    };
    try {
      return await fn(tx);
    } finally {
      this.releaseLocks(txId);
    }
  }

  async close(): Promise<void> {}

  // --- locking -------------------------------------------------------------

  private async waitForRow(sql: string, params: unknown[], txId: symbol): Promise<void> {
    const key = this.rowKey(sql, params);
    if (!key) return;
    while (this.locks.has(key) && this.locks.get(key) !== txId) {
      await new Promise<void>((resolve) => {
        const waiters = this.lockWaiters.get(key) ?? [];
        waiters.push(resolve);
        this.lockWaiters.set(key, waiters);
      });
    }
    // SELECT ... FOR UPDATE acquires the row lock until this tx ends.
    if (normalize(sql).toLowerCase().includes("for update")) {
      this.locks.set(key, txId);
    }
  }

  private releaseLocks(txId: symbol): void {
    for (const [key, holder] of [...this.locks.entries()]) {
      if (holder === txId) this.locks.delete(key);
    }
    for (const [key, waiters] of [...this.lockWaiters.entries()]) {
      if (!this.locks.has(key)) {
        this.lockWaiters.delete(key);
        for (const w of waiters) w();
      }
    }
  }

  private rowKey(sql: string, params: unknown[]): string | null {
    const n = normalize(sql).toLowerCase();
    const id = params[0];
    if (
      n.includes("from controller_leases") ||
      n.startsWith("insert into controller_leases") ||
      n.startsWith("update controller_leases") ||
      n.startsWith("delete from controller_leases")
    ) {
      return typeof id === "string" ? `lease:${id}` : null;
    }
    if (n.includes("from workspaces") || n.startsWith("update workspaces")) {
      return typeof id === "string" ? `workspace:${id}` : null;
    }
    return null;
  }

  // --- statement dispatch ----------------------------------------------------

  private evalStatement(sql: string, params: unknown[]): Record<string, unknown>[] {
    const n = normalize(sql);
    const lower = n.toLowerCase();

    if (lower.startsWith("select") && lower.includes("from controller_leases")) {
      const row = this.leases.get(String(params[0]));
      return row ? [{ ...row }] : [];
    }
    if (lower.startsWith("select") && lower.includes("from workspaces")) {
      const row = this.workspaces.get(String(params[0]));
      return row ? [{ ...row }] : [];
    }
    throw new Error(`LockingFakeExecutor: unhandled SELECT: ${n}`);
  }

  private applyStatement(sql: string, params: unknown[], _txId: symbol): void {
    const n = normalize(sql);
    const lower = n.toLowerCase();

    if (lower.startsWith("insert into controller_leases")) {
      const row: LeaseRow = {
        workspace_id: String(params[0]),
        controller_id: String(params[1]),
        user_id: String(params[2]),
        expires_at: String(params[3]),
        updated_at: String(params[4]),
      };
      if (this.leases.has(row.workspace_id)) {
        throw new Error(`duplicate key: ${row.workspace_id}`);
      }
      this.leases.set(row.workspace_id, row);
      return;
    }
    if (lower.startsWith("update controller_leases")) {
      const id = String(params[0]);
      const row = this.leases.get(id);
      if (row) this.leases.set(id, applyAssignments(row, n, params) as LeaseRow);
      return;
    }
    if (lower.startsWith("delete from controller_leases")) {
      // No owner predicate in the DELETE — the FOR UPDATE read is what makes
      // the owner check un-staleable (MAJOR-1 fix).
      this.leases.delete(String(params[0]));
      return;
    }
    if (lower.startsWith("update workspaces")) {
      const id = String(params[0]);
      const row = this.workspaces.get(id);
      if (!row) throw new Error(`workspace not found: ${id}`);
      this.workspaces.set(id, applyAssignments(row, n, params) as WorkspaceRow);
      return;
    }
    if (lower.startsWith("insert into workspace_checkpoints")) {
      // Only the REAL schema shape (id, workspace_id, base_commit_sha,
      // gcs_object) is accepted — matching infra/migrations/0001_init.sql.
      if (lower.includes("gen_random_uuid()")) {
        if (params.length !== 3) {
          throw new Error(`workspace_checkpoints INSERT param mismatch: ${n}`);
        }
        this.checkpoints.push({
          id: `gen-${this.checkpointSeq++}`,
          workspace_id: String(params[0]),
          base_commit_sha: String(params[1]),
          gcs_object: String(params[2]),
          created_at: new Date().toISOString(),
        });
      } else {
        throw new Error(`LockingFakeExecutor: unhandled INSERT workspace_checkpoints shape: ${n}`);
      }
      return;
    }
    throw new Error(`LockingFakeExecutor: unhandled statement: ${n}`);
  }
}

// ---------------------------------------------------------------------------
// BunSqlQueryExecutor.connect — Cloud SQL socket form + password hygiene
// (issue #42; mirrors apps/control-plane/src/prod.test.ts; resolution
// logic itself is covered in the shared package)
// ---------------------------------------------------------------------------

const CONNECT_SECRET = "ah-s3cr3t-Pw/xX9qZ";

describe("BunSqlQueryExecutor.connect", () => {
  const seen: BunSqlConnectionTarget[] = [];

  class StubSql {
    constructor(target: BunSqlConnectionTarget) {
      seen.push(target);
    }
    async unsafe(): Promise<unknown[]> {
      return [];
    }
    async begin<T>(fn: (tx: StubSql) => Promise<T>): Promise<T> {
      return fn(this);
    }
    async close(): Promise<void> {}
  }

  test("socket DSN resolves to the options object, not the URL string", async () => {
    seen.length = 0;
    await BunSqlQueryExecutor.connect(
      `postgresql://dsh_app:${CONNECT_SECRET}@/dsh?host=/cloudsql/p:r:i`,
      StubSql,
    );
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({
      path: "/cloudsql/p:r:i",
      username: "dsh_app",
      password: CONNECT_SECRET,
      database: "dsh",
    });
  });

  test("TCP DSN passes through byte-identical", async () => {
    seen.length = 0;
    const url = `postgres://dsh:${CONNECT_SECRET}@localhost:5432/dsh`;
    await BunSqlQueryExecutor.connect(url, StubSql);
    expect(seen).toEqual([url]);
  });

  test("constructor failure never carries the password", async () => {
    const dsn = `postgresql://dsh_app:${CONNECT_SECRET}@/dsh?host=/cloudsql/p:r:i`;
    class ThrowingSql extends StubSql {
      constructor(target: BunSqlConnectionTarget) {
        super(target);
        // Faithful to Bun: message clean, password in `input`.
        throw Object.assign(new TypeError("Invalid URL"), {
          code: "ERR_INVALID_URL",
          input: dsn,
        });
      }
    }
    const err = await BunSqlQueryExecutor.connect(dsn, ThrowingSql).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    expect(err!.name).toBe("BunSqlConnectionError");
    expect(err!.message.includes(CONNECT_SECRET)).toBe(false);
    expect(JSON.stringify(err).includes(CONNECT_SECRET)).toBe(false);
    expect("input" in err!).toBe(false);
    expect("cause" in err!).toBe(false);
  });

  test("socket connect hides ambient DATABASE_URL from the SQL ctor (issue #45)", async () => {
    const poison = `postgresql://dsh_app:${CONNECT_SECRET}@/dsh?host=/cloudsql/p:r:i`;
    const prev = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = poison;
    try {
      seen.length = 0;
      let observed: string | undefined = "not-observed";
      class RecordingSql extends StubSql {
        constructor(target: BunSqlConnectionTarget) {
          super(target);
          observed = process.env["DATABASE_URL"];
        }
      }
      await BunSqlQueryExecutor.connect(
        `postgresql://dsh_app:${CONNECT_SECRET}@/dsh?host=/cloudsql/p:r:i`,
        RecordingSql,
      );
      expect(observed).toBeUndefined();
      expect(seen[0]).toEqual({
        path: "/cloudsql/p:r:i",
        username: "dsh_app",
        password: CONNECT_SECRET,
        database: "dsh",
      });
      expect(process.env["DATABASE_URL"]).toBe(poison);
    } finally {
      if (prev === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// MAJOR-1: transactional lease read takes SELECT ... FOR UPDATE
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-01T00:00:00Z");

function leaseRow(controllerId: string): LeaseRow {
  return {
    workspace_id: "ws-1",
    controller_id: controllerId,
    user_id: "user-1",
    expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    updated_at: NOW.toISOString(),
  };
}

describe("BunSqlLeaseStore.transaction isolation (MAJOR-1 fix)", () => {
  test("the transactional read locks the row (SELECT ... FOR UPDATE)", async () => {
    const executor = new LockingFakeExecutor();
    executor.seedLease(leaseRow("ctrl-1"));
    const store = new BunSqlLeaseStore(executor);

    await store.transaction(async (tx: LeaseTransaction) => {
      await tx.findByWorkspaceId("ws-1");
    });

    const read = executor.statements.find(
      (s) => s.toLowerCase().includes("from controller_leases") && s.toLowerCase().startsWith("select"),
    );
    expect(read).toBeDefined();
    expect(read!.toLowerCase()).toContain("for update");
  });

  test("a release racing a takeover serialises: the takeover's lease survives", async () => {
    const executor = new LockingFakeExecutor();
    executor.seedLease(leaseRow("ctrl-A"));
    const store = new BunSqlLeaseStore(executor);
    const service = new ControllerLeaseService({ store });

    // release: owner check reads ctrl-A and holds the FOR UPDATE row lock
    // until its transaction commits. takeover must therefore observe the
    // post-release state — its read blocks until the release commits.
    const releaseP = service.release("ws-1", "ctrl-A");
    const takeoverP = service.takeover("ws-1", "ctrl-B", "user-1");
    await Promise.all([releaseP, takeoverP]);

    const final = executor.peekLease("ws-1");
    // Without FOR UPDATE the release's owner check could see a stale
    // snapshot and its unconditional DELETE would wipe the takeover's
    // freshly committed lease — the row must be ctrl-B's, not missing.
    expect(final?.controller_id).toBe("ctrl-B");
  });

  test("a stale-owner release is refused once the takeover has committed", async () => {
    const executor = new LockingFakeExecutor();
    executor.seedLease(leaseRow("ctrl-A"));
    const store = new BunSqlLeaseStore(executor);
    const service = new ControllerLeaseService({ store });

    // Takeover first, then the demoted controller's release must fail the
    // owner check instead of deleting ctrl-B's lease.
    await service.takeover("ws-1", "ctrl-B", "user-1");
    await expect(service.release("ws-1", "ctrl-A")).rejects.toThrow(/not owner/);
    expect(executor.peekLease("ws-1")?.controller_id).toBe("ctrl-B");
  });
});

// ---------------------------------------------------------------------------
// SqlTransactionalStateStore.persist against the real schema (MAJOR-2 fix)
// ---------------------------------------------------------------------------

describe("SqlTransactionalStateStore.apply persist path (MAJOR-2 fix)", () => {
  test("persist writes the real workspace_checkpoints columns", async () => {
    const executor = new LockingFakeExecutor();
    executor.seedWorkspace("ws-1", "READY");
    const store = new SqlTransactionalStateStore(executor);

    await store.apply("ws-1", "READY", "STOPPED", "graceful-stop", async (tx) => {
      await tx.persist({
        baseCommitSha: "abc1234",
        gcsObject: "workspaces/ws-1/checkpoints/abc1234.bin",
      });
    });

    expect(executor.checkpoints.length).toBe(1);
    const row = executor.checkpoints[0]!;
    // The T4 schema shape: id UUID PK, workspace_id, NOT NULL base_commit_sha,
    // NOT NULL gcs_object. No `data` column exists (or is written).
    expect(row.id).toBeDefined();
    expect(row.workspace_id).toBe("ws-1");
    expect(row.base_commit_sha).toBe("abc1234");
    expect(row.gcs_object).toBe("workspaces/ws-1/checkpoints/abc1234.bin");
    expect(executor.statements.join("\n").toLowerCase()).not.toMatch(/insert into workspace_checkpoints\(workspace_id, data\)/);
    expect(executor.statements.join("\n").toLowerCase()).toContain("base_commit_sha");
  });

  test("persist rejects payloads that do not fit the schema", async () => {
    const executor = new LockingFakeExecutor();
    executor.seedWorkspace("ws-1", "READY");
    const store = new SqlTransactionalStateStore(executor);

    await expect(
      store.apply("ws-1", "READY", "STOPPED", "graceful-stop", async (tx) => {
        // The old broken shape: an opaque JSON blob without the NOT NULL
        // columns the schema requires.
        await tx.persist({ some: "opaque data" });
      }),
    ).rejects.toThrow(/baseCommitSha/);
    expect(executor.checkpoints.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SqlTransactionalStateStore CAS mismatch shape (issue #63 — must match the
// InMemoryTransactionalStore shape asserted in
// packages/workspace-runtime/src/store.test.ts)
// ---------------------------------------------------------------------------

describe("SqlTransactionalStateStore.apply CAS mismatch shape (issue #63)", () => {
  test("reports (actual current, intended target), not (stale from, current)", async () => {
    const executor = new LockingFakeExecutor();
    // The agent-host already recorded the restore failure while a stale
    // control-plane writer still expects STARTING (issue #60 shared row).
    executor.seedWorkspace("ws-1", "RESTORE_FAILED");
    const store = new SqlTransactionalStateStore(executor);

    const err = await store
      .apply("ws-1", "STARTING", "RESTORING", "stale-writer")
      .then(
        (): IllegalTransitionError | null => null,
        (e: unknown) => e as IllegalTransitionError,
      );
    // The old swapped construction produced
    // "illegal state transition: STARTING -> RESTORE_FAILED", which reads as
    // a forbidden table edge and sent issue #63 at a table bug that never
    // existed. The corrected shape names the real row state and the
    // attempted target.
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect(err!.from).toBe("RESTORE_FAILED");
    expect(err!.to).toBe("RESTORING");
    expect((await store.load("ws-1")) as string).toBe("RESTORE_FAILED");
  });
});
