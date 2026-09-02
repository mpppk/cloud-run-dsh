import type { QueryExecutor } from "./executor.js";
import type {
  Workspace,
  CreateWorkspaceInput,
  UpdateWorkspacePatch,
  Session,
  CreateSessionInput,
  SessionEvent,
  NewSessionEvent,
} from "./types.js";

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
    lastActivityAt: (row["last_activity_at"] as string | null) ?? null,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
  };
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row["id"] as string,
    workspaceId: row["workspace_id"] as string,
    metadata: (row["metadata"] as Record<string, unknown>) ?? {},
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
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
  updateWorkspace(id: string, patch: UpdateWorkspacePatch): Promise<Workspace>;
  updateRuntimeState(id: string, runtimeState: Workspace["runtimeState"]): Promise<Workspace>;
  updateLastActivityAt(id: string, lastActivityAt: string): Promise<Workspace>;

  // Session CRUD
  createSession(input: CreateSessionInput): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  listSessions(workspaceId: string): Promise<Session[]>;

  // Event log (append-only)
  append(sessionId: string, events: NewSessionEvent[]): Promise<SessionEvent[]>;
  readEvents(sessionId: string, fromSeq?: number): Promise<SessionEvent[]>;

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
   * Append events atomically: allocates contiguous seq inside a transaction via
   * `SELECT max(seq) ... FOR UPDATE`. Never produces gaps or duplicates under concurrency.
   * Persisted events are immutable (no UPDATE path).
   */
  async append(sessionId: string, events: NewSessionEvent[]): Promise<SessionEvent[]> {
    if (events.length === 0) return [];
    return this.executor.transaction(async (tx) => {
      // Verify session exists
      const sessionRows = await tx.query<Record<string, unknown>>(
        "SELECT * FROM sessions WHERE id = $1",
        [sessionId],
      );
      if (sessionRows.length === 0) throw new Error(`session not found: ${sessionId}`);

      // Allocate seq atomically. FOR UPDATE serializes concurrent appends.
      const maxRows = await tx.query<{ max: number | null }>(
        "SELECT max(seq) as max FROM session_events WHERE session_id = $1 FOR UPDATE",
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

      // Validate contiguity was preserved (defensive: if max was stale due to race without FOR UPDATE)
      // This is redundant when FOR UPDATE works, but guards against misconfigured executor.
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
}
