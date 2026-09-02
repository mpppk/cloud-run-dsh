export { ALLOWED_ENV, FORBIDDEN_ENV_KEYS, filterEnv } from "@cloud-run-dsh/cloud-run-sandbox";

import { filterEnv } from "@cloud-run-dsh/cloud-run-sandbox";

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
