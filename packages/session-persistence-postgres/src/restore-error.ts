// Failure-reason summaries for `workspaces.last_error` (issue #141).
//
// The column is operator triage material: it is read from the row during
// bring-up (docs/deployment-runbook.md) and travels into structured logs.
// It must therefore NEVER carry tokens, passwords, PEM blocks, connection
// strings, or internal URLs — summarizeRestoreError() is the single choke
// point every writer goes through (control-plane failStaleStartingWorkspace,
// agent-host RestartRecovery).
//
// Deliberately self-contained (no observability import): this package owns
// the column and its no-secrets invariant, and the rules here are stricter
// than log redaction — internal URLs (instance `*.run.app` addresses,
// `/readyz` targets) are diagnostically useless in a persisted reason and
// are stripped, not kept.

/** Maximum stored reason length — keeps rows and log lines bounded. */
export const RESTORE_ERROR_MAX_LENGTH = 500;

/** Fallback when an error carries no usable message. */
export const RESTORE_ERROR_EMPTY_FALLBACK = "restore failed (no details)";

const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // PEM blocks (GitHub App private key and friends) — may span lines, so
  // this runs BEFORE whitespace collapsing.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[redacted-pem]",
  },
  // Postgres / MySQL connection strings (carry password + host).
  {
    re: /postgres(?:ql)?:\/\/[^\s"'`]+/gi,
    replacement: "[redacted-connection-string]",
  },
  { re: /mysql:\/\/[^\s"'`]+/gi, replacement: "[redacted-connection-string]" },
  // Bearer tokens.
  { re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: "Bearer [redacted]" },
  // OpenAI / OpenRouter-style keys.
  { re: /sk-(?:or-v1-)?[A-Za-z0-9-]{16,}/g, replacement: "[redacted-api-key]" },
  // GitHub tokens.
  {
    re: /\b(?:ghp_|ghs_|ghu_|github_pat_)[A-Za-z0-9_]{20,}/g,
    replacement: "[redacted-github-token]",
  },
];

/**
 * `KEY=secret` / `"key": "secret"` assignments: the key name is the signal,
 * the value is redacted regardless of shape, so short secrets no entropy
 * check could catch are still covered. Keeps the key for readability.
 */
const SECRET_ASSIGNMENT_RE =
  /(["']?)(api[_-]?key|secret|token|private[_-]?key|password|passwd|pwd|database_url|connection_string)(["']?)(\s*[:=]\s*)(["']?)[^\s"'`{},;\]]+/gi;

/** Internal URLs (instance addresses, /readyz targets) carry no persisted value. */
const URL_RE = /https?:\/\/[^\s"'`]+/gi;

function extractMessage(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (error instanceof Error) {
    const name = error.name && error.name !== "Error" ? `${error.name}: ` : "";
    return `${name}${error.message}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? "";
  } catch {
    return "";
  }
}

/**
 * Summarizes an arbitrary failure into a single-line, bounded,
 * secret-free reason suitable for `workspaces.last_error`.
 *
 * - takes the error's message (name-prefixed for non-Error names),
 * - strips PEM blocks first (they span lines),
 * - collapses whitespace to one line,
 * - redacts secrets (PEM, connection strings, Bearer, API keys,
 *   KEY=VALUE assignments) and internal URLs,
 * - truncates to RESTORE_ERROR_MAX_LENGTH with a marker.
 */
export function summarizeRestoreError(error: unknown): string {
  let text = extractMessage(error);
  for (const { re, replacement } of SECRET_PATTERNS) {
    text = text.replace(re, replacement);
  }
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(SECRET_ASSIGNMENT_RE, "$1$2$3$4$5[redacted]");
  text = text.replace(URL_RE, "[url]");
  if (text === "") return RESTORE_ERROR_EMPTY_FALLBACK;
  if (text.length > RESTORE_ERROR_MAX_LENGTH) {
    return `${text.slice(0, RESTORE_ERROR_MAX_LENGTH)}…(truncated)`;
  }
  return text;
}
