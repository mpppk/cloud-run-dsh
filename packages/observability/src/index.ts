// Observability — structured logging & metrics
// Spec sections 25, 26 item 12. Implementation guide sections 31, 32.

// ---------------------------------------------------------------------------
// Structured log fields (Implementation guide section 31)
// ---------------------------------------------------------------------------

export type LogSeverity = "INFO" | "WARNING" | "ERROR" | "DEBUG" | "DEFAULT";

export interface LogFields {
  readonly severity: LogSeverity;
  readonly event: string;
  /** Required correlation fields — optional in type but logger will include when available */
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly sandboxId?: string;
  readonly toolCallId?: string;
  readonly argv0?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  /** Additional fields from spec section 25 */
  readonly userId?: string;
  readonly controllerId?: string;
  readonly processId?: string;
  readonly instanceName?: string;
  /** Allow extra fields but they will be redacted */
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Secret redactor (Spec section 26 item 12)
// Applied to every log value. Covers tokens, private keys, connection strings, Bearer headers.
// ---------------------------------------------------------------------------

const REDACTED = "[REDACTED]";

// Patterns for realistic secret shapes.
// Only shapes with an unambiguous marker are matched anywhere in free text:
// vendor prefixes (ghp_/ghs_/...), "Bearer" scheme, PEM armor, DB URL schemes,
// OpenAI-style sk- keys. Bare high-entropy strings are deliberately NOT matched
// here (see HIGH_ENTROPY_TOKEN_RE note below) — everything else is redacted by
// position (isProbablySecretKey / SECRET_ASSIGNMENT_RE).
const SECRET_PATTERNS: RegExp[] = [
  // GitHub tokens
  /ghs_[A-Za-z0-9_]{20,}/g,
  /ghu_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  // OpenAI-style API keys (same prefix as the dsh-subprocess-cloud-run layer)
  /sk-[A-Za-z0-9]{20,}/g,
  // Generic token-like (Bearer, x-access-token, etc.)
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /x-access-token:[^\s]+/gi,
  // Private keys (PEM body)
  /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g,
  // Connection strings
  /postgres(?:ql)?:\/\/[^\s"']+/gi,
  /mysql:\/\/[^\s"']+/gi,
];

/**
 * KEY=VALUE / KEY:VALUE assignments whose key is a known secret name, matched
 * in free text (e.g. `API_KEY=xyz`, `"password": "xyz"`). The key name is the
 * position signal; the value is redacted regardless of shape or length, so
 * short values that no entropy check could catch are still covered.
 */
const SECRET_ASSIGNMENT_RE =
  /["']?(API[_-]?KEY|SECRET|TOKEN|PRIVATE[_-]?KEY|PASSWORD|PASSWD)["']?\s*[:=]\s*["']?[^\s"'`{},;\]]+/gi;

/**
 * @deprecated Kept only for backward-compatible imports. Since #29 this
 * pattern is intentionally NOT applied by the redactor: matching bare
 * `[A-Za-z0-9_-]{20,}` strings by value shape redacted legitimate 20+ char
 * technical identifiers (`RuntimeNotWiredError`, long PascalCase names) and
 * could not distinguish random tokens from commit SHAs. Redaction is now
 * position-based (secret-like keys, KEY=VALUE assignments) plus
 * marker-prefixed shapes (SECRET_PATTERNS).
 */
export const HIGH_ENTROPY_TOKEN_RE = /[A-Za-z0-9_\-]{20,}/g;

function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  // Position-based: redact the VALUE of KEY=VALUE assignments with known
  // secret names, keeping the key for log readability.
  out = out.replace(SECRET_ASSIGNMENT_RE, "$1=[REDACTED]");
  return out;
}

function isProbablySecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (
    lower.includes("token") ||
    lower.includes("private_key") ||
    lower.includes("privatekey") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("passwd") ||
    lower.includes("authorization") ||
    lower.includes("cookie") ||
    lower.includes("credential") ||
    lower.includes("api_key") ||
    lower.includes("apikey") ||
    lower.includes("api-key") ||
    lower.includes("access_key") ||
    lower.includes("accesskey") ||
    lower.includes("access-key") ||
    lower.includes("connection_string") ||
    lower.includes("database_url") ||
    lower.includes("bearer")
  ) {
    return true;
  }
  // "key" as a standalone word (apiKey, my_key, access-key). A plain substring
  // check would false-positive on "monkey"/"keyboard", so split the name into
  // words on separators and camelCase boundaries first.
  const words = key.split(/(?<=[a-z0-9])(?=[A-Z])|[_.\-\s]+/).map((w) => w.toLowerCase());
  return words.includes("key") || words.includes("keys");
}

export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isProbablySecretKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactValue(v);
      }
    }
    return out;
  }
  return value;
}

export function redactLogFields(fields: LogFields): LogFields {
  // Redact every value; also ensure severity/event are preserved but still redacted if they contain secrets
  const redacted = redactValue(fields) as LogFields;
  return redacted;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface Logger {
  log(fields: LogFields): void;
  info(event: string, fields?: Omit<LogFields, "severity" | "event">): void;
  warn(event: string, fields?: Omit<LogFields, "severity" | "event">): void;
  error(event: string, fields?: Omit<LogFields, "severity" | "event">): void;
}

export interface LoggerOptions {
  /** Where to write JSON lines (default: console.log) */
  readonly sink?: (line: string) => void;
  /** Clock for timestamp (injectable for tests) */
  readonly clock?: () => Date;
  /** Default fields merged into every log line */
  readonly defaultFields?: Partial<LogFields>;
}

function sanitizeFieldsForLogging(
  fields: LogFields,
): LogFields {
  // Enforce: NEVER log full command line or full environment.
  // Only argv0 and argument count are allowed. If fields contain argv, args, command, env, etc.,
  // strip them and optionally keep argv0 + argCount.
  const sanitized: Record<string, unknown> = { ...fields };

  // Detect forbidden keys that would leak full command/env
  const forbiddenKeys = ["argv", "args", "command", "commandLine", "env", "environment", "fullCommand"];
  for (const k of forbiddenKeys) {
    if (k in sanitized) {
      // If it's argv as array, keep only argv0 + count
      if (k === "argv" && Array.isArray(sanitized[k])) {
        const arr = sanitized[k] as unknown[];
        sanitized["argv0"] = sanitized["argv0"] ?? (arr[0] as string | undefined);
        sanitized["argCount"] = arr.length;
      } else if (k === "args" && Array.isArray(sanitized[k])) {
        sanitized["argCount"] = (sanitized[k] as unknown[]).length;
      }
      delete sanitized[k];
    }
  }

  // If argv0 not set but we have no forbidden keys, that's fine — just don't add full command.
  return sanitized as LogFields;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? ((line: string) => console.log(line));
  const clock = options.clock ?? (() => new Date());
  const defaults = options.defaultFields ?? {};

  function emit(fields: LogFields): void {
    const sanitized = sanitizeFieldsForLogging(fields);
    const merged = { ...defaults, ...sanitized } as LogFields;
    const redacted = redactLogFields(merged);
    const line = JSON.stringify({
      timestamp: clock().toISOString(),
      ...redacted,
    });
    sink(line);
  }

  return {
    log: emit,
    info: (event, fields) => emit({ ...(fields as LogFields), severity: "INFO", event }),
    warn: (event, fields) => emit({ ...(fields as LogFields), severity: "WARNING", event }),
    error: (event, fields) => emit({ ...(fields as LogFields), severity: "ERROR", event }),
  };
}

/**
 * In-memory logger for tests — captures JSON lines.
 */
export class InMemoryLogger implements Logger {
  public readonly lines: string[] = [];
  public readonly parsed: LogFields[] = [];

  private readonly inner: Logger;

  constructor(defaultFields?: Partial<LogFields>) {
    this.inner = createLogger({
      sink: (line) => {
        this.lines.push(line);
        try {
          this.parsed.push(JSON.parse(line) as LogFields);
        } catch {
          // ignore parse errors in test sink
        }
      },
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      defaultFields,
    });
  }

  log(fields: LogFields): void {
    this.inner.log(fields);
  }
  info(event: string, fields?: Omit<LogFields, "severity" | "event">): void {
    this.inner.info(event, fields);
  }
  warn(event: string, fields?: Omit<LogFields, "severity" | "event">): void {
    this.inner.warn(event, fields);
  }
  error(event: string, fields?: Omit<LogFields, "severity" | "event">): void {
    this.inner.error(event, fields);
  }
}

// ---------------------------------------------------------------------------
// Metrics facade (Implementation guide section 32)
// ---------------------------------------------------------------------------

export const METRIC_NAMES = {
  workspaceStartDuration: "workspace.start.duration",
  workspaceRestoreDuration: "workspace.restore.duration",
  workspaceCheckpointDuration: "workspace.checkpoint.duration",
  sandboxCreateDuration: "sandbox.create.duration",
  sandboxExecDuration: "sandbox.exec.duration",
  sandboxResetCount: "sandbox.reset.count",
  agentTurnDuration: "agent.turn.duration",
  subprocessTimeoutCount: "subprocess.timeout.count",
  instanceActiveMinutes: "instance.active_minutes",
  cpuUtilization: "cpu.utilization",
  memoryUtilization: "memory.utilization",
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

export interface MetricTags {
  readonly [key: string]: string;
}

export interface MetricEvent {
  readonly name: MetricName;
  readonly value: number;
  readonly tags?: MetricTags;
  readonly timestampMs?: number;
}

export interface Metrics {
  /** Record a duration in milliseconds */
  recordDuration(name: MetricName, durationMs: number, tags?: MetricTags): void;
  /** Increment a counter */
  increment(name: MetricName, value?: number, tags?: MetricTags): void;
  /** Record a gauge value */
  gauge(name: MetricName, value: number, tags?: MetricTags): void;
  /** Generic record */
  record(event: MetricEvent): void;
}

export class NoOpMetrics implements Metrics {
  recordDuration(): void {}
  increment(): void {}
  gauge(): void {}
  record(): void {}
}

export class InMemoryMetrics implements Metrics {
  public readonly events: MetricEvent[] = [];

  recordDuration(name: MetricName, durationMs: number, tags?: MetricTags): void {
    this.events.push({ name, value: durationMs, tags, timestampMs: Date.now() });
  }
  increment(name: MetricName, value = 1, tags?: MetricTags): void {
    this.events.push({ name, value, tags, timestampMs: Date.now() });
  }
  gauge(name: MetricName, value: number, tags?: MetricTags): void {
    this.events.push({ name, value, tags, timestampMs: Date.now() });
  }
  record(event: MetricEvent): void {
    this.events.push(event);
  }

  /** Helper for tests: find events by name */
  findByName(name: MetricName): MetricEvent[] {
    return this.events.filter((e) => e.name === name);
  }

  clear(): void {
    this.events.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Placeholder (kept for backward compat / smoke test)
// ---------------------------------------------------------------------------

export interface ObservabilityPlaceholder {
  readonly kind: "observability";
}

export const PLACEHOLDER_KIND = "observability" as const;

export function createPlaceholder(): ObservabilityPlaceholder {
  return { kind: PLACEHOLDER_KIND };
}
