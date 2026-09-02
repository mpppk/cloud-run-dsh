// Control Plane — Workspace API & Instance Controller (skeleton)
export interface ControlPlaneConfig {
  readonly port: number;
  readonly instanceRegion: string;
}

export interface ControlPlanePlaceholder {
  readonly kind: "control-plane";
  readonly config: ControlPlaneConfig;
}

export const PLACEHOLDER_KIND = "control-plane" as const;

export function createPlaceholder(): ControlPlanePlaceholder {
  return {
    kind: PLACEHOLDER_KIND,
    config: {
      port: 8080,
      instanceRegion: "us-central1",
    },
  };
}
