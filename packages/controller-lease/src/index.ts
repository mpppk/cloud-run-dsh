// Controller lease — single-writer per workspace
export interface ControllerLease {
  readonly workspaceId: string;
  readonly controllerId: string;
  readonly userId: string;
  readonly expiresAt: string;
}

export interface ControllerLeasePlaceholder {
  readonly kind: "controller-lease";
}

export const PLACEHOLDER_KIND = "controller-lease" as const;

export function createPlaceholder(): ControllerLeasePlaceholder {
  return {
    kind: PLACEHOLDER_KIND,
  };
}
