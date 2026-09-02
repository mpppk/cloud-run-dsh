export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /ghs_[A-Za-z0-9]{20,}/g,
];

export function redactSecrets(
  text: string,
  secrets: readonly string[] = [],
): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    // Escape for use in split — simple string replacement
    out = out.split(s).join("***");
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "***");
  }
  // Generic API key / token patterns: e.g. LLM_API_KEY=xxx
  out = out.replace(/(API_KEY|SECRET|TOKEN|PRIVATE_KEY)\s*[:=]\s*\S+/gi, "$1=***");
  return out;
}

export function truncateOutput(
  text: string,
  maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  // Keep head + indicator + tail? For MVP keep head and append indicator.
  const truncated = buf.subarray(0, maxBytes).toString("utf-8");
  return truncated + `\n[truncated ${buf.length - maxBytes} bytes]`;
}

export function processOutput(
  text: string,
  opts?: { maxBytes?: number; secrets?: readonly string[] },
): string {
  const redacted = redactSecrets(text, opts?.secrets);
  return truncateOutput(redacted, opts?.maxBytes);
}

export type ProcessStatus = "success" | "error" | "timeout" | "cancelled";

export interface ProcessResult {
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface CollectOptions {
  readonly maxBytes?: number;
  readonly secrets?: readonly string[];
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

/**
 * Collects streamed stdout/stderr, applies redaction + truncation.
 * Fake runner can call the onStdout/onStderr callbacks per chunk.
 */
export class OutputCollector {
  private stdoutBuf = "";
  private stderrBuf = "";
  private readonly maxBytes: number;
  private readonly secrets: readonly string[];
  private readonly onStdout?: (c: string) => void;
  private readonly onStderr?: (c: string) => void;

  constructor(opts: CollectOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.secrets = opts.secrets ?? [];
    this.onStdout = opts.onStdout;
    this.onStderr = opts.onStderr;
  }

  pushStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    if (this.onStdout) this.onStdout(chunk);
  }

  pushStderr(chunk: string): void {
    this.stderrBuf += chunk;
    if (this.onStderr) this.onStderr(chunk);
  }

  finalize(exitCode: number | null, durationMs: number, status: ProcessStatus): ProcessResult {
    const stdout = processOutput(this.stdoutBuf, {
      maxBytes: this.maxBytes,
      secrets: this.secrets,
    });
    const stderr = processOutput(this.stderrBuf, {
      maxBytes: this.maxBytes,
      secrets: this.secrets,
    });
    const truncated =
      Buffer.byteLength(this.stdoutBuf, "utf-8") > this.maxBytes ||
      Buffer.byteLength(this.stderrBuf, "utf-8") > this.maxBytes;
    return { status, exitCode, stdout, stderr, durationMs, truncated };
  }

  get stdoutRaw(): string {
    return this.stdoutBuf;
  }
  get stderrRaw(): string {
    return this.stderrBuf;
  }
}
