// Testing entrypoint — in-memory test doubles for the controller lease seam.
// NOT exported from the production index: import via
// `@cloud-run-dsh/controller-lease/testing` from tests only.

import type {
  Clock,
  ControllerLeaseRecord,
  LeaseStore,
  LeaseTransaction,
} from "./index.js";

/**
 * Simple async mutex for serialising transactions.
 */
class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.locked = true;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

export class InMemoryLeaseStore implements LeaseStore {
  private data = new Map<string, ControllerLeaseRecord>();
  private mutex = new Mutex();

  async transaction<T>(fn: (tx: LeaseTransaction) => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire();
    // Snapshot for rollback on error
    const snapshot = new Map(this.data);
    // Create a transaction view that operates on the live map but can roll back
    const tx: LeaseTransaction = {
      findByWorkspaceId: async (workspaceId) => {
        const rec = this.data.get(workspaceId);
        return rec ? { ...rec } : null;
      },
      insert: async (record) => {
        if (this.data.has(record.workspaceId)) {
          throw new Error(`duplicate key: ${record.workspaceId}`);
        }
        this.data.set(record.workspaceId, { ...record });
      },
      update: async (record) => {
        this.data.set(record.workspaceId, { ...record });
      },
      delete: async (workspaceId) => {
        this.data.delete(workspaceId);
      },
    };
    try {
      const result = await fn(tx);
      return result;
    } catch (e) {
      // Rollback to snapshot
      this.data = snapshot;
      throw e;
    } finally {
      release();
    }
  }

  async upsertIfExpired(
    record: ControllerLeaseRecord,
    now: Date,
  ): Promise<ControllerLeaseRecord | null> {
    const release = await this.mutex.acquire();
    try {
      const existing = this.data.get(record.workspaceId);
      // CAS lost: an unexpired lease is still held (expiresAt == now counts as expired).
      if (existing && existing.expiresAt > now) {
        return null;
      }
      const stored = { ...record };
      this.data.set(record.workspaceId, stored);
      return { ...stored };
    } finally {
      release();
    }
  }

  async extendIfOwner(
    workspaceId: string,
    controllerId: string,
    extendTo: Date,
    now: Date,
  ): Promise<ControllerLeaseRecord | null> {
    const release = await this.mutex.acquire();
    try {
      const existing = this.data.get(workspaceId);
      // CAS lost: missing, not the owner, or already expired — no write.
      if (
        !existing ||
        existing.controllerId !== controllerId ||
        existing.expiresAt <= now
      ) {
        return null;
      }
      const updated: ControllerLeaseRecord = {
        ...existing,
        expiresAt: new Date(extendTo),
        updatedAt: new Date(now),
      };
      this.data.set(workspaceId, updated);
      return { ...updated };
    } finally {
      release();
    }
  }

  /** Direct read without transaction (for debug). */
  peek(workspaceId: string): ControllerLeaseRecord | null {
    const rec = this.data.get(workspaceId);
    return rec ? { ...rec } : null;
  }

  /** Seed a record directly (for test setup). */
  seed(record: ControllerLeaseRecord): void {
    this.data.set(record.workspaceId, { ...record });
  }
}

export class FakeClock implements Clock {
  private current: Date;
  constructor(initial: Date = new Date("2026-01-01T00:00:00Z")) {
    this.current = new Date(initial);
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = new Date(date);
  }
}
