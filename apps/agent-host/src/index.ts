// Agent Host — runs inside Cloud Run Instance (skeleton)
export interface AgentHostConfig {
  readonly workspaceId: string;
  readonly port: number;
}

export interface AgentHostPlaceholder {
  readonly kind: "agent-host";
  readonly config: AgentHostConfig;
}

export const PLACEHOLDER_KIND = "agent-host" as const;

export function createPlaceholder(): AgentHostPlaceholder {
  return {
    kind: PLACEHOLDER_KIND,
    config: {
      workspaceId: "test-workspace",
      port: 8080,
    },
  };
}
