// Harness subprocess provider via Cloud Run Sandbox
export interface SubprocessSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface DshSubprocessPlaceholder {
  readonly kind: "dsh-subprocess-cloud-run";
}

export const PLACEHOLDER_KIND = "dsh-subprocess-cloud-run" as const;

export function createPlaceholder(): DshSubprocessPlaceholder {
  return {
    kind: PLACEHOLDER_KIND,
  };
}
