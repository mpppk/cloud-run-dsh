// Production adapters for the control-plane composition root (main.ts).
//
// The SQL adapters mirror `apps/agent-host/src/adapters.ts` (BunSqlQueryExecutor,
// BunSqlLeaseStore) — both apps talk to the same Cloud SQL schema over Bun.SQL.
// Connection-string handling itself is NOT duplicated: both executors resolve
// through the shared `@cloud-run-dsh/session-persistence-postgres` connection
// helper (issue #42), which is the single place that knows the Cloud SQL
// socket form and the password-redaction rules.

import type {
  ControllerLeaseRecord,
  LeaseStore,
  LeaseTransaction,
} from "@cloud-run-dsh/controller-lease";
import type { QueryExecutor as SessionQueryExecutor } from "@cloud-run-dsh/session-persistence-postgres";
import {
  resolveBunSqlTarget,
  toBunSqlConnectionError,
} from "@cloud-run-dsh/session-persistence-postgres";
import type { BunSqlConnectionTarget } from "@cloud-run-dsh/session-persistence-postgres";
import type { MembershipStore } from "./membership.js";
import { IllegalTransitionError } from "@cloud-run-dsh/workspace-runtime";
import type {
  TransactionalStateStore,
  WorkspaceRuntimeState,
  WorkspaceStateTransaction,
} from "@cloud-run-dsh/workspace-runtime";
import type {
  HttpTransport as InstanceHttpTransport,
  HttpRequest as InstanceHttpRequest,
  HttpResponse as InstanceHttpResponse,
} from "@cloud-run-dsh/cloud-run-instance-client";
import type { GcsClient } from "@cloud-run-dsh/workspace-checkpoint";

// ---------------------------------------------------------------------------
// Cloud SQL (Postgres) QueryExecutor via Bun's built-in SQL client
// (mirrors apps/agent-host/src/adapters.ts)
// ---------------------------------------------------------------------------

interface UnsafeSqlClient {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
  begin<T>(fn: (tx: UnsafeSqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void> | undefined;
}

type SqlClientCtor = new (target: BunSqlConnectionTarget) => UnsafeSqlClient;

export class BunSqlQueryExecutor implements SessionQueryExecutor {
  private constructor(private readonly client: UnsafeSqlClient) {}

  /**
   * Connects to TCP (local / docker compose) or Cloud SQL Unix sockets.
   *
   * The configured string is resolved through the shared
   * `resolveBunSqlTarget()` first: socket-form values
   * (`?host=/cloudsql/<conn>`) become the `{ path, username, password,
   * database }` options object Bun.SQL requires, while TCP URLs pass
   * through unchanged. `new SQL()` throws are re-wrapped so the password
   * never reaches the exception (issue #42).
   *
   * The optional `sqlCtor` is a test seam for asserting the resolved target
   * without opening a real connection.
   */
  static async connect(
    databaseUrl: string,
    sqlCtor?: SqlClientCtor,
  ): Promise<BunSqlQueryExecutor> {
    const target = resolveBunSqlTarget(databaseUrl);
    const Ctor =
      sqlCtor ??
      (await import("bun") as unknown as { SQL: SqlClientCtor }).SQL;
    try {
      return new BunSqlQueryExecutor(new Ctor(target));
    } catch (e) {
      throw toBunSqlConnectionError(e, target);
    }
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
// Cloud SQL (Postgres) TransactionalStateStore — workspace state machine
// persistence (T8 seam; 実装手順書 section 4: state transition in a DB
// transaction). Mirrors apps/agent-host/src/adapters.ts
// SqlTransactionalStateStore: the workspace's runtime_state lives in the
// workspaces table; apply() performs a compare-and-set UPDATE inside a
// SELECT ... FOR UPDATE transaction so concurrent transitions cannot
// overwrite each other.
// ---------------------------------------------------------------------------

const WORKSPACE_RUNTIME_STATES: readonly WorkspaceRuntimeState[] = [
  "STOPPED",
  "STARTING",
  "RESTORING",
  "READY",
  "BUSY",
  "CHECKPOINTING",
  "STOPPING",
  "ERROR",
  "RESTORE_FAILED",
  "CHECKPOINT_FAILED",
];

export class SqlTransactionalStateStore implements TransactionalStateStore {
  constructor(private readonly executor: SessionQueryExecutor) {}

  async load(workspaceId: string): Promise<WorkspaceRuntimeState | null> {
    const rows = await this.executor.query<Record<string, unknown>>(
      "SELECT runtime_state FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    if (rows.length === 0) return null;
    const value = rows[0]!["runtime_state"];
    if (typeof value !== "string") return null;
    return (WORKSPACE_RUNTIME_STATES as readonly string[]).includes(value)
      ? (value as WorkspaceRuntimeState)
      : null;
  }

  async apply(
    workspaceId: string,
    from: WorkspaceRuntimeState,
    to: WorkspaceRuntimeState,
    reason: string | undefined,
    persist?: (tx: WorkspaceStateTransaction) => Promise<void>,
  ): Promise<void> {
    await this.executor.transaction(async (tx) => {
      const rows = await tx.query<Record<string, unknown>>(
        "SELECT runtime_state FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId],
      );
      const current = rows.length === 0 ? null : rows[0]!["runtime_state"];
      if (current !== from) {
        throw new IllegalTransitionError(
          from,
          current === null ? "STOPPED" : (String(current) as WorkspaceRuntimeState),
        );
      }
      await tx.exec(
        "UPDATE workspaces SET runtime_state = $2, updated_at = now() WHERE id = $1",
        [workspaceId, to],
      );
      if (persist) {
        await persist({
          record: { workspaceId, from, to, at: new Date(), reason },
          persist: async (data) => {
            // workspace_checkpoints schema (infra/migrations/0001_init.sql):
            // id UUID PK, workspace_id, base_commit_sha NOT NULL, gcs_object
            // NOT NULL — there is no `data` column. The persist payload must
            // carry the T5 bundle reference (base commit + GCS object key).
            const bundle = data as { baseCommitSha?: unknown; gcsObject?: unknown };
            if (
              typeof bundle?.baseCommitSha !== "string" ||
              typeof bundle?.gcsObject !== "string"
            ) {
              throw new Error(
                "persist payload must be { baseCommitSha: string; gcsObject: string } (workspace_checkpoints schema)",
              );
            }
            await tx.exec(
              "INSERT INTO workspace_checkpoints(id, workspace_id, base_commit_sha, gcs_object) VALUES (gen_random_uuid(), $1, $2, $3)",
              [workspaceId, bundle.baseCommitSha, bundle.gcsObject],
            );
          },
        });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// GCP access token — Instances API + GCS authentication.
// ---------------------------------------------------------------------------

/** Provides a GCP OAuth2 access token for REST calls (Instances API, GCS JSON API). */
export type GcpTokenProvider = () => Promise<string>;

export type FetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Resolves the token from `GCP_ACCESS_TOKEN` when set (local runs, short-lived
 * operator tokens), otherwise from the GCP metadata server (Cloud Run / GCE —
 * the production path; no secret to rotate). The metadata lookup has a short
 * timeout so a non-GCP environment fails fast with a clear error instead of
 * hanging the first Instance operation.
 *
 * NOTE (#27): a production-grade metadata-server implementation (caching,
 * refresh, ADC fallback) is #27's scope. This is the minimal stopgap that
 * keeps the control plane shippable until then — same shape as the
 * agent-host's envGcsTokenProvider precedent.
 */
export function createGcpAccessTokenProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): GcpTokenProvider {
  return async () => {
    const fromEnv = env["GCP_ACCESS_TOKEN"]?.trim();
    if (fromEnv) return fromEnv;
    let res: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      res = await fetchFn(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        {
          headers: { "Metadata-Flavor": "Google" },
          signal: AbortSignal.timeout(2000),
        },
      );
    } catch (e) {
      throw new Error(
        "no GCP credentials: GCP_ACCESS_TOKEN is not set and the metadata server is unreachable " +
          `(are you running outside GCP without a token? ${e instanceof Error ? e.message : String(e)})`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `no GCP credentials: GCP_ACCESS_TOKEN is not set and the metadata server answered ${res.status}`,
      );
    }
    const body = (await res.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new Error("no GCP credentials: metadata server returned no access_token");
    }
    return body.access_token;
  };
}

// ---------------------------------------------------------------------------
// Authenticated Instances API transport (fetch-based, JSON bodies).
// Mirrors apps/agent-host/src/adapters.ts instanceHttpTransport plus the
// Authorization header (the agent-host transport sends none — the control
// plane must authenticate as its run.admin service account).
// ---------------------------------------------------------------------------

export function createAuthenticatedInstanceTransport(
  tokenProvider: GcpTokenProvider,
  fetchFn: typeof fetch = fetch,
): InstanceHttpTransport {
  return {
    request: async (req: InstanceHttpRequest): Promise<InstanceHttpResponse> => {
      const token = await tokenProvider();
      const res = await fetchFn(req.url, {
        method: req.method,
        headers: { ...(req.headers ?? {}), Authorization: `Bearer ${token}` },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // non-JSON body — keep raw text
      }
      return { status: res.status, headers, body };
    },
  };
}

// ---------------------------------------------------------------------------
// GCS checkpoint storage (JSON API via fetch; token provider injected).
// Mirrors apps/agent-host/src/adapters.ts FetchGcsClient.
// ---------------------------------------------------------------------------

export class FetchGcsClient implements GcsClient {
  constructor(
    private readonly options: {
      readonly apiBaseUrl?: string;
      readonly tokenProvider: GcpTokenProvider;
      readonly fetchFn?: typeof fetch;
    },
  ) {}

  private fetchFn(): typeof fetch {
    return this.options.fetchFn ?? fetch;
  }

  private baseUrl(): string {
    return this.options.apiBaseUrl ?? "https://storage.googleapis.com/storage/v1";
  }

  private uploadUrl(bucket: string, key: string): string {
    return `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
  }

  private async authorized(init: RequestInit): Promise<RequestInit> {
    const token = await this.options.tokenProvider();
    return {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      },
    };
  }

  async getObject(bucket: string, key: string): Promise<Uint8Array | null> {
    const url = `${this.baseUrl()}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media`;
    const res = await this.fetchFn()(url, await this.authorized({ method: "GET" }));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gcs get failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async uploadObject(bucket: string, key: string, data: Uint8Array): Promise<void> {
    const res = await this.fetchFn()(
      this.uploadUrl(bucket, key),
      await this.authorized({
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([new Uint8Array(data)]),
      }),
    );
    if (!res.ok) throw new Error(`gcs upload failed: ${res.status}`);
  }

  async objectExists(bucket: string, key: string): Promise<boolean> {
    const url = `${this.baseUrl()}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;
    const res = await this.fetchFn()(url, await this.authorized({ method: "GET" }));
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`gcs head failed: ${res.status}`);
    return true;
  }
}
