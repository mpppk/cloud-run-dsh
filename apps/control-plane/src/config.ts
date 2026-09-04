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
   * socket path (`postgresql://user:pass@/dsh?host=/cloudsql/<conn>`) — the
   * Instance reaches Cloud SQL through its `cloudSqlInstance` volume, never
   * over the control plane's TCP address (see docs/deployment-runbook.md).
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
   * Optional agent-host LLM overrides, passed through to created Instances
   * ONLY when set (issue #41). Unset means "defer to the agent-host
   * defaults" (LLM_BASE_URL https://openrouter.ai/api/v1,
   * LLM_MODEL deepseek/deepseek-v4-flash, LLM_APPROVAL_POLICY ask).
   */
  readonly llmBaseUrl?: string;
  readonly llmModel?: string;
  readonly llmApprovalPolicy?: "ask" | "never";
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
    openrouterApiKey: env["OPENROUTER_API_KEY"]!.trim(),
    ...readLlmOverrides(env),
  };
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
