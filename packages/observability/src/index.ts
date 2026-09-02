// Observability — structured logging & metrics
export interface LogFields {
  readonly severity: "INFO" | "WARNING" | "ERROR";
  readonly event: string;
  readonly workspaceId?: string;
}

export interface ObservabilityPlaceholder {
  readonly kind: "observability";
}

export const PLACEHOLDER_KIND = "observability" as const;

export function createPlaceholder(): ObservabilityPlaceholder {
  return { kind: PLACEHOLDER_KIND } as ObservabilityPlaceholder;
}
