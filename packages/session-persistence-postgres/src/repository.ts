import type { QueryExecutor } from "./executor.js";
import type {
  Workspace,
  CreateWorkspaceInput,
  UpdateWorkspacePatch,
  Session,
  CreateSessionInput,
  SessionEvent,
  NewSessionEvent,
  WorkspaceCheckpoint,
  RecordCheckpointInput,
} from "./types.js";

/**
 * Real PostgreSQL returns TIMESTAMPTZ columns as Date objects while the
 * in-memory fake returns the strings it was given. The row types promise
 * ISO strings, so normalize here — otherwise the two backends return
 * different shapes for the same row.
 */
function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toIsoStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIsoString(value);
}

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row["id"] as string,
    ownerId: row["owner_id"] as string,
    repositoryOwner: row["repository_owner"] as string,
    repositoryName: row["repository_name"] as string,
    baseBranch: row["base_branch"] as string,
    instanceName: (row["instance_name"] as string | null) ?? null,
    instanceUrl: (row["instance_url"] as string | null) ?? null,
    runtimeState: row["runtime_state"] as Workspace["runtimeState"],
    lastActivityAt: toIsoStringOrNull(row["last_activity_at"]),
    createdAt: toIsoString(row["created_at"]),
    updatedAt: toIsoString(row["updated_at"]),
  };
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row["id"] as string,
    workspaceId: row["workspace_id"] as string,
    metadata: (row["metadata"] as Record<string, unknown>) ?? {},
    createdAt: toIsoString(row["created_at"]),
    updatedAt: toIsoString(row["updated_at"]),
  };
}

function rowToCheckpoint(row: Record<string, unknown>): WorkspaceCheckpoint {
  return {
    id: row["id"] as string,
    workspaceId: row["workspace_id"] as string,
    baseCommitSha: row["base_commit_sha"] as string,
    gcsObject: row["gcs_object"] as string,
    createdAt: toIsoString(row["created_at"]),
  };
}

function rowToEvent(row: Record<string, unknown>): SessionEvent {
  return {
    sessionId: row["session_id"] as string,
    seq: Number(row["seq"]),
    eventType: row["event_type"] as string,
    eventTime: Number(row["event_time"]),
    data: row["data"] as unknown,
    sourceEventSeqs: row["source_event_seqs"] as unknown,
    surfaceOp: row["surface_op"] as unknown,
  };
}

export interface SessionPersistenceRepository {
  // Workspace CRUD
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | null>;
  listWorkspaces(): Promise<Workspace[]>;
  /**
   * Fetches exactly the given workspaces in ONE query (issue #137: the list
   * route resolves visible ids from the MembershipStore first, then loads
   * the rows with `WHERE id = ANY($1)` — no full scan, no per-row round
   * trip). Unknown ids are silently skipped. Empty input answers [] without
   * touching the database.
   */
  listWorkspacesByIds(ids: string[]): Promise<Workspace[]>;
  updateWorkspace(id: string, patch: UpdateWorkspacePatch): Promise<Workspace>;
  updateRuntimeState(id: string, runtimeState: Workspace["runtimeState"]): Promise<Workspace>;
  updateLastActivityAt(id: string, lastActivityAt: string): Promise<Workspace>;
  /**
   * Deletes a workspace and everything under it (sessions, session events,
   * checkpoints, controller lease) in one transaction (issue #85 案B: the
   * schema has no ON DELETE CASCADE, so the application deletes children
   * first). Returns false when the workspace does not exist.
   */
  deleteWorkspace(id: string): Promise<boolean>;

  // Session CRUD
  createSession(input: CreateSessionInput): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(workspaceId: string): Promise<Session[]>;

  // Event log (append-only)
  append(sessionId: string, events: NewSessionEvent[]): Promise<SessionEvent[]>;
  readEvents(sessionId: string, fromSeq?: number): Promise<SessionEvent[]>;

  // Checkpoint write-audit (workspace_checkpoints). Issue #95: every GCS
  // checkpoint write must leave one row here — the table existed with an
  // INSERT implementation and tests, yet production never wrote a row
  // because no checkpoint path reached it. Issue #110: the rows all point
  // at the same live key (`workspaces/<id>/checkpoint.bin`, overwritten
  // per upload), so this table is the audit of "which base commit was
  // durably written when" — NOT a generation index, and NOT read by
  // restores (those fetch the live GCS key directly). Past generations live
  // only as versioned noncurrent GCS objects (30-day expiry).
  recordCheckpoint(input: RecordCheckpointInput): Promise<WorkspaceCheckpoint>;
  listCheckpoints(workspaceId: string): Promise<WorkspaceCheckpoint[]>;

  // Utilities
  assertContiguous(sessionId: string): Promise<void>;
}

export class PostgresSessionPersistenceRepository implements SessionPersistenceRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    await this.executor.exec(
      `INSERT INTO workspaces(id, owner_id, repository_owner, repository_name, base_branch, instance_name, instance_url, runtime_state, last_activity_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.id,
        input.ownerId,
        input.repositoryOwner,
        input.repositoryName,
        input.baseBranch,
        input.instanceName ?? null,
        input.instanceUrl ?? null,
        input.runtimeState ?? "STOPPED",
        null,
      ],
    );
    const w = await this.getWorkspace(input.id);
    if (!w) throw new Error(`failed to create workspace ${input.id}`);
    return w;
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const rows = await this.executor.query<Record<string, unknown>>(
      "SELECT * FROM workspaces WHERE id = $1",
      [id],
    );
    if (rows.length === 0) return null;
    return rowToWorkspace(rows[0]!);
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const rows = await this.executor.query<Record<string, unknown>>(
      "SELECT * FROM workspaces ORDER BY created_at ASC",
    );
    return rows.map(rowToWorkspace);
  }

  async listWorkspacesByIds(ids: string[]): Promise<Workspace[]> {
    if (ids.length === 0) return [];
    const rows = await this.executor.query<Record<string, unknown>>(
      "SELECT * FROM workspaces WHERE id = ANY($1) ORDER BY created_at ASC",
      [ids],
    );
    return rows.map(rowToWorkspace);
  }

  async updateWorkspace(id: string, patch: UpdateWorkspacePatch): Promise<Workspace> {
    // Generic SQL path: build dynamic SET clause
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (patch.runtimeState !== undefined) {
      sets.push(`runtime_state = $${idx++}`);
      params.push(patch.runtimeState);
    }
    if (patch.lastActivityAt !== undefined) {
      sets.push(`last_activity_at = $${idx++}`);
      params.push(patch.lastActivityAt);
    }
    if (patch.instanceName !== undefined) {
      sets.push(`instance_name = $${idx++}`);
      params.push(patch.instanceName);
    }
    if (patch.instanceUrl !== undefined) {
      sets.push(`instance_url = $${idx++}`);
      params.push(patch.instanceUrl);
    }
    if (sets.length === 0) {
      const w = await this.getWorkspace(id);
      if (!w) throw new Error(`workspace not found: ${id}`);
      return w;
    }
    sets.push(`updated_at = now()`);
    params.push(id);
    await this.executor.exec(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = $${idx}`, params);
    const updated = await this.getWorkspace(id);
    if (!updated) throw new Error(`workspace not found after update: ${id}`);
    return updated;
  }

  async updateRuntimeState(id: string, runtimeState: Workspace["runtimeState"]): Promise<Workspace> {
    return this.updateWorkspace(id, { runtimeState });
  }

  async updateLastActivityAt(id: string, lastActivityAt: string): Promise<Workspace> {
    return this.updateWorkspace(id, { lastActivityAt });
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    return this.executor.transaction(async (tx) => {
      const existing = await tx.query<Record<string, unknown>>(
        "SELECT * FROM workspaces WHERE id = $1",
        [id],
      );
      if (existing.length === 0) return false;
      // No ON DELETE CASCADE in 0001_init.sql, so children go first
      // (events reference sessions, sessions/checkpoints/leases reference
      // the workspace). The IN-subquery shape below is load-bearing for the
      // in-memory fake: a workspace-scoped cascade is the ONLY allowed
      // DELETE on session_events (ad-hoc event mutation stays rejected —
      // see fakeExecutor.ts).
      await tx.exec(
        "DELETE FROM session_events WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = $1)",
        [id],
      );
      await tx.exec("DELETE FROM sessions WHERE workspace_id = $1", [id]);
      await tx.exec("DELETE FROM workspace_checkpoints WHERE workspace_id = $1", [id]);
      await tx.exec("DELETE FROM controller_leases WHERE workspace_id = $1", [id]);
      await tx.exec("DELETE FROM workspaces WHERE id = $1", [id]);
      return true;
    });
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    await this.executor.exec(
      `INSERT INTO sessions(id, workspace_id, metadata) VALUES ($1,$2,$3)`,
      [input.id, input.workspaceId, JSON.stringify(input.metadata ?? {})],
    );
    const s = await this.getSession(input.id);
    if (!s) throw new Error(`failed to create session ${input.id}`);
    return s;
  }

  async getSession(id: string): Promise<Session | null> {
    const rows = await this.executor.query<Record<string, unknown>>(
      "SELECT * FROM sessions WHERE id = $1",
      [id],
    );
    if (rows.length === 0) return null;
    const row = rows[0]!;
    // Normalize metadata if stored as JSON string
    if (typeof row["metadata"] === "string") {
      try {
        row["metadata"] = JSON.parse(row["metadata"] as string) as Record<string, unknown>;
      } catch {
        // leave as-is
      }
    }
    return rowToSession(row);
  }

  async listSessions(workspaceId: string): Promise<Session[]> {
    const rows = await this.executor.query<Record<string, unknown>>(
      "SELECT * FROM sessions WHERE workspace_id = $1 ORDER BY created_at ASC",
      [workspaceId],
    );
    return rows.map((r) => {
      if (typeof r["metadata"] === "string") {
        try {
          r["metadata"] = JSON.parse(r["metadata"] as string) as Record<string, unknown>;
        } catch {}
      }
      return rowToSession(r);
    });
  }

  /**
   * Append events atomically inside a transaction: allocates a contiguous seq
   * range and inserts the batch before commit. Never produces gaps or
   * duplicates under concurrency. Persisted events are immutable (no UPDATE path).
   *
   * Serialization comes from locking the PARENT `sessions` row
   * (`SELECT ... FOR UPDATE`) — never from locking `session_events` rows.
   * PostgreSQL rejects `FOR UPDATE` on aggregate queries
   * (`SELECT max(seq) ... FOR UPDATE` fails with
   * "FOR UPDATE is not allowed with aggregate functions", issue #70), and
   * locking the newest event row instead would not serialize the zero-events
   * case (no row exists to lock). The parent row always exists here (append
   * to a missing session is rejected), so concurrent appends to the same
   * session always serialize on that lock: a follower blocks until the
   * leader commits, then reads the fresh `max(seq)`.
   */
  async append(sessionId: string, events: NewSessionEvent[]): Promise<SessionEvent[]> {
    if (events.length === 0) return [];
    return this.executor.transaction(async (tx) => {
      // Lock the parent session row FIRST: this serializes concurrent
      // appends to the same session (the lock is held until commit, so a
      // follower's max(seq) read below observes the leader's inserts).
      // Doubles as the existence check. Must precede the max(seq) read.
      const sessionRows = await tx.query<Record<string, unknown>>(
        "SELECT id FROM sessions WHERE id = $1 FOR UPDATE",
        [sessionId],
      );
      if (sessionRows.length === 0) throw new Error(`session not found: ${sessionId}`);

      // Plain aggregate read — NO locking clause. PostgreSQL rejects
      // `FOR UPDATE` alongside aggregates (issue #70). Safe without it:
      // the parent-row lock above already serialized concurrent writers.
      const maxRows = await tx.query<{ max: number | null }>(
        "SELECT max(seq) as max FROM session_events WHERE session_id = $1",
        [sessionId],
      );
      const currentMax = maxRows[0]?.max ?? null;
      let nextSeq = currentMax === null ? 0 : Number(currentMax) + 1;

      const persisted: SessionEvent[] = [];
      for (const e of events) {
        const seq = nextSeq++;
        await tx.exec(
          `INSERT INTO session_events(session_id, seq, event_type, event_time, data, source_event_seqs, surface_op)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [sessionId, seq, e.eventType, e.eventTime, JSON.stringify(e.data), e.sourceEventSeqs ? JSON.stringify(e.sourceEventSeqs) : null, e.surfaceOp ? JSON.stringify(e.surfaceOp) : null],
        );

        // Normalize JSON round-trip for fake
        let data: unknown = e.data;
        let sourceEventSeqs: unknown = e.sourceEventSeqs;
        let surfaceOp: unknown = e.surfaceOp;
        // In fake, exec stored JSON stringified data; re-hydrate for return value
        // Keep original objects for returned events.

        persisted.push({
          sessionId,
          seq,
          eventType: e.eventType,
          eventTime: e.eventTime,
          data,
          sourceEventSeqs,
          surfaceOp,
        });
      }

      // Validate contiguity was preserved inside the same transaction.
      // This is NOT redundant: it is the backstop that turns a lost
      // serialization guarantee into a loud error instead of silent
      // corruption. If the parent-row lock above ever stops working (e.g.
      // it is removed, or a new executor ignores the locking clause — cf.
      // issue #70, where the fake silently skipped it), the append fails
      // here rather than persisting a gap or duplicate.
      const all = await tx.query<Record<string, unknown>>(
        "SELECT seq FROM session_events WHERE session_id = $1 ORDER BY seq ASC",
        [sessionId],
      );
      const seqs = all.map((r) => Number(r["seq"])).sort((a, b) => a - b);
      for (let i = 0; i < seqs.length; i++) {
        if (seqs[i] !== i) {
          throw new Error(`gap detected in session ${sessionId}: expected seq ${i} but found ${seqs[i]}`);
        }
      }

      return persisted;
    });
  }

  async readEvents(sessionId: string, fromSeq?: number): Promise<SessionEvent[]> {
    const rows =
      fromSeq === undefined
        ? await this.executor.query<Record<string, unknown>>(
            "SELECT * FROM session_events WHERE session_id = $1 ORDER BY seq ASC",
            [sessionId],
          )
        : await this.executor.query<Record<string, unknown>>(
            "SELECT * FROM session_events WHERE session_id = $1 AND seq >= $2 ORDER BY seq ASC",
            [sessionId, fromSeq],
          );

    const events = rows.map((r) => {
      // Normalize JSON columns if stored as strings
      let data: unknown = r["data"];
      if (typeof data === "string") {
        try {
          data = JSON.parse(data as string) as unknown;
        } catch {}
      }
      let sourceEventSeqs: unknown = r["source_event_seqs"];
      if (typeof sourceEventSeqs === "string") {
        try {
          sourceEventSeqs = JSON.parse(sourceEventSeqs as string) as unknown;
        } catch {}
      }
      let surfaceOp: unknown = r["surface_op"];
      if (typeof surfaceOp === "string") {
        try {
          surfaceOp = JSON.parse(surfaceOp as string) as unknown;
        } catch {}
      }
      return {
        sessionId: r["session_id"] as string,
        seq: Number(r["seq"]),
        eventType: r["event_type"] as string,
        eventTime: Number(r["event_time"]),
        data,
        sourceEventSeqs,
        surfaceOp,
      } as SessionEvent;
    });

    return events;
  }

  async assertContiguous(sessionId: string): Promise<void> {
    const events = await this.readEvents(sessionId);
    for (let i = 0; i < events.length; i++) {
      if (events[i]!.seq !== i) {
        throw new Error(`gap detected in session ${sessionId}: expected seq ${i} but got ${events[i]!.seq}`);
      }
    }
  }

  /**
   * Appends one write-audit row for a durable GCS upload (issue #95 案A,
   * clarified by #110: every upload overwrites the same live key, so rows
   * accumulate as an audit trail, not a retrievable generation index).
   * The id is database-generated (gen_random_uuid, same convention as the
   * transition-atomic persist path in the SQL state stores) so concurrent
   * writers never collide.
   */
  async recordCheckpoint(input: RecordCheckpointInput): Promise<WorkspaceCheckpoint> {
    const rows = await this.executor.query<Record<string, unknown>>(
      `INSERT INTO workspace_checkpoints(id, workspace_id, base_commit_sha, gcs_object)
       VALUES (gen_random_uuid(),$1,$2,$3)
       RETURNING id, workspace_id, base_commit_sha, gcs_object, created_at`,
      [input.workspaceId, input.baseCommitSha, input.gcsObject],
    );
    if (rows.length === 0) throw new Error(`failed to record checkpoint for workspace ${input.workspaceId}`);
    return rowToCheckpoint(rows[0]!);
  }

  async listCheckpoints(workspaceId: string): Promise<WorkspaceCheckpoint[]> {
    const rows = await this.executor.query<Record<string, unknown>>(
      `SELECT id, workspace_id, base_commit_sha, gcs_object, created_at
       FROM workspace_checkpoints WHERE workspace_id = $1 ORDER BY created_at ASC`,
      [workspaceId],
    );
    return rows.map(rowToCheckpoint);
  }
}
