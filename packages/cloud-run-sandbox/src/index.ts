// Cloud Run Sandbox manager — named Sandbox per workspace
export interface SandboxExecRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface SandboxManager {
  ensureRunning(): Promise<void>;
  exec(request: SandboxExecRequest): unknown;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export interface CloudRunSandboxPlaceholder {
  readonly kind: "cloud-run-sandbox";
  readonly sandboxIdPrefix: string;
}

export const PLACEHOLDER_KIND = "cloud-run-sandbox" as const;

export function createPlaceholder(): CloudRunSandboxPlaceholder {
  return {
    kind: PLACEHOLDER_KIND,
    sandboxIdPrefix: "dsh-",
  };
}
