import type { SessionEvent, NewSessionEvent } from "./types.js";
import type { SessionPersistenceRepository } from "./repository.js";

/**
 * Harness `ctx.sessionPersistence` semantics:
 * - append-only
 * - contiguous seq
 * - durable append (transactional)
 * - persisted events are immutable
 */
export interface SessionPersistence {
  append(sessionId: string, events: NewSessionEvent[]): Promise<SessionEvent[]>;
  readEvents(sessionId: string, fromSeq?: number): Promise<SessionEvent[]>;
}

export class PostgresSessionPersistence implements SessionPersistence {
  constructor(private readonly repo: SessionPersistenceRepository) {}

  async append(sessionId: string, events: NewSessionEvent[]): Promise<SessionEvent[]> {
    return this.repo.append(sessionId, events);
  }

  async readEvents(sessionId: string, fromSeq?: number): Promise<SessionEvent[]> {
    return this.repo.readEvents(sessionId, fromSeq);
  }
}
