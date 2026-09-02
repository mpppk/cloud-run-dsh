// Legacy placeholder (kept for compatibility with the T1 skeleton).

export interface ControlPlanePlaceholder {
  readonly kind: "control-plane";
}

export const PLACEHOLDER_KIND = "control-plane" as const;

export function createPlaceholder(): ControlPlanePlaceholder {
  return { kind: PLACEHOLDER_KIND };
}
