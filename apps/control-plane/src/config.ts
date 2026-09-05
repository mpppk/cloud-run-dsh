// Control Plane configuration — parsed from environment at the composition root only.
//
// The control plane is a stateless HTTP service on Cloud Run: it needs the
// Postgres connection string (Cloud SQL in production) and the PORT that
// Cloud Run injects. To manage workspace Instances it additionally needs the
// GCP project/region, the agent-host image + service account, the checkpoint
// bucket, and the agent-host's own required environment (DB URL, GitHub App
// credentials, LLM API key) which it injects into every Instance it creates
// (see runtime-factory.ts and docs/deployment-runbook.md Step 6).
//
// Secret posture mirrors GITHUB_APP_PRIVATE_KEY_PEM throughout: OPENROUTER_API_KEY
// travels as a plain env value into created Instances (Instances API
// `valueSource` secret references are follow-up work — the typed client only
// sends plain `value` pairs today). The key value is NEVER logged and NEVER
// interpolated into an error message — MissingRequiredEnvError carries key
// NAMES only.

export const DEFAULT_PORT = 8080;

/**
 * Stopped-Instance GC defaults (issue #85 案A). The sweeper deletes the
 * Cloud Run Instance objects of STOPPED workspaces untouched for
 * `staleAfterMs`, every `intervalMs`. An interval of 0 disables the sweeper
 * (explicit deletes via DELETE /v1/workspaces/:id still work).
 */
export const DEFAULT_INSTANCE_GC_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_INSTANCE_GC_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Smallest accepted staleness: 1 hour (a 1ms threshold would GC everything). */
export const MIN_INSTANCE_GC_STALE_AFTER_MS = 60 * 60 * 1000;
export const DEFAULT_INSTANCE_GC_MAX_DELETES_PER_SWEEP = 10;

/**
 * Default Cloud Run Instances API origin + version (issue #47). Overridable
 * via `INSTANCES_API_BASE_URL` for tests and emulators. Kept in sync with
 * `DEFAULT_INSTANCES_API_BASE_URL` in
 * `@cloud-run-dsh/cloud-run-instance-client` (same literal; config.ts stays
 * dependency-free).
 */
export const DEFAULT_INSTANCES_API_BASE_URL = "https://run.googleapis.com/v2";

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
  // Issue #41: without this the control plane builds Instances whose first
  // turn dies with MISSING_CREDENTIAL. Required (not optional-with-default)
  // so a missing key fails control-plane boot — long before any Instance is
  // created — instead of failing the first turn inside the Instance.
  "OPENROUTER_API_KEY",
  // Issue #56: the Cloud SQL connection name (<project>:<region>:<instance>,
  // the `sql_connection_name` Terraform output) for the `cloudSqlInstance`
  // volume the control plane attaches to every Instance it creates. Required
  // so a missing name fails control-plane boot — long before any Instance is
  // created — instead of billing a crash loop of Instances with no /cloudsql
  // socket (ERR_POSTGRES_CONNECTION_REFUSED, restartPolicy ON_FAILURE).
  "CLOUD_SQL_CONNECTION_NAME",
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
  /** GCP project hosting the Cloud Run Instances (absolute basePath `https://run.googleapis.com/v2/projects/<id>/locations/<region>` — issue #47). */
  readonly gcpProjectId: string;
  /** GCP region for every Instance the control plane creates. */
  readonly gcpRegion: string;
  /**
   * Cloud Run Instances API origin + version (issue #47). Defaults to
   * `https://run.googleapis.com/v2`; set `INSTANCES_API_BASE_URL` to point at
   * an emulator in tests (e.g. `http://localhost:8080/v2`). Combined with
   * `gcpProjectId`/`gcpRegion` into the client's absolute `basePath`.
   */
  readonly instancesApiBaseUrl: string;
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
  /**
   * OpenRouter API key injected into created Instances as OPENROUTER_API_KEY
   * (issue #41 — the agent-host resolves it per LLM request via its default
   * LLM_API_KEY_ENV). Same secret posture as the GitHub App PEM: plain env
   * value, never logged, never interpolated into errors.
   */
  readonly openrouterApiKey: string;
  /**
   * Cloud SQL connection name (`<project>:<region>:<instance>`, the
   * `sql_connection_name` Terraform output) for the `cloudSqlInstance` volume
   * attached to every created Instance (issue #56 — the Instance's only path
   * to Cloud SQL, mounted at /cloudsql). Not a secret (it also appears inside
   * the socket-form `agentHostDatabaseUrl`), but it MUST agree with that URL's
   * `host=` parameter — the factory refuses to build a client when they
   * disagree, so changing one without the other fails before any create.
   */
  readonly cloudSqlConnectionName: string;
  /**
   * Optional agent-host LLM overrides, passed through to created Instances
   * ONLY when set (issue #41). Unset means "defer to the agent-host
   * defaults" (LLM_BASE_URL https://openrouter.ai/api/v1,
   * LLM_MODEL deepseek/deepseek-v4-flash, LLM_APPROVAL_POLICY ask).
   */
  readonly llmBaseUrl?: string;
  readonly llmModel?: string;
  readonly llmApprovalPolicy?: "ask" | "never";
  /**
   * Stopped-Instance GC sweep cadence in ms (issue #85 案A). 0 disables the
   * background sweeper. Defaults to hourly.
   */
  readonly instanceGcIntervalMs: number;
  /**
   * How long a STOPPED workspace must be untouched before its Instance is
   * GC-deleted. Defaults to 30 days; values below 1 hour are rejected (an
   * absurdly small threshold combined with the hourly sweeper would wipe
   * every stopped Instance at once).
   */
  readonly instanceGcStaleAfterMs: number;
  /**
   * Per-sweep delete cap (issue #85: bounds the blast radius of a future
   * eligibility bug). Oldest-first; the remainder waits for the next sweep.
   * Defaults to 10.
   */
  readonly instanceGcMaxDeletesPerSweep: number;
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
    instancesApiBaseUrl: readInstancesApiBaseUrl(env),
    agentHostImage: env["AGENT_HOST_IMAGE"]!.trim(),
    agentHostServiceAccount: env["AGENT_HOST_SERVICE_ACCOUNT"]!.trim(),
    checkpointBucket: env["CHECKPOINT_BUCKET"]!.trim(),
    agentHostDatabaseUrl: env["AGENT_HOST_DATABASE_URL"]!.trim(),
    githubAppId: env["GITHUB_APP_ID"]!.trim(),
    // The PEM is multi-line — never trim interior content, only the value as
    // a whole is required to be non-blank (checked above). Trailing newlines
    // from Secret Manager mounts are harmless for the broker.
    githubAppPrivateKeyPem: env["GITHUB_APP_PRIVATE_KEY_PEM"]!,
    openrouterApiKey: env["OPENROUTER_API_KEY"]!.trim(),
    cloudSqlConnectionName: env["CLOUD_SQL_CONNECTION_NAME"]!.trim(),
    ...readLlmOverrides(env),
    instanceGcIntervalMs: readOptionalMs(
      env["INSTANCE_GC_INTERVAL_MS"],
      "INSTANCE_GC_INTERVAL_MS",
      DEFAULT_INSTANCE_GC_INTERVAL_MS,
      0,
    ),
    instanceGcStaleAfterMs: readOptionalMs(
      env["INSTANCE_GC_STALE_AFTER_MS"],
      "INSTANCE_GC_STALE_AFTER_MS",
      DEFAULT_INSTANCE_GC_STALE_AFTER_MS,
      MIN_INSTANCE_GC_STALE_AFTER_MS,
    ),
    instanceGcMaxDeletesPerSweep: readOptionalMs(
      env["INSTANCE_GC_MAX_DELETES_PER_SWEEP"],
      "INSTANCE_GC_MAX_DELETES_PER_SWEEP",
      DEFAULT_INSTANCE_GC_MAX_DELETES_PER_SWEEP,
      1,
    ),
  };
}

/**
 * Optional millisecond duration (issue #85 GC tuning). Blank/unset means the
 * default. Must be an integer >= `min`, otherwise boot fails fast with the
 * variable named.
 */
function readOptionalMs(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`invalid ${name}: ${JSON.stringify(raw)} (want an integer >= ${min})`);
  }
  return parsed;
}

/**
 * Instances API origin + version (issue #47). Blank/unset means the
 * production default. A non-absolute value fails here, at control-plane boot,
 * instead of failing the first open() inside fetch() with "URL is invalid".
 */
function readInstancesApiBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const raw = env["INSTANCES_API_BASE_URL"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_INSTANCES_API_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `invalid INSTANCES_API_BASE_URL: ${JSON.stringify(raw)} (want an absolute http(s) URL like ${DEFAULT_INSTANCES_API_BASE_URL})`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `invalid INSTANCES_API_BASE_URL: ${JSON.stringify(raw)} (want an absolute http(s) URL like ${DEFAULT_INSTANCES_API_BASE_URL})`,
    );
  }
  return raw;
}

/**
 * Optional agent-host LLM overrides (issue #41). Blank means "unset" — the
 * key is omitted from the Instance env so the agent-host default applies
 * (same blank-falls-back-to-default rule as apps/agent-host/src/config.ts).
 * An invalid LLM_APPROVAL_POLICY fails here, at control-plane boot, not in
 * the first turn inside the Instance. No secret values are involved, but this
 * still never echoes env values into errors beyond the offending policy
 * token (which is operator input, not a credential).
 */
function readLlmOverrides(
  env: Readonly<Record<string, string | undefined>>,
): Pick<ControlPlaneConfig, "llmBaseUrl" | "llmModel" | "llmApprovalPolicy"> {
  const out: { llmBaseUrl?: string; llmModel?: string; llmApprovalPolicy?: "ask" | "never" } = {};
  const baseUrl = env["LLM_BASE_URL"]?.trim();
  if (baseUrl !== undefined && baseUrl !== "") out.llmBaseUrl = baseUrl;
  const model = env["LLM_MODEL"]?.trim();
  if (model !== undefined && model !== "") out.llmModel = model;
  const policyRaw = env["LLM_APPROVAL_POLICY"]?.trim();
  if (policyRaw !== undefined && policyRaw !== "") {
    if (policyRaw !== "ask" && policyRaw !== "never") {
      throw new Error(`invalid LLM_APPROVAL_POLICY: ${policyRaw} (want "ask" or "never")`);
    }
    out.llmApprovalPolicy = policyRaw;
  }
  return out;
}
