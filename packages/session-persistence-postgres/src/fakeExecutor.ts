import type { QueryExecutor } from "./executor.js";
import type { SessionEvent, Workspace, Session } from "./types.js";

/**
 * In-memory fake that implements QueryExecutor.
 * - Supports the exact SQL patterns emitted by PostgresSessionPersistence / repository / runner.
 * - Simulates transactions via copy-on-write + a serialized transaction queue to expose races.
 * - Rejects UPDATE/DELETE on session_events (immutability).
 * - Allows direct gap injection via `__injectGap` for testing.
 */

type WorkspaceRow = Workspace;
type SessionRow = Session;

/** Stored shape mirrors the workspace_checkpoints row (snake_case columns). */
export interface FakeCheckpointRow {
  id: string;
  workspace_id: string;
  base_commit_sha: string;
  gcs_object: string;
  created_at: string;
}

interface FakeTables {
  workspaces: Map<string, WorkspaceRow>;
  sessions: Map<string, SessionRow>;
  sessionEvents: Map<string, SessionEvent[]>; // key: sessionId -> sorted by seq
  workspaceCheckpoints: Map<string, FakeCheckpointRow>; // key: checkpoint id
  controllerLeases: Map<string, unknown>;
  schemaMigrations: Set<string>;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function cloneTables(t: FakeTables): FakeTables {
  return {
    workspaces: new Map(Array.from(t.workspaces.entries()).map(([k, v]) => [k, deepClone(v)])),
    sessions: new Map(Array.from(t.sessions.entries()).map(([k, v]) => [k, deepClone(v)])),
    sessionEvents: new Map(
      Array.from(t.sessionEvents.entries()).map(([k, v]) => [k, v.map(deepClone)]),
    ),
    workspaceCheckpoints: new Map(
      Array.from(t.workspaceCheckpoints.entries()).map(([k, v]) => [k, deepClone(v)]),
    ),
    controllerLeases: new Map(t.controllerLeases),
    schemaMigrations: new Set(t.schemaMigrations),
  };
}

export class InMemoryFakeExecutor implements QueryExecutor {
  private tables: FakeTables = {
    workspaces: new Map(),
    sessions: new Map(),
    sessionEvents: new Map(),
    workspaceCheckpoints: new Map(),
    controllerLeases: new Map(),
    schemaMigrations: new Set(),
  };

  // Serializes concurrent transactions (simulates row-level locking + queuing)
  private txQueue: Promise<void> = Promise.resolve();

  // For testing: inject a gap (skip a seq) by manually inserting with non-contiguous seq
  __injectEvent(sessionId: string, event: SessionEvent): void {
    const arr = this.tables.sessionEvents.get(sessionId) ?? [];
    arr.push(deepClone(event));
    arr.sort((a, b) => a.seq - b.seq);
    this.tables.sessionEvents.set(sessionId, arr);
  }

  __getTables(): FakeTables {
    return this.tables;
  }

  __reset(): void {
    this.tables = {
      workspaces: new Map(),
      sessions: new Map(),
      sessionEvents: new Map(),
      workspaceCheckpoints: new Map(),
      controllerLeases: new Map(),
      schemaMigrations: new Set(),
    };
  }

  async exec(sql: string, params?: unknown[]): Promise<void> {
    const s = sql.trim().toLowerCase();
    // Reject mutation of persisted events
    if (s.startsWith("update session_events") || s.startsWith("delete from session_events")) {
      throw new Error("session_events is append-only: UPDATE/DELETE is rejected");
    }
    // Handle other execs via query path for simplicity (some callers use exec for inserts)
    await this.query(sql, params);
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    const lower = normalized.toLowerCase();

    // Issue #70: fail fast on locking clauses real PostgreSQL rejects.
    // `SELECT max(seq) ... FOR UPDATE` used to be silently treated as a
    // plain select here, so invalid SQL passed every test and only failed
    // against a real database. PostgreSQL rejects any locking clause
    // combined with an aggregate function ("FOR UPDATE is not allowed with
    // aggregate functions"), so the fake rejects it too instead of silently
    // ignoring the lock. Plain `SELECT max(seq)` (no locking clause) and
    // `SELECT ... FOR UPDATE` (no aggregate) remain accepted.
    if (/\bfor\s+update\b/i.test(normalized) && /\b(max|min|sum|avg|count)\s*\(/i.test(normalized)) {
      throw new Error(
        `InMemoryFakeExecutor: locking clause with aggregate function is rejected by PostgreSQL: ${normalized}`,
      );
    }

    // schema_migrations DDL / inserts
    if (lower.includes("create table if not exists schema_migrations")) {
      return [] as T[];
    }
    if (lower.startsWith("select version from schema_migrations")) {
      const rows = Array.from(this.tables.schemaMigrations).map((v) => ({ version: v }));
      return rows as unknown as T[];
    }
    if (lower.startsWith("insert into schema_migrations")) {
      const version = params?.[0] as string;
      if (this.tables.schemaMigrations.has(version)) {
        throw new Error(`duplicate schema_migrations version: ${version}`);
      }
      this.tables.schemaMigrations.add(version);
      return [] as T[];
    }
    if (lower.startsWith("create table workspaces") || lower.startsWith("create table sessions") || lower.startsWith("create table session_events") || lower.startsWith("create table workspace_checkpoints") || lower.startsWith("create table controller_leases") || lower.startsWith("create index")) {
      // DDL from 0001_init.sql — no-op in fake (tables are implicit)
      return [] as T[];
    }

    // Workspaces
    if (lower.startsWith("insert into workspaces")) {
      // INSERT INTO workspaces(id, owner_id, repository_owner, repository_name, base_branch, ...) VALUES ($1,...)
      const id = params?.[0] as string;
      if (this.tables.workspaces.has(id)) throw new Error(`duplicate workspace id: ${id}`);
      // Also check unique instance_name if provided
      const instanceName = params?.[5] as string | null | undefined;
      if (instanceName) {
        for (const w of this.tables.workspaces.values()) {
          if (w.instanceName === instanceName) throw new Error(`duplicate instance_name: ${instanceName}`);
        }
      }
      const row: Workspace = {
        id,
        ownerId: params?.[1] as string,
        repositoryOwner: params?.[2] as string,
        repositoryName: params?.[3] as string,
        baseBranch: params?.[4] as string,
        instanceName: (params?.[5] as string | null) ?? null,
        instanceUrl: (params?.[6] as string | null) ?? null,
        runtimeState: (params?.[7] as Workspace["runtimeState"]) ?? "STOPPED",
        lastActivityAt: (params?.[8] as string | null) ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.tables.workspaces.set(id, row);
      return [] as T[];
    }
    if (lower.startsWith("select") && lower.includes("from workspaces")) {
      const idParam = params?.[0] as string | undefined;
      if (idParam && lower.includes("where id =")) {
        const w = this.tables.workspaces.get(idParam);
        return (w ? [toWorkspaceRow(w)] : []) as unknown as T[];
      }
      // list all or filter — return all for tests
      return Array.from(this.tables.workspaces.values()).map(toWorkspaceRow) as unknown as T[];
    }
    if (lower.startsWith("update workspaces")) {
      const setMatch = normalized.match(/set\s+(.+?)\s+where\s+/i);
      const whereMatch = normalized.match(/where\s+id\s*=\s*\$(\d+)/i);
      if (!setMatch || !whereMatch) {
        throw new Error(`InMemoryFakeExecutor: unhandled UPDATE workspaces SQL: ${normalized}`);
      }
      const setClause = setMatch[1]!;
      const whereParamIdx = parseInt(whereMatch[1]!, 10) - 1;
      const id = params?.[whereParamIdx] as string;
      const w = this.tables.workspaces.get(id);
      if (!w) throw new Error(`workspace not found: ${id}`);
      const assignments = setClause
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const next: Workspace = { ...w };
      for (const assign of assignments) {
        if (assign.includes("updated_at")) continue;
        const eqIdx = assign.indexOf("=");
        if (eqIdx === -1) continue;
        const col = assign.slice(0, eqIdx).trim().toLowerCase();
        const valExpr = assign.slice(eqIdx + 1).trim();
        const paramMatch = valExpr.match(/\$(\d+)/);
        if (!paramMatch) continue;
        const paramIdx = parseInt(paramMatch[1]!, 10) - 1;
        const val = params?.[paramIdx] as unknown;
        switch (col) {
          case "runtime_state":
            (next as unknown as Record<string, unknown>)["runtimeState"] = val;
            break;
          case "last_activity_at":
            (next as unknown as Record<string, unknown>)["lastActivityAt"] = val;
            break;
          case "instance_name":
            (next as unknown as Record<string, unknown>)["instanceName"] = val;
            break;
          case "instance_url":
            (next as unknown as Record<string, unknown>)["instanceUrl"] = val;
            break;
          case "owner_id":
            (next as unknown as Record<string, unknown>)["ownerId"] = val;
            break;
          case "repository_owner":
            (next as unknown as Record<string, unknown>)["repositoryOwner"] = val;
            break;
          case "repository_name":
            (next as unknown as Record<string, unknown>)["repositoryName"] = val;
            break;
          case "base_branch":
            (next as unknown as Record<string, unknown>)["baseBranch"] = val;
            break;
          default:
            break;
        }
      }
      (next as unknown as Record<string, unknown>)["updatedAt"] = new Date().toISOString();
      this.tables.workspaces.set(id, next);
      return [] as T[];
    }

    // Sessions
    if (lower.startsWith("insert into sessions")) {
      const id = params?.[0] as string;
      if (this.tables.sessions.has(id)) throw new Error(`duplicate session id: ${id}`);
      const workspaceId = params?.[1] as string;
      if (!this.tables.workspaces.has(workspaceId)) throw new Error(`workspace not found: ${workspaceId}`);
      const rawMeta = params?.[2] as unknown;
      let metadata: Record<string, unknown>;
      if (typeof rawMeta === "string") {
        try {
          metadata = JSON.parse(rawMeta) as Record<string, unknown>;
        } catch {
          metadata = {};
        }
      } else {
        metadata = (rawMeta as Record<string, unknown>) ?? {};
      }
      const row: Session = {
        id,
        workspaceId,
        metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.tables.sessions.set(id, row);
      return [] as T[];
    }
    if (lower.startsWith("select") && lower.includes("from sessions")) {
      const idParam = params?.[0] as string | undefined;
      if (lower.includes("where id =")) {
        const s = this.tables.sessions.get(idParam!);
        return (s ? [toSessionRow(s)] : []) as unknown as T[];
      }
      if (lower.includes("where workspace_id =")) {
        const wsId = params?.[0] as string;
        const rows = Array.from(this.tables.sessions.values())
          .filter((s) => s.workspaceId === wsId)
          .map(toSessionRow);
        return rows as unknown as T[];
      }
      return Array.from(this.tables.sessions.values()).map(toSessionRow) as unknown as T[];
    }

    // session_events SELECT / INSERT — check max before generic select
    if (lower.startsWith("select max(seq)") && lower.includes("from session_events")) {
      const sessionId = params?.[0] as string;
      const events = this.tables.sessionEvents.get(sessionId) ?? [];
      const max = events.length === 0 ? null : Math.max(...events.map((e) => e.seq));
      return [{ max } as unknown as T];
    }
    if (lower.startsWith("select") && lower.includes("from session_events")) {
      const sessionId = params?.[0] as string;
      let events = this.tables.sessionEvents.get(sessionId) ?? [];
      // fromSeq support: WHERE session_id = $1 AND seq >= $2
      if (lower.includes("seq >=") || lower.includes("seq >")) {
        const fromSeq = params?.[1] as number;
        const op = lower.includes("seq >=") ? ">=" : ">";
        events = events.filter((e) => (op === ">=" ? e.seq >= fromSeq : e.seq > fromSeq));
      }
      events = [...events].sort((a, b) => a.seq - b.seq);
      return events.map(toEventRow) as unknown as T[];
    }
    if (lower.startsWith("insert into session_events")) {
      const sessionId = params?.[0] as string;
      const seq = params?.[1] as number;
      const arr = this.tables.sessionEvents.get(sessionId) ?? [];
      if (arr.some((e) => e.seq === seq)) {
        const err = new Error(`duplicate key value violates unique constraint "session_events_pkey" (session_id, seq)=(${sessionId}, ${seq})`);
        (err as unknown as Record<string, unknown>)["code"] = "23505";
        throw err;
      }
      // Gap detection: if max existing +1 != seq and not 0 insert, we allow but read can detect; append layer prevents gaps
      const event: SessionEvent = {
        sessionId,
        seq,
        eventType: params?.[2] as string,
        eventTime: params?.[3] as number,
        data: params?.[4] as unknown,
        sourceEventSeqs: params?.[5] as unknown,
        surfaceOp: params?.[6] as unknown,
      };
      arr.push(deepClone(event));
      arr.sort((a, b) => a.seq - b.seq);
      this.tables.sessionEvents.set(sessionId, arr);
      return [] as T[];
    }

    // workspace_checkpoints — real storage (issue #95): every GCS
    // checkpoint write appends one row; the (workspace_id, created_at)
    // index is the generation history. Accepts both the repository
    // recordCheckpoint shape (gen_random_uuid() id) and the
    // transition-atomic persist shape from the SQL state stores.
    if (lower.startsWith("insert into workspace_checkpoints")) {
      const row: FakeCheckpointRow = {
        id: `00000000-0000-4000-8000-${String(this.tables.workspaceCheckpoints.size + 1).padStart(12, "0")}`,
        workspace_id: params?.[0] as string,
        base_commit_sha: params?.[1] as string,
        gcs_object: params?.[2] as string,
        created_at: new Date().toISOString(),
      };
      this.tables.workspaceCheckpoints.set(row.id, row);
      if (/\breturning\b/i.test(normalized)) {
        return [{ ...row }] as unknown as T[];
      }
      return [] as T[];
    }
    if (lower.startsWith("select") && lower.includes("from workspace_checkpoints")) {
      const workspaceId = params?.[0] as string | undefined;
      const rows = Array.from(this.tables.workspaceCheckpoints.values())
        .filter((r) => workspaceId === undefined || r.workspace_id === workspaceId)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
        .map((r) => ({ ...r }));
      return rows as unknown as T[];
    }
    if (lower.startsWith("insert into controller_leases") || lower.includes("controller_leases")) {
      return [] as T[];
    }

    // Fallback: unknown SQL — treat as no-op for DDL; throw for unexpected DML to surface missing impl
    if (lower.startsWith("create") || lower.startsWith("drop")) return [] as T[];
    throw new Error(`InMemoryFakeExecutor: unhandled SQL: ${normalized} params=${JSON.stringify(params)}`);
  }

  async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    // Serialize transactions to mimic DB locking (FOR UPDATE queue)
    const run = async (): Promise<T> => {
      const snapshot = cloneTables(this.tables);
      // Create a transaction-scoped executor that operates on the snapshot
      const txExecutor = new InMemoryFakeTransactionExecutor(snapshot, this);
      try {
        const result = await fn(txExecutor);
        // Commit: replace main tables with snapshot
        this.tables = snapshot;
        return result;
      } catch (e) {
        // Rollback: discard snapshot
        throw e;
      }
    };

    // Queue
    const resultPromise = this.txQueue.then(run, run);
    // Update queue to wait for this transaction (swallow errors so queue continues)
    this.txQueue = resultPromise.then(
      () => {},
      () => {},
    );
    return resultPromise;
  }

  // Repository helpers for workspace updates (bypass generic UPDATE parsing)
  async __updateWorkspace(id: string, patch: Partial<Workspace>): Promise<Workspace> {
    const w = this.tables.workspaces.get(id);
    if (!w) throw new Error(`workspace not found: ${id}`);
    const next: Workspace = {
      ...w,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.tables.workspaces.set(id, next);
    return next;
  }
}

class InMemoryFakeTransactionExecutor implements QueryExecutor {
  constructor(
    private snapshot: FakeTables,
    private parent: InMemoryFakeExecutor,
  ) {}

  async exec(sql: string, params?: unknown[]): Promise<void> {
    const s = sql.trim().toLowerCase();
    if (s.startsWith("update session_events") || s.startsWith("delete from session_events")) {
      throw new Error("session_events is append-only: UPDATE/DELETE is rejected");
    }
    await this.query(sql, params);
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    // Delegate to a temporary executor backed by snapshot
    const tmp = new InMemoryFakeExecutor();
    // Share snapshot directly
    (tmp as unknown as { tables: FakeTables }).tables = this.snapshot;
    // Avoid queueing nested transactions via parent queue — run directly on snapshot.
    // NOTE (issue #70): locking semantics are NOT silently skipped here.
    // Plain `SELECT max(seq)` is answered from the snapshot (transaction
    // serialization itself comes from txQueue), but a locking clause paired
    // with an aggregate is rejected by the guard in query() above, exactly
    // as real PostgreSQL rejects it — so such SQL can never pass tests
    // against the fake and fail only in production again.
    return tmp.query<T>(sql, params);
  }

  async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    // Nested transaction: savepoint-like — snapshot copy
    const nestedSnapshot = cloneTables(this.snapshot);
    const nested = new InMemoryFakeTransactionExecutor(nestedSnapshot, this.parent);
    try {
      const result = await fn(nested);
      // Merge nested snapshot back
      Object.assign(this.snapshot, nestedSnapshot);
      // Need to reassign maps correctly
      this.snapshot.workspaces = nestedSnapshot.workspaces;
      this.snapshot.sessions = nestedSnapshot.sessions;
      this.snapshot.sessionEvents = nestedSnapshot.sessionEvents;
      this.snapshot.schemaMigrations = nestedSnapshot.schemaMigrations;
      return result;
    } catch (e) {
      throw e;
    }
  }
}

function toWorkspaceRow(w: Workspace): Record<string, unknown> {
  return {
    id: w.id,
    owner_id: w.ownerId,
    repository_owner: w.repositoryOwner,
    repository_name: w.repositoryName,
    base_branch: w.baseBranch,
    instance_name: w.instanceName,
    instance_url: w.instanceUrl,
    runtime_state: w.runtimeState,
    last_activity_at: w.lastActivityAt,
    created_at: w.createdAt,
    updated_at: w.updatedAt,
  };
}

function toSessionRow(s: Session): Record<string, unknown> {
  return {
    id: s.id,
    workspace_id: s.workspaceId,
    metadata: s.metadata,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

function toEventRow(e: SessionEvent): Record<string, unknown> {
  return {
    session_id: e.sessionId,
    seq: e.seq,
    event_type: e.eventType,
    event_time: e.eventTime,
    data: e.data,
    source_event_seqs: e.sourceEventSeqs,
    surface_op: e.surfaceOp,
  };
}
