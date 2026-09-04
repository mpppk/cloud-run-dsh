// Production adapters for the composition root. Each adapter is a thin
// implementation of a package seam; tests inject fakes instead.

import { promises as nodeFs } from "node:fs";
import { createSign } from "node:crypto";
import type {
  CheckpointStorage,
  Clock,
  FileSystem,
  GitResult,
  GitRunner,
} from "@cloud-run-dsh/workspace-checkpoint";
import { SystemClock } from "@cloud-run-dsh/workspace-checkpoint";
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
import type { Logger } from "@cloud-run-dsh/observability";
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

// ---------------------------------------------------------------------------
// GCS access tokens (issue #27).
//
// Fallback order (explicit — local dev and CI must keep working):
//   1. metadata-server — Cloud Run / GCE / GKE metadata server, using the
//      attached service account. Production path; no secret is configured.
//   2. adc — Application Default Credentials from GOOGLE_APPLICATION_CREDENTIALS
//      or the gcloud well-known file, refreshed/minted over HTTPS. Local-dev
//      path after `gcloud auth application-default login`.
//   3. env — GCP_ACCESS_TOKEN (unknown expiry). Escape hatch for CI / local
//      scripts; preserved from the original implementation.
//
// Every successful acquisition logs WHICH source was used (never the token).
// Acquired tokens are cached until 60s before expiry and concurrent callers
// share a single in-flight refresh so expiry stampedes hit the source once.
// ---------------------------------------------------------------------------

/** Metadata server endpoint for the attached service account's token. */
export const GCS_METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** Refresh this far before expiry so clock skew / slow fetches never serve a dead token. */
export const GCS_TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Assumed lifetime when a source omits expires_in. */
export const GCS_TOKEN_DEFAULT_EXPIRES_IN_S = 3600;

/**
 * Synthetic lifetime for env-var tokens, whose real expiry is unknown.
 * Re-reading every few minutes lets rotations propagate.
 */
export const GCS_ENV_TOKEN_LIFETIME_S = 300;

/** OAuth scope requested when minting tokens from ADC service-account keys. */
export const GCS_ADC_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const GCS_ADC_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GCS_ADC_WELL_KNOWN_SUFFIX = ".config/gcloud/application_default_credentials.json";

export type GcsAuthSource =
  | "metadata-server"
  | "adc-authorized-user"
  | "adc-service-account"
  | "env";

export interface ChainedGcsTokenProviderDeps {
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly readFile?: (path: string) => Promise<string>;
  /** Override the metadata URL (tests). */
  readonly metadataUrl?: string;
  /** Override the ADC credential file path (tests). */
  readonly adcCredentialsPath?: string;
  /** Abort a hanging metadata fetch so off-GCP hosts fall back fast. */
  readonly metadataTimeoutMs?: number;
}

interface SourcedToken {
  readonly token: string;
  /** Lifetime in seconds from acquisition. */
  readonly expiresInS: number;
  readonly source: GcsAuthSource;
}

/** Short machine-readable reason codes only — never response bodies or tokens. */
class GcsSourceError extends Error {
  override readonly name = "GcsSourceError";
  constructor(
    readonly source: string,
    readonly code: string,
  ) {
    super(`${source}: ${code}`);
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseTokenResponse(body: unknown, source: string): { token: string; expiresInS: number } {
  if (typeof body !== "object" || body === null) {
    throw new GcsSourceError(source, "bad-response");
  }
  const record = body as Record<string, unknown>;
  const token = record["access_token"];
  if (typeof token !== "string" || token === "") {
    throw new GcsSourceError(source, "bad-response");
  }
  const rawExpiresIn = record["expires_in"];
  const expiresInS =
    typeof rawExpiresIn === "number" && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
      ? Math.floor(rawExpiresIn)
      : GCS_TOKEN_DEFAULT_EXPIRES_IN_S;
  return { token, expiresInS };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export class RefreshingGcsTokenProvider {
  private readonly clock: Clock;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly metadataUrl: string;
  private readonly metadataTimeoutMs: number;
  private cached: { token: string; expiresAtMs: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    deps: ChainedGcsTokenProviderDeps = {},
  ) {
    this.clock = deps.clock ?? new SystemClock();
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.readFile = deps.readFile ?? ((path) => nodeFs.readFile(path, "utf8"));
    this.metadataUrl = deps.metadataUrl ?? GCS_METADATA_TOKEN_URL;
    this.metadataTimeoutMs = deps.metadataTimeoutMs ?? 3000;
  }

  /** GcsTokenProvider: cached while valid, otherwise refreshed through the chain. */
  async getToken(): Promise<string> {
    const hit = this.cached;
    if (hit && this.clock.nowMs() < hit.expiresAtMs - GCS_TOKEN_REFRESH_MARGIN_MS) {
      return hit.token;
    }
    // Expiry stampede guard: concurrent callers share one refresh.
    if (this.inflight) return this.inflight;
    const pending = this.refresh().then((sourced) => {
      this.cached = {
        token: sourced.token,
        expiresAtMs: this.clock.nowMs() + sourced.expiresInS * 1000,
      };
      return sourced.token;
    });
    this.inflight = pending;
    try {
      return await pending;
    } finally {
      this.inflight = null;
    }
  }

  private async refresh(): Promise<SourcedToken> {
    const attempts: string[] = [];

    try {
      const sourced = await this.fetchFromMetadataServer();
      this.logSource(sourced);
      return sourced;
    } catch (err) {
      const code = err instanceof GcsSourceError ? err.code : "unreachable";
      attempts.push(`metadata-server:${code}`);
      this.logger?.info("gcs.auth.source_skipped", { source: "metadata-server", reason: code });
    }

    try {
      const sourced = await this.fetchFromAdc();
      if (sourced) {
        this.logSource(sourced);
        return sourced;
      }
      attempts.push("adc:unavailable");
    } catch (err) {
      const code = err instanceof GcsSourceError ? err.code : "unreachable";
      attempts.push(`adc:${code}`);
      this.logger?.info("gcs.auth.source_skipped", { source: "adc", reason: code });
    }

    const envToken = this.env["GCP_ACCESS_TOKEN"]?.trim();
    if (envToken) {
      const sourced: SourcedToken = {
        token: envToken,
        expiresInS: GCS_ENV_TOKEN_LIFETIME_S,
        source: "env",
      };
      this.logSource(sourced);
      return sourced;
    }
    attempts.push("env:missing");

    this.logger?.error("gcs.auth.no_credential_source", { attempts: attempts.join(",") });
    throw new Error(
      `no GCS credential source available (${attempts.join(", ")}). ` +
        `On Cloud Run the metadata server must be reachable; locally run ` +
        `'gcloud auth application-default login' or set GCP_ACCESS_TOKEN.`,
    );
  }

  /** Records which source minted the token — the token itself is never logged. */
  private logSource(sourced: SourcedToken): void {
    this.logger?.info("gcs.auth.token_source", {
      source: sourced.source,
      expires_in_s: sourced.expiresInS,
    });
  }

  private async fetchFromMetadataServer(): Promise<SourcedToken> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.metadataTimeoutMs);
    try {
      const res = await this.fetchImpl(this.metadataUrl, {
        method: "GET",
        headers: { "Metadata-Flavor": "Google" },
        signal: controller.signal,
      });
      if (!res.ok) throw new GcsSourceError("metadata-server", `http-${res.status}`);
      const parsed = parseTokenResponse(await res.json(), "metadata-server");
      return { ...parsed, source: "metadata-server" };
    } catch (err) {
      if (err instanceof GcsSourceError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new GcsSourceError("metadata-server", "timeout");
      }
      throw new GcsSourceError("metadata-server", "unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * ADC fallback (no new dependencies — plain fetch + node:crypto):
   * authorized_user entries are refreshed via the OAuth token endpoint;
   * service_account keys mint a self-signed JWT first.
   * Returns null when no ADC file is present (normal off-GCP state).
   */
  private async fetchFromAdc(): Promise<SourcedToken | null> {
    const explicit = this.env["GOOGLE_APPLICATION_CREDENTIALS"]?.trim();
    const home = this.env["HOME"]?.trim() || this.env["USERPROFILE"]?.trim();
    const path = explicit || (home ? `${home}/${GCS_ADC_WELL_KNOWN_SUFFIX}` : null);
    if (!path) return null;
    let raw: string;
    try {
      raw = await this.readFile(path);
    } catch {
      return null;
    }
    let doc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      doc = parsed as Record<string, unknown>;
    } catch {
      throw new GcsSourceError("adc", "bad-file");
    }
    if (doc["type"] === "authorized_user") {
      const clientId = doc["client_id"];
      const clientSecret = doc["client_secret"];
      const refreshToken = doc["refresh_token"];
      if (!nonEmpty(clientId) || !nonEmpty(clientSecret) || !nonEmpty(refreshToken)) {
        throw new GcsSourceError("adc", "bad-file");
      }
      return this.refreshAuthorizedUser(clientId, clientSecret, refreshToken);
    }
    if (doc["type"] === "service_account") {
      const clientEmail = doc["client_email"];
      const privateKey = doc["private_key"];
      if (!nonEmpty(clientEmail) || !nonEmpty(privateKey)) {
        throw new GcsSourceError("adc", "bad-file");
      }
      return this.mintServiceAccountToken(clientEmail, privateKey);
    }
    throw new GcsSourceError("adc", "unsupported-type");
  }

  private async refreshAuthorizedUser(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<SourcedToken> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString();
    let res: Response;
    try {
      res = await this.fetchImpl(GCS_ADC_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new GcsSourceError("adc", "unreachable");
    }
    if (!res.ok) throw new GcsSourceError("adc", `http-${res.status}`);
    const parsed = parseTokenResponse(await res.json(), "adc");
    return { ...parsed, source: "adc-authorized-user" };
  }

  private async mintServiceAccountToken(
    clientEmail: string,
    privateKey: string,
  ): Promise<SourcedToken> {
    const nowSec = Math.floor(this.clock.nowMs() / 1000);
    const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const claims = base64UrlEncode(
      new TextEncoder().encode(
        JSON.stringify({
          iss: clientEmail,
          scope: GCS_ADC_OAUTH_SCOPE,
          aud: GCS_ADC_TOKEN_URL,
          iat: nowSec,
          exp: nowSec + 3600,
        }),
      ),
    );
    const signingInput = `${header}.${claims}`;
    let assertion: string;
    try {
      const signer = createSign("RSA-SHA256");
      signer.update(signingInput);
      signer.end();
      assertion = `${signingInput}.${base64UrlEncode(new Uint8Array(signer.sign(privateKey)))}`;
    } catch {
      throw new GcsSourceError("adc", "bad-key");
    }
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString();
    let res: Response;
    try {
      res = await this.fetchImpl(GCS_ADC_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new GcsSourceError("adc", "unreachable");
    }
    if (!res.ok) throw new GcsSourceError("adc", `http-${res.status}`);
    const parsed = parseTokenResponse(await res.json(), "adc");
    return { ...parsed, source: "adc-service-account" };
  }
}

/**
 * Production token provider: metadata server → ADC → GCP_ACCESS_TOKEN.
 * Which source was used is logged (info); the token itself never is.
 */
export function createGcsTokenProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: ChainedGcsTokenProviderDeps = {},
): GcsTokenProvider {
  const provider = new RefreshingGcsTokenProvider(env, deps);
  return () => provider.getToken();
}

/** Last-resort env-only provider (kept for scripts/tests; prefer createGcsTokenProvider). */
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
