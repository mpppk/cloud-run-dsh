export interface SandboxCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxCliRunner {
  run(
    argv: readonly string[],
    opts?: { stdin?: string | Uint8Array; signal?: AbortSignal },
  ): Promise<SandboxCliResult>;
}

export interface SandboxExecRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string | Uint8Array;
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface SubprocessHandle {
  /** Promise that resolves when the sandbox exec completes. */
  readonly result: Promise<SandboxExecResult>;
}
