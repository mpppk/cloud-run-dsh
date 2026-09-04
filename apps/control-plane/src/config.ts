// Control Plane configuration — parsed from environment at the composition root only.
//
// The control plane is a stateless HTTP service on Cloud Run: it needs the
// Postgres connection string (Cloud SQL in production) and the PORT that
// Cloud Run injects. To manage workspace Instances it additionally needs the
// GCP project/region, the agent-host image + service account, the checkpoint
// bucket, and the agent-host's own required environment (DB URL, GitHub App
// credentials) which it injects into every Instance it creates
// (see runtime-factory.ts and docs/deployment-runbook.md Step 6).

export const DEFAULT_PORT = 8080;

const REQUIRED_ENV_KEYS = [
  "DATABASE_URL",
  "GCP_PROJECT_ID",
  "GCP_REGION",
  "AGENT_HOST_IMAGE",
  "AGENT_HOST_SERVICE_ACCOUNT",
  "CHECKPOINT_BUCKET",
  "AGENT_HOST_DATABASE_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY_PEM",
] as const;

export type RequiredEnvKey = (typeof REQUIRED_ENV_KEYS)[number];

export class MissingRequiredEnvError extends Error {
  readonly name = "MissingRequiredEnvError";
  constructor(public readonly missing: readonly string[]) {
    super(`missing required environment variables: ${missing.join(", ")}`);
  }
}

export interface ControlPlaneConfig {
  /** Cloud Run injects PORT; defaults to 8080 for local container runs. */
  readonly port: number;
  /** Cloud SQL (production) / docker compose Postgres (local) connection string. */
  readonly databaseUrl: string;
  /** GCP project hosting the Cloud Run Instances (basePath `projects/<id>/locations/<region>`). */
  readonly gcpProjectId: string;
  /** GCP region for every Instance the control plane creates. */
  readonly gcpRegion: string;
  /** Agent-host container image for created Instances (v2 `containers[].image`). */
  readonly agentHostImage: string;
  /** Service account the created Instances run as (v2 top-level `serviceAccount`). */
  readonly agentHostServiceAccount: string;
  /** GCS bucket holding workspace checkpoints (also injected into Instances). */
  readonly checkpointBucket: string;
  /**
   * DATABASE_URL injected into created Instances. It MUST use the Cloud SQL
   * socket form (`postgresql://user:pass@/dsh?host=/cloudsql/<conn>`) — the
   * Instance reaches Cloud SQL through its `cloudSqlInstance` volume, never
   * over the control plane's TCP address (see docs/deployment-runbook.md).
   *
   * Mechanism note (issue #42): Bun.SQL rejects Unix-socket DSNs passed as
   * URL strings, so `BunSqlQueryExecutor.connect()` detects the absolute-path
   * `host` (or `socket`) query parameter and connects via the options object
   * `{ path, username, password, database }` instead. TCP URLs pass through
   * unchanged. Characters outside `[A-Za-z0-9-_.~]` in the userinfo
   * (notably in the password) MUST be percent-encoded.
   */
  readonly agentHostDatabaseUrl: string;
  /** GitHub App ID injected into created Instances (host-only, never logged). */
  readonly githubAppId: string;
  /** GitHub App private key PEM injected into created Instances (host-only). */
  readonly githubAppPrivateKeyPem: string;
}

export function readControlPlaneConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ControlPlaneConfig {
  const missing = REQUIRED_ENV_KEYS.filter((key) => {
    const value = env[key];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new MissingRequiredEnvError(missing);
  }

  const portRaw = env["PORT"]?.trim();
  const port = portRaw === undefined || portRaw === "" ? DEFAULT_PORT : Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PORT: ${portRaw}`);
  }

  return {
    port,
    databaseUrl: env["DATABASE_URL"]!.trim(),
    gcpProjectId: env["GCP_PROJECT_ID"]!.trim(),
    gcpRegion: env["GCP_REGION"]!.trim(),
    agentHostImage: env["AGENT_HOST_IMAGE"]!.trim(),
    agentHostServiceAccount: env["AGENT_HOST_SERVICE_ACCOUNT"]!.trim(),
    checkpointBucket: env["CHECKPOINT_BUCKET"]!.trim(),
    agentHostDatabaseUrl: env["AGENT_HOST_DATABASE_URL"]!.trim(),
    githubAppId: env["GITHUB_APP_ID"]!.trim(),
    // The PEM is multi-line — never trim interior content, only the value as
    // a whole is required to be non-blank (checked above). Trailing newlines
    // from Secret Manager mounts are harmless for the broker.
    githubAppPrivateKeyPem: env["GITHUB_APP_PRIVATE_KEY_PEM"]!,
  };
}
