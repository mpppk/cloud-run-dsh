// Production adapters for the control-plane composition root (main.ts).
//
// The SQL adapters mirror `apps/agent-host/src/adapters.ts` (BunSqlQueryExecutor,
// BunSqlLeaseStore) — both apps talk to the same Cloud SQL schema over Bun.SQL.
// Extracting them into a shared package is a deliberate follow-up; duplicating
// here keeps P3 scoped to the Dockerfile + production entry.
//
// The runtime registry is an HONEST placeholder: the production composition of
// the T8 WorkspaceRuntime (Cloud Run instance client + checkpoint storage +
// GCS) is NOT wired in this milestone (P11a). Runtime-scoped operations fail
// fast with a dedicated typed error instead of silently misbehaving.

import type {
  ControllerLeaseRecord,
  LeaseStore,
  LeaseTransaction,
} from "@cloud-run-dsh/controller-lease";
import type { QueryExecutor as SessionQueryExecutor } from "@cloud-run-dsh/session-persistence-postgres";
import type { Workspace } from "@cloud-run-dsh/session-persistence-postgres";
import type { MembershipStore } from "./membership.js";
import { RuntimeRegistry } from "./deps.js";
import { ApiError } from "./errors.js";

// ---------------------------------------------------------------------------
// Cloud SQL (Postgres) QueryExecutor via Bun's built-in SQL client
// (mirrors apps/agent-host/src/adapters.ts)
// ---------------------------------------------------------------------------

interface UnsafeSqlClient {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
  begin<T>(fn: (tx: UnsafeSqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void> | undefined;
}

type SqlClientCtor = new (url: string) => UnsafeSqlClient;

export class BunSqlQueryExecutor implements SessionQueryExecutor {
  private constructor(private readonly client: UnsafeSqlClient) {}

  static async connect(databaseUrl: string): Promise<BunSqlQueryExecutor> {
    const mod = (await import("bun")) as unknown as { SQL: SqlClientCtor };
    return new BunSqlQueryExecutor(new mod.SQL(databaseUrl));
  }

  async exec(query: string, params?: unknown[]): Promise<void> {
    await this.client.unsafe(query, params);
  }

  async query<T = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<T[]> {
    return (await this.client.unsafe(query, params)) as T[];
  }

  async transaction<T>(fn: (tx: SessionQueryExecutor) => Promise<T>): Promise<T> {
    return this.client.begin((tx) =>
      fn(
        new BunSqlQueryExecutor(tx) as unknown as SessionQueryExecutor,
      ),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

// ---------------------------------------------------------------------------
// Cloud SQL (Postgres) LeaseStore for the controller lease (T6 seam)
// (mirrors apps/agent-host/src/adapters.ts; 実装手順書 section 26)
// ---------------------------------------------------------------------------

export class BunSqlLeaseStore implements LeaseStore {
  constructor(private readonly executor: SessionQueryExecutor) {}

  async upsertIfExpired(
    record: ControllerLeaseRecord,
    now: Date,
  ): Promise<ControllerLeaseRecord | null> {
    const rows = await this.executor.query<Record<string, unknown>>(
      `INSERT INTO controller_leases(workspace_id, controller_id, user_id, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id) DO UPDATE
         SET controller_id = EXCLUDED.controller_id,
             user_id = EXCLUDED.user_id,
             expires_at = EXCLUDED.expires_at,
             updated_at = EXCLUDED.updated_at
       WHERE controller_leases.expires_at <= $6
       RETURNING workspace_id, controller_id, user_id, expires_at, updated_at`,
      [
        record.workspaceId,
        record.controllerId,
        record.userId,
        record.expiresAt.toISOString(),
        record.updatedAt.toISOString(),
        now.toISOString(),
      ],
    );
    if (rows.length === 0) return null;
    return rowToLeaseRecord(rows[0]!);
  }

  async extendIfOwner(
    workspaceId: string,
    controllerId: string,
    extendTo: Date,
    now: Date,
  ): Promise<ControllerLeaseRecord | null> {
    const rows = await this.executor.query<Record<string, unknown>>(
      `UPDATE controller_leases
       SET expires_at = $3, updated_at = $4
       WHERE workspace_id = $1 AND controller_id = $2 AND expires_at > $5
       RETURNING workspace_id, controller_id, user_id, expires_at, updated_at`,
      [
        workspaceId,
        controllerId,
        extendTo.toISOString(),
        now.toISOString(),
        now.toISOString(),
      ],
    );
    if (rows.length === 0) return null;
    return rowToLeaseRecord(rows[0]!);
  }

  async transaction<T>(fn: (tx: LeaseTransaction) => Promise<T>): Promise<T> {
    return this.executor.transaction(async (tx) => {
      const leaseTx: LeaseTransaction = {
        findByWorkspaceId: async (workspaceId) => {
          // FOR UPDATE serialises the read-then-write flows under READ
          // COMMITTED (same pattern as the agent-host adapter).
          const rows = await tx.query<Record<string, unknown>>(
            "SELECT * FROM controller_leases WHERE workspace_id = $1 FOR UPDATE",
            [workspaceId],
          );
          return rows.length === 0 ? null : rowToLeaseRecord(rows[0]!);
        },
        insert: async (record) => {
          await tx.exec(
            "INSERT INTO controller_leases(workspace_id, controller_id, user_id, expires_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
            [
              record.workspaceId,
              record.controllerId,
              record.userId,
              record.expiresAt.toISOString(),
              record.updatedAt.toISOString(),
            ],
          );
        },
        update: async (record) => {
          await tx.exec(
            "UPDATE controller_leases SET controller_id = $2, user_id = $3, expires_at = $4, updated_at = $5 WHERE workspace_id = $1",
            [
              record.workspaceId,
              record.controllerId,
              record.userId,
              record.expiresAt.toISOString(),
              record.updatedAt.toISOString(),
            ],
          );
        },
        delete: async (workspaceId) => {
          await tx.exec("DELETE FROM controller_leases WHERE workspace_id = $1", [workspaceId]);
        },
      };
      return fn(leaseTx);
    });
  }
}

function rowToLeaseRecord(row: Record<string, unknown>): ControllerLeaseRecord {
  return {
    workspaceId: String(row["workspace_id"]),
    controllerId: String(row["controller_id"]),
    userId: String(row["user_id"]),
    expiresAt: new Date(String(row["expires_at"])),
    updatedAt: new Date(String(row["updated_at"])),
  };
}

// ---------------------------------------------------------------------------
// Owner-based MembershipStore.
//
// The Cloud SQL schema (実装手順書 section 3) has no members table in this
// milestone, so membership is derived from `workspaces.owner_id`: the owner is
// the only member. Adding additional members requires a members table (follow-up).
// ---------------------------------------------------------------------------

export class OwnerMembershipStore implements MembershipStore {
  constructor(private readonly executor: SessionQueryExecutor) {}

  async isMember(workspaceId: string, userId: string): Promise<boolean> {
    const rows = await this.executor.query<Record<string, unknown>>(
      "SELECT owner_id FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    if (rows.length === 0) return false;
    return String(rows[0]!["owner_id"]) === userId;
  }

  async addMember(workspaceId: string, userId: string): Promise<void> {
    // Called by createWorkspace right after the INSERT; the owner is already
    // recorded in the workspaces row, so this is verification-only. A schema
    // without a members table cannot record additional members.
    const rows = await this.executor.query<Record<string, unknown>>(
      "SELECT owner_id FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    if (rows.length === 0) {
      throw new Error(`cannot add member: workspace not found: ${workspaceId}`);
    }
    const ownerId = String(rows[0]!["owner_id"]);
    if (ownerId !== userId) {
      throw new Error(
        `membership store is owner-only in this milestone: cannot add non-owner member ${userId} to workspace ${workspaceId}`,
      );
    }
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    // Only the owner exists; removing the owner is not a supported operation.
    if (await this.isMember(workspaceId, userId)) {
      throw new Error(`cannot remove the workspace owner: ${userId}`);
    }
  }

  async listMembers(workspaceId: string): Promise<string[]> {
    const rows = await this.executor.query<Record<string, unknown>>(
      "SELECT owner_id FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    return rows.length === 0 ? [] : [String(rows[0]!["owner_id"])];
  }
}

// ---------------------------------------------------------------------------
// Placeholder runtime registry (P11a will wire the real composition).
// ---------------------------------------------------------------------------

/**
 * Thrown when a runtime-scoped operation (open/stop/checkpoint/agent input)
 * reaches the not-yet-wired production runtime registry. Extends ApiError so
 * the route error mapper answers a typed 503 (`unavailable`) — never a
 * generic 500 or a silent success.
 */
export class RuntimeNotWiredError extends ApiError {
  readonly name = "RuntimeNotWiredError";
  constructor() {
    super(
      503,
      "unavailable",
      "control-plane production RuntimeRegistry is not wired yet (planned for P11a): " +
        "the T8 WorkspaceRuntime composition is missing its Cloud Run instance client, " +
        "checkpoint storage and GCS collaborators, so workspace runtime operations are unavailable",
    );
  }
}

/** A registry whose factory fail-fasts with `RuntimeNotWiredError`. */
export function createPlaceholderRuntimeRegistry(): RuntimeRegistry {
  return new RuntimeRegistry((_workspace: Workspace) => {
    throw new RuntimeNotWiredError();
  });
}
