export const ALLOWED_ENV = new Set([
  "CI",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "TERM",
]);

/**
 * Strict allowlist — only these keys survive.
 * Host environment is never passed through wholesale.
 */
export function filterEnv(
  input: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const key of ALLOWED_ENV) {
    const v = input[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Build the env that will be forwarded to the sandbox exec.
 * Merges caller-provided env (already filtered) — does NOT read host env implicitly.
 * Caller must explicitly pass the env they want filtered; we never read host env internally.
 */
export function buildSandboxEnv(
  callerEnv: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  return filterEnv(callerEnv);
}

/** For testing: list of secrets that must be dropped */
export const FORBIDDEN_ENV_KEYS = [
  "LLM_API_KEY",
  "DATABASE_URL",
  "GITHUB_APP_PRIVATE_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;
