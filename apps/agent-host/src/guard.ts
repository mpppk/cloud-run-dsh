// Sandbox exec guard — defense-in-depth at the host adapter boundary
// (仕様書 sections 4.2, 14, 26).
//
// The Cloud Run Sandbox platform already blocks the metadata server and host
// environment inheritance for sandboxes (仕様書 section 4.2); the guard makes
// the host REFUSE suspicious exec requests itself instead of relying only on
// the platform:
//   - cwd must be inside /workspace (spec 26 item 2),
//   - commands targeting the GCP metadata server are refused (spec 26 item 3),
//   - sandbox creation egress policy is expressed at the adapter boundary
//     (`runArgvForPolicy`).

import { buildRunArgv } from "@cloud-run-dsh/cloud-run-sandbox";
import type {
  SandboxExecRequest,
  SandboxManager,
  SubprocessHandle,
} from "@cloud-run-dsh/cloud-run-sandbox";
import { resolveInsideWorkspace } from "./paths.js";

export const METADATA_HOSTS = ["169.254.169.254", "metadata.google.internal"] as const;

export class SandboxExecRefusedError extends Error {
  readonly name = "SandboxExecRefusedError";
  constructor(public readonly reason: string) {
    super(`sandbox exec refused: ${reason}`);
  }
}

export function assertInsideWorkspace(
  workspaceRoot: string,
  cwd: string,
): string {
  try {
    return resolveInsideWorkspace(workspaceRoot, cwd);
  } catch (e) {
    throw new SandboxExecRefusedError(
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Refuses exec requests that reference the GCP metadata server. */
export function assertNoMetadataAccess(
  command: string,
  args: readonly string[],
): void {
  const haystack = [command, ...args].join(" ");
  for (const host of METADATA_HOSTS) {
    if (haystack.includes(host)) {
      throw new SandboxExecRefusedError(
        `access to the GCP metadata server (${host}) is refused`,
      );
    }
  }
}

export interface GuardedSandboxManagerOptions {
  readonly workspaceRoot?: string;
}

/**
 * Wraps a SandboxManager so every exec request is validated at the host
 * boundary before reaching the sandbox CLI. All other operations delegate.
 */
export function createGuardedSandboxManager(
  inner: SandboxManager,
  options: GuardedSandboxManagerOptions = {},
): SandboxManager {
  const workspaceRoot = options.workspaceRoot ?? "/workspace";
  return {
    getWorkspaceId: () => inner.getWorkspaceId(),
    ensureRunning: () => inner.ensureRunning(),
    exec: (request: SandboxExecRequest): SubprocessHandle => {
      assertInsideWorkspace(workspaceRoot, request.cwd);
      assertNoMetadataAccess(request.command, request.args);
      return inner.exec(request);
    },
    reset: () => inner.reset(),
    dispose: () => inner.dispose(),
  };
}

/**
 * Sandbox creation argv for the configured egress policy
 * (実装手順書 section 9). When egress is disabled, `--allow-egress` is omitted
 * so the sandbox is created without network access — the live network refusal
 * is enforced by the platform and covered by an integration test.
 */
export function runArgvForPolicy(
  sandboxId: string,
  allowEgress: boolean,
): readonly string[] {
  const argv = buildRunArgv(sandboxId);
  return allowEgress ? argv : argv.filter((arg) => arg !== "--allow-egress");
}
