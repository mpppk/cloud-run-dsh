// Cloud Run Sandbox manager — named Sandbox per workspace
export { toSandboxId, isValidWorkspaceId } from "./sandboxId.js";
export { buildRunArgv, buildExecArgv, buildDeleteArgv } from "./argv.js";
export type { ExecArgvOptions } from "./argv.js";
export type {
  SandboxCliRunner,
  SandboxCliResult,
  SandboxExecRequest,
  SandboxExecResult,
  SubprocessHandle,
} from "./types.js";
export {
  DefaultSandboxManager,
  createSandboxManager,
  type SandboxManager,
  type SandboxManagerOptions,
} from "./manager.js";

// Legacy placeholder for backwards compat if needed
export const PLACEHOLDER_KIND = "cloud-run-sandbox" as const;
export function createPlaceholder() {
  return { kind: PLACEHOLDER_KIND, sandboxIdPrefix: "dsh-" as const };
}
