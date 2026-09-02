// Session persistence via Cloud SQL PostgreSQL (skeleton)
export interface SessionEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly eventType: string;
  readonly data: unknown;
}

export interface SessionPersistencePlaceholder {
  readonly kind: "session-persistence-postgres";
}

export const PLACEHOLDER_KIND = "session-persistence-postgres" as const;

export function createPlaceholder(): SessionPersistencePlaceholder {
  return {
    kind: PLACEHOLDER_KIND,
  };
}
