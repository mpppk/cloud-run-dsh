// Agent Host configuration — parsed from environment at the composition root only.
// 実装手順書 section 30: the Host reads WORKSPACE_ID on every start because a
// Cloud Run Instance restart loses all local state (the recovery path IS the
// normal path).

export const DEFAULT_WORKSPACE_ROOT = "/workspace";

export const DEFAULT_SANDBOX_CLI_PATH = "/usr/local/gcp/bin/sandbox";

export const DEFAULT_PORT = 8080;

export const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";

export const DEFAULT_LLM_API_KEY_ENV = "OPENROUTER_API_KEY";

/**
 * Default wire model id (issue #21). Verified 2026-09-04 against the public
 * `GET https://openrouter.ai/api/v1/models` catalog: `deepseek/deepseek-v4-flash`
 * advertises `tools` in supported_parameters, carries a 1M-token context, and
 * is the cheapest DeepSeek-family tool-calling model on the route
 * ($0.088/MTok in at catalog time). DeepSeek-native is deliberate: the
 * `dsh-llm-deepseek` adapter's DeepSeek-specific request fields are most
 * likely to pass through on a DeepSeek model. Override with LLM_MODEL.
 */
export const DEFAULT_LLM_MODEL = "deepseek/deepseek-v4-flash";

export type LlmApprovalPolicy = "ask" | "never";

const REQUIRED_ENV_KEYS = [
  "WORKSPACE_ID",
  "CHECKPOINT_BUCKET",
  "DATABASE_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY_PEM",
  "REPOSITORY_OWNER",
  "REPOSITORY_NAME",
  "BASE_BRANCH",
  "CONTROLLER_ID",
  "USER_ID",
  "INSTANCE_NAME",
  "GCP_PROJECT_ID",
  "GCP_REGION",
] as const;

export type RequiredEnvKey = (typeof REQUIRED_ENV_KEYS)[number];

export class MissingRequiredEnvError extends Error {
  readonly name = "MissingRequiredEnvError";
  constructor(public readonly missing: readonly string[]) {
    super(`missing required environment variables: ${missing.join(", ")}`);
  }
}

export interface AgentHostConfig {
  readonly workspaceId: string;
  readonly port: number;
  /** The only mutable workspace root (仕様書 section 6.1). */
  readonly workspaceRoot: string;
  /** GCS bucket holding uncommitted workspace checkpoints (仕様書 section 7). */
  readonly checkpointBucket: string;
  readonly checkpointKey: string;
  /** Cloud SQL connection string — host-only, never passed to a sandbox. */
  readonly databaseUrl: string;
  readonly githubAppId: string;
  /** GitHub App private key PEM — host-only, never written to disk or sandbox. */
  readonly githubAppPrivateKeyPem: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly baseBranch: string;
  readonly controllerId: string;
  readonly userId: string;
  readonly instanceName: string;
  readonly gcpProjectId: string;
  readonly gcpRegion: string;
  /** Provided by Cloud Run — never vendored into the container. */
  readonly sandboxCliPath: string;
  /** Sandbox creation egress policy (実装手順書 section 9 uses --allow-egress). */
  readonly allowEgress: boolean;
  /** OpenAI-compatible chat-completions endpoint base (issue #21). */
  readonly llmBaseUrl: string;
  /**
   * Environment-variable NAME holding the LLM API key (issue #21). Only the
   * name travels in config — the key value itself is resolved per request
   * from the process environment (same rule as the adapter's `apiKeyEnv`:
   * "a literal key is not a configuration value").
   */
  readonly llmApiKeyEnv: string;
  /** Wire model id interpreted by the LLM provider adapter (issue #21). */
  readonly llmModel: string;
  /** Default approval policy for sessions without an override (issue #21). */
  readonly llmApprovalPolicy: LlmApprovalPolicy;
}

/** Checkpoint object key for a workspace (仕様書 section 7). */
export function defaultCheckpointKey(workspaceId: string): string {
  return `workspaces/${workspaceId}/checkpoint.bin`;
}

export function readAgentHostConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentHostConfig {
  const missing = REQUIRED_ENV_KEYS.filter((key) => {
    const value = env[key];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new MissingRequiredEnvError(missing);
  }

  const workspaceId = env["WORKSPACE_ID"]!.trim();
  const portRaw = env["PORT"]?.trim();
  const port = portRaw === undefined || portRaw === "" ? DEFAULT_PORT : Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PORT: ${portRaw}`);
  }

  return {
    workspaceId,
    port,
    workspaceRoot: env["WORKSPACE_ROOT"]?.trim() || DEFAULT_WORKSPACE_ROOT,
    checkpointBucket: env["CHECKPOINT_BUCKET"]!.trim(),
    checkpointKey: env["CHECKPOINT_KEY"]?.trim() || defaultCheckpointKey(workspaceId),
    databaseUrl: env["DATABASE_URL"]!.trim(),
    githubAppId: env["GITHUB_APP_ID"]!.trim(),
    githubAppPrivateKeyPem: env["GITHUB_APP_PRIVATE_KEY_PEM"]!,
    repositoryOwner: env["REPOSITORY_OWNER"]!.trim(),
    repositoryName: env["REPOSITORY_NAME"]!.trim(),
    baseBranch: env["BASE_BRANCH"]!.trim(),
    controllerId: env["CONTROLLER_ID"]!.trim(),
    userId: env["USER_ID"]!.trim(),
    instanceName: env["INSTANCE_NAME"]!.trim(),
    gcpProjectId: env["GCP_PROJECT_ID"]!.trim(),
    gcpRegion: env["GCP_REGION"]!.trim(),
    sandboxCliPath: env["SANDBOX_CLI_PATH"]?.trim() || DEFAULT_SANDBOX_CLI_PATH,
    allowEgress: env["SANDBOX_ALLOW_EGRESS"]?.trim() !== "false",
    ...readLlmConfig(env),
  };
}

function readLlmConfig(
  env: Readonly<Record<string, string | undefined>>,
): Pick<AgentHostConfig, "llmBaseUrl" | "llmApiKeyEnv" | "llmModel" | "llmApprovalPolicy"> {
  const llmBaseUrl = env["LLM_BASE_URL"]?.trim() || DEFAULT_LLM_BASE_URL;
  const llmApiKeyEnv = env["LLM_API_KEY_ENV"]?.trim() || DEFAULT_LLM_API_KEY_ENV;
  const llmModel = env["LLM_MODEL"]?.trim() || DEFAULT_LLM_MODEL;
  if (llmModel === "") {
    throw new Error("invalid LLM_MODEL: must be a non-empty model id");
  }
  const policyRaw = env["LLM_APPROVAL_POLICY"]?.trim() || "ask";
  if (policyRaw !== "ask" && policyRaw !== "never") {
    throw new Error(`invalid LLM_APPROVAL_POLICY: ${policyRaw} (want "ask" or "never")`);
  }
  return { llmBaseUrl, llmApiKeyEnv, llmModel, llmApprovalPolicy: policyRaw };
}
