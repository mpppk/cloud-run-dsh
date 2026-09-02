import type { SandboxManager } from "@cloud-run-dsh/cloud-run-sandbox";
import { CloudRunSubprocessRuntime, resolveExecutable } from "./runtime.js";
import type { ProcessResult, SpawnOptions } from "./runtime.js";

export interface SubprocessProvider {
  resolveExecutable(command: string): Promise<string>;
  spawn(spec: SpawnOptions): Promise<ProcessResult>;
  /** Evicts the per-workspace lock registry entry on teardown. */
  dispose(): Promise<void>;
}

export interface PluginOptions {
  readonly manager: SandboxManager;
  readonly defaultTimeoutMs?: number;
  readonly secrets?: readonly string[];
}

export function createCloudRunSubprocessPlugin(opts: PluginOptions): SubprocessProvider {
  const runtime = new CloudRunSubprocessRuntime({
    manager: opts.manager,
    defaultTimeoutMs: opts.defaultTimeoutMs,
    secrets: opts.secrets,
  });

  return {
    resolveExecutable: (command: string) => resolveExecutable(command, opts.manager),
    spawn: (spec: SpawnOptions) => runtime.spawn(spec),
    dispose: () => runtime.dispose(),
  };
}

// Alias for harness convention
export function createPlugin(opts: PluginOptions): SubprocessProvider {
  return createCloudRunSubprocessPlugin(opts);
}
