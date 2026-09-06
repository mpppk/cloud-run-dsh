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
import type { Logger } from "@cloud-run-dsh/observability";
import type { ControlPlaneReadiness } from "./deps.js";
import {
  createBunSqlClient,
  resolveBunSqlTarget,
  toBunSqlConnectionError,
} from "@cloud-run-dsh/session-persistence-postgres";
import type {
  BunSqlConnectionTarget,
  BunSqlPoolOptions,
} from "@cloud-run-dsh/session-persistence-postgres";
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
import {
  RefreshingGcsTokenProvider,
  type ChainedGcsTokenProviderDeps,
} from "@cloud-run-dsh/gcp-token-provider";

// ---------------------------------------------------------------------------
// Cloud SQL (Postgres) QueryExecutor via Bun's built-in SQL client
// (mirrors apps/agent-host/src/adapters.ts)
// ---------------------------------------------------------------------------

interface UnsafeSqlClient {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
  begin<T>(fn: (tx: UnsafeSqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void> | undefined;
}

type SqlClientCtor = new (
  target: BunSqlConnectionTarget,
  options?: BunSqlPoolOptions,
) => UnsafeSqlClient;

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
   * Construction goes through the shared `createBunSqlClient()` so Bun.SQL
   * cannot read ambient `*_URL` variables (notably production's
   * `DATABASE_URL`, which holds the socket DSN itself and otherwise makes
   * even a correct options object throw `ERR_INVALID_URL` — issue #45).
   *
   * `poolOptions` (issue #109) caps the pool — pass the config's
   * `dbPoolMax`/`dbPoolIdleTimeout`. Without it Bun runs uncapped
   * (`max: 10` eager + `idleTimeout: 0` = never reap), which exhausted
   * db-f1-micro's 25 slots from a single container.
   *
   * The optional `sqlCtor` is a test seam for asserting the resolved target
   * without opening a real connection.
   */
  static async connect(
    databaseUrl: string,
    sqlCtor?: SqlClientCtor,
    poolOptions?: BunSqlPoolOptions,
  ): Promise<BunSqlQueryExecutor> {
    const target = resolveBunSqlTarget(databaseUrl);
    const Ctor =
      sqlCtor ??
      (await import("bun") as unknown as { SQL: SqlClientCtor }).SQL;
    try {
      return new BunSqlQueryExecutor(createBunSqlClient(target, Ctor, poolOptions));
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

  /**
   * Workspaces visible to `userId` (issue #137 案A): the owner is the only
   * member, so this is ONE filtered query — never a full-table fetch into
   * application memory (db-f1-micro connection pressure, issue #109).
   */
  async listWorkspaceIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.executor.query<Record<string, unknown>>(
      "SELECT id FROM workspaces WHERE owner_id = $1 ORDER BY created_at ASC",
      [userId],
    );
    return rows.map((row) => String(row["id"]));
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
        // Issue #63: report (actual current, intended target) — the same
        // shape as InMemoryTransactionalStore — so the message names the
        // real row state instead of fabricating a "from -> current" edge
        // violation that sends the next investigation at the transition
        // table. `to` is the transition that was attempted; `from` was only
        // this writer's stale expectation.
        throw new IllegalTransitionError(
          current === null ? "STOPPED" : (String(current) as WorkspaceRuntimeState),
          to,
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
// Database readiness probe for GET /readyz (issue #97).
//
// Measured on GCP 2026-09-05: /readyz answered 200 {"status":"ready"} while
// the database was unreachable, and the first real query then failed after
// 30s. Readiness that never touches the database sends the first page of
// triage in the wrong direction, so production probes it for real — but:
// - the probe is a single `SELECT 1`, never a full connection cycle;
// - it races a short timeout (default 2s): a hung database must not hang
//   the endpoint (the incident's 30s connection timeout is the shape being
//   avoided — a hanging /readyz is worse than a 503);
// - results are cached for a short TTL (default 10s) so steady-state health
//   checks cost ~zero queries while a recovered database is noticed promptly.
//
// No startup grace period is special-cased: a process whose database is not
// yet reachable is genuinely not ready to serve, and Cloud Run withholds
// traffic until this endpoint says otherwise. Liveness (/livez) stays
// independent so a slow database can never look like a dead process.
//
// The 503 body reason is a FIXED string. /readyz is served before auth, so
// no error text (not even hostnames) is echoed to the prober; details go
// to the structured log only.
// ---------------------------------------------------------------------------

export interface DbReadinessProbeOptions {
  /** Probe timeout in ms (default 2000). A probe slower than this is not_ready. */
  readonly timeoutMs?: number;
  /** How long a probe result is reused in ms (default 10000). */
  readonly cacheTtlMs?: number;
  /** Clock seam for tests (default Date.now). */
  readonly nowMs?: () => number;
  /** Structured logger for probe-failure details (never client-visible). */
  readonly logger?: Logger;
}

/** Fixed /readyz reason — pre-auth endpoint, so no error text is echoed. */
export const DB_READINESS_NOT_READY_REASON =
  "database unreachable: readiness probe (SELECT 1) failed or timed out";

export function createDbReadinessProbe(
  executor: Pick<SessionQueryExecutor, "query">,
  opts: DbReadinessProbeOptions = {},
): () => Promise<ControlPlaneReadiness> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const cacheTtlMs = opts.cacheTtlMs ?? 10_000;
  const nowMs = opts.nowMs ?? Date.now;
  let cached: { report: ControlPlaneReadiness; probedAtMs: number } | null = null;

  return async (): Promise<ControlPlaneReadiness> => {
    const now = nowMs();
    if (cached && now - cached.probedAtMs < cacheTtlMs) {
      return cached.report;
    }
    const report = await runDbProbe(executor, timeoutMs, opts.logger);
    cached = { report, probedAtMs: nowMs() };
    return report;
  };
}

async function runDbProbe(
  executor: Pick<SessionQueryExecutor, "query">,
  timeoutMs: number,
  logger: Logger | undefined,
): Promise<ControlPlaneReadiness> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      executor.query("SELECT 1", []),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("readiness probe timed out")), timeoutMs);
      }),
    ]);
    return { ready: true };
  } catch (e) {
    logger?.error("readyz.db_probe_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { ready: false, reason: DB_READINESS_NOT_READY_REASON };
  } finally {
    if (timer !== null) clearTimeout(timer);
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
 * Resolves the token through the shared `@cloud-run-dsh/gcp-token-provider`
 * chain (issue #76): metadata server → ADC → `GCP_ACCESS_TOKEN`, cached
 * until 60s before expiry with one shared in-flight refresh.
 *
 * Why caching: the metadata server reports ~1799s lifetimes on real GCP, so
 * minting a fresh token per Instances API / GCS call is pure waste.
 * Why ADC fallback: local runs have no metadata server — after
 * `gcloud auth application-default login` the chain works off-GCP exactly
 * like the agent-host's (same class, same order).
 *
 * Only the source name is ever logged (info); the token itself never is —
 * see the shared package. Error messages likewise carry reason codes, never
 * token material.
 */
export function createGcpAccessTokenProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchFn: FetchFn = fetch,
  deps: Pick<
    ChainedGcsTokenProviderDeps,
    "logger" | "clock" | "readFile" | "metadataTimeoutMs" | "adcCredentialsPath"
  > = {},
): GcpTokenProvider {
  const provider = new RefreshingGcsTokenProvider(env, {
    clock: deps.clock,
    logger: deps.logger,
    fetchImpl: fetchFn,
    readFile: deps.readFile,
    adcCredentialsPath: deps.adcCredentialsPath,
    metadataTimeoutMs: deps.metadataTimeoutMs ?? 2000,
  });
  return () => provider.getToken();
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
