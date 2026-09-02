// Production adapters for the composition root. Each adapter is a thin
// implementation of a package seam; tests inject fakes instead.

import { promises as nodeFs } from "node:fs";
import type {
  CheckpointStorage,
  FileSystem,
  GitResult,
  GitRunner,
} from "@cloud-run-dsh/workspace-checkpoint";
import { GcsCheckpointStorage } from "@cloud-run-dsh/workspace-checkpoint";
import type {
  SandboxCliResult,
  SandboxCliRunner,
} from "@cloud-run-dsh/cloud-run-sandbox";
import type {
  HttpTransport,
  HttpRequest,
  HttpResponse,
  SecretProvider,
} from "@cloud-run-dsh/github-credential-broker";
import type {
  HttpTransport as InstanceHttpTransport,
  HttpRequest as InstanceHttpRequest,
} from "@cloud-run-dsh/cloud-run-instance-client";
import type {
  LeaseStore,
  ControllerLeaseRecord,
  LeaseTransaction,
} from "@cloud-run-dsh/controller-lease";
import type { QueryExecutor as SessionQueryExecutor } from "@cloud-run-dsh/session-persistence-postgres";
import { PostgresSessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";

// ---------------------------------------------------------------------------
// Host process environment — explicit allowlist, never wholesale inheritance
// (仕様書 section 17: secrets must not leak into child processes).
// ---------------------------------------------------------------------------

const HOST_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "CI", "NODE_ENV"] as const;

export function buildHostProcessEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined && value !== "") {
      env[key] = value;
    }
  }
  return env;
}

function spawnAndCollect(
  cmd: readonly string[],
  opts: { cwd?: string; stdin?: string | Uint8Array },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdin =
    opts.stdin === undefined
      ? "ignore"
      : typeof opts.stdin === "string"
        ? new TextEncoder().encode(opts.stdin)
        : opts.stdin;
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: opts.cwd,
    env: buildHostProcessEnv(process.env),
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
}

// ---------------------------------------------------------------------------
// node:fs-backed FileSystem (workspace-checkpoint seam)
// ---------------------------------------------------------------------------

export class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await nodeFs.readFile(path));
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await nodeFs.writeFile(path, data);
  }
  async exists(path: string): Promise<boolean> {
    try {
      await nodeFs.stat(path);
      return true;
    } catch {
      return false;
    }
  }
  async unlink(path: string): Promise<void> {
    await nodeFs.unlink(path);
  }
  /** mkdir -p (workspace-checkpoint FileSystem contract). */
  async mkdir(path: string): Promise<void> {
    await nodeFs.mkdir(path, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Bun.spawn-backed runners
// ---------------------------------------------------------------------------

export class ExecGitRunner implements GitRunner {
  async run(
    args: readonly string[],
    opts?: { cwd?: string },
  ): Promise<GitResult> {
    const { exitCode, stdout, stderr } = await spawnAndCollect(["git", ...args], {
      cwd: opts?.cwd,
    });
    return { exitCode, stdout, stderr };
  }
}

/** Runs the sandbox CLI provided by Cloud Run — never vendored into the image. */
export class ExecSandboxCliRunner implements SandboxCliRunner {
  constructor(private readonly cliPath: string) {}

  async run(
    argv: readonly string[],
    opts?: { stdin?: string | Uint8Array },
  ): Promise<SandboxCliResult> {
    const { exitCode, stdout, stderr } = await spawnAndCollect([this.cliPath, ...argv], {
      stdin: opts?.stdin,
    });
    return { exitCode, stdout, stderr };
  }
}

// ---------------------------------------------------------------------------
// HTTP transports (fetch-based)
// ---------------------------------------------------------------------------

export const fetchHttpTransport: HttpTransport = async (
  req: HttpRequest,
): Promise<HttpResponse> => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: res.status, headers, body: await res.text() };
};

export const instanceHttpTransport: InstanceHttpTransport = {
  request: async (req: InstanceHttpRequest) => {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
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

// ---------------------------------------------------------------------------
// GCS checkpoint storage (JSON API via fetch; token provider injected)
// ---------------------------------------------------------------------------

export type GcsTokenProvider = () => Promise<string>;

export class FetchGcsClient {
  constructor(
    private readonly options: {
      readonly apiBaseUrl?: string;
      readonly tokenProvider: GcsTokenProvider;
    },
  ) {}

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
    const res = await fetch(url, await this.authorized({ method: "GET" }));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gcs get failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async uploadObject(bucket: string, key: string, data: Uint8Array): Promise<void> {
    const res = await fetch(
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
    const res = await fetch(url, await this.authorized({ method: "GET" }));
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`gcs head failed: ${res.status}`);
    return true;
  }
}

export function createCheckpointStorage(
  client: FetchGcsClient,
  bucket: string,
): CheckpointStorage {
  return new GcsCheckpointStorage(client, bucket);
}

/** TODO(secrets): read the access token from the GCP metadata server / ADC in production. */
export function envGcsTokenProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GcsTokenProvider {
  return async () => {
    const token = env["GCP_ACCESS_TOKEN"];
    if (!token) throw new Error("GCP_ACCESS_TOKEN is not set — cannot access GCS");
    return token;
  };
}

// ---------------------------------------------------------------------------
// GitHub App secret provider — host-only, memory-only
// ---------------------------------------------------------------------------

export function createEnvSecretProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretProvider {
  return async () => ({
    appId: env["GITHUB_APP_ID"] ?? "",
    privateKeyPem: env["GITHUB_APP_PRIVATE_KEY_PEM"] ?? "",
  });
}

// ---------------------------------------------------------------------------
// Cloud SQL (Postgres) QueryExecutor via Bun's built-in SQL client
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

export async function createSessionRepository(
  databaseUrl: string,
): Promise<PostgresSessionPersistenceRepository> {
  return new PostgresSessionPersistenceRepository(
    await BunSqlQueryExecutor.connect(databaseUrl),
  );
}

// ---------------------------------------------------------------------------
// Cloud SQL (Postgres) TransactionalStateStore — workspace state machine
// persistence (T8 seam; 実装手順書 section 4: state transition in a DB
// transaction). The workspace's runtime_state lives in the workspaces table;
// apply() performs a compare-and-set UPDATE so concurrent transitions cannot
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

// `IllegalTransitionError` is the T8 typed error so callers can catch it.
import {
  IllegalTransitionError,
  type TransactionalStateStore,
  type WorkspaceRuntimeState,
  type WorkspaceStateTransaction,
} from "@cloud-run-dsh/workspace-runtime";

// ---------------------------------------------------------------------------
// Cloud SQL (Postgres) LeaseStore for the controller lease (T6 seam)
// 実装手順書 section 26: INSERT ... ON CONFLICT ... WHERE expires_at <= now
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
          // FOR UPDATE satisfies the LeaseStore.transaction isolation
          // contract under READ COMMITTED (bun sql.begin default): the
          // read-then-write flows (takeover, release) serialise on the row
          // lock, so a release whose owner check saw a stale snapshot can
          // never DELETE a lease a concurrent takeover just committed —
          // same pattern as SqlTransactionalStateStore.apply.
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
