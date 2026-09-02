// Controller lease — single-writer per workspace
// Spec section 20: controllersPerWorkspace = 1, heartbeat 15s, expiry 45s
// Implementation guide section 26: INSERT ... ON CONFLICT ... guarded by expiry, inside transaction

export const CONTROLLERS_PER_WORKSPACE = 1 as const;

export const HEARTBEAT_INTERVAL_MS = 15_000 as const;

export const LEASE_EXPIRY_MS = 45_000 as const;

export interface ControllerLease {
  readonly workspaceId: string;
  readonly controllerId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly updatedAt: Date;
}

export interface TakeoverResult {
  readonly lease: ControllerLease;
  /** Previous controller id that was demoted to observer, or null if no prior lease. */
  readonly previousControllerId: string | null;
  readonly previousUserId: string | null;
}

export class LeaseAlreadyHeldError extends Error {
  readonly name = "LeaseAlreadyHeldError";
  constructor(
    public readonly workspaceId: string,
    public readonly holderControllerId: string,
  ) {
    super(`lease already held for workspace ${workspaceId} by ${holderControllerId}`);
  }
}

export class NotLeaseOwnerError extends Error {
  readonly name = "NotLeaseOwnerError";
  constructor(
    public readonly workspaceId: string,
    public readonly controllerId: string,
  ) {
    super(`controller ${controllerId} is not owner of lease for workspace ${workspaceId}`);
  }
}

export class LeaseNotFoundError extends Error {
  readonly name = "LeaseNotFoundError";
  constructor(public readonly workspaceId: string) {
    super(`no lease found for workspace ${workspaceId}`);
  }
}

export class LeaseExpiredError extends Error {
  readonly name = "LeaseExpiredError";
  constructor(public readonly workspaceId: string) {
    super(`lease expired for workspace ${workspaceId}`);
  }
}

export interface ControllerLeaseRecord {
  workspaceId: string;
  controllerId: string;
  userId: string;
  expiresAt: Date;
  updatedAt: Date;
}

export interface LeaseTransaction {
  findByWorkspaceId(workspaceId: string): Promise<ControllerLeaseRecord | null>;
  insert(record: ControllerLeaseRecord): Promise<void>;
  update(record: ControllerLeaseRecord): Promise<void>;
  delete(workspaceId: string): Promise<void>;
}

export interface LeaseStore {
  transaction<T>(fn: (tx: LeaseTransaction) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface ControllerLeaseServiceOptions {
  store: LeaseStore;
  clock?: Clock;
}

export class ControllerLeaseService {
  private readonly store: LeaseStore;
  private readonly clock: Clock;

  constructor(options: ControllerLeaseServiceOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Acquire a lease for a workspace.
   *
   * Atomically executes `INSERT ... ON CONFLICT ...` guarded by an expiry
   * condition inside a transaction: it succeeds only when no lease exists or
   * the existing lease has expired (expiresAt <= now).
   */
  async acquire(
    workspaceId: string,
    controllerId: string,
    userId: string,
  ): Promise<ControllerLease> {
    return this.store.transaction(async (tx) => {
      const existing = await tx.findByWorkspaceId(workspaceId);
      const now = this.clock.now();

      if (existing && existing.expiresAt > now) {
        throw new LeaseAlreadyHeldError(workspaceId, existing.controllerId);
      }

      const lease: ControllerLeaseRecord = {
        workspaceId,
        controllerId,
        userId,
        expiresAt: new Date(now.getTime() + LEASE_EXPIRY_MS),
        updatedAt: now,
      };

      if (existing) {
        await tx.update(lease);
      } else {
        await tx.insert(lease);
      }

      return toLease(lease);
    });
  }

  /**
   * Extend the lease expiry for the owning controller.
   * Rejected if the caller is not the current owner or the lease has expired.
   */
  async heartbeat(workspaceId: string, controllerId: string): Promise<ControllerLease> {
    return this.store.transaction(async (tx) => {
      const existing = await tx.findByWorkspaceId(workspaceId);
      const now = this.clock.now();

      if (!existing) {
        throw new LeaseNotFoundError(workspaceId);
      }
      if (existing.controllerId !== controllerId) {
        throw new NotLeaseOwnerError(workspaceId, controllerId);
      }
      if (existing.expiresAt <= now) {
        throw new LeaseExpiredError(workspaceId);
      }

      const updated: ControllerLeaseRecord = {
        ...existing,
        expiresAt: new Date(now.getTime() + LEASE_EXPIRY_MS),
        updatedAt: now,
      };
      await tx.update(updated);
      return toLease(updated);
    });
  }

  async release(workspaceId: string, controllerId: string): Promise<void> {
    return this.store.transaction(async (tx) => {
      const existing = await tx.findByWorkspaceId(workspaceId);
      if (!existing) {
        throw new LeaseNotFoundError(workspaceId);
      }
      if (existing.controllerId !== controllerId) {
        throw new NotLeaseOwnerError(workspaceId, controllerId);
      }
      await tx.delete(workspaceId);
    });
  }

  /**
   * Atomically replaces the lease with a new controller.
   * The previous controller is demoted to observer — the returned
   * `previousControllerId` lets the caller notify it.
   */
  async takeover(
    workspaceId: string,
    newControllerId: string,
    userId: string,
  ): Promise<TakeoverResult> {
    return this.store.transaction(async (tx) => {
      const existing = await tx.findByWorkspaceId(workspaceId);
      const now = this.clock.now();

      const lease: ControllerLeaseRecord = {
        workspaceId,
        controllerId: newControllerId,
        userId,
        expiresAt: new Date(now.getTime() + LEASE_EXPIRY_MS),
        updatedAt: now,
      };

      const previousControllerId = existing?.controllerId ?? null;
      const previousUserId = existing?.userId ?? null;

      if (existing) {
        await tx.update(lease);
      } else {
        await tx.insert(lease);
      }

      return {
        lease: toLease(lease),
        previousControllerId,
        previousUserId,
      };
    });
  }

  async get(workspaceId: string): Promise<ControllerLease | null> {
    return this.store.transaction(async (tx) => {
      const rec = await tx.findByWorkspaceId(workspaceId);
      if (!rec) return null;
      // Return null if expired? No — return the record but caller can check expiry.
      // For strict semantics we return the lease even if expired; acquire will treat it as acquirable.
      return toLease(rec);
    });
  }

  /** Returns lease only if not expired, otherwise null. */
  async getActive(workspaceId: string): Promise<ControllerLease | null> {
    const lease = await this.get(workspaceId);
    if (!lease) return null;
    if (lease.expiresAt <= this.clock.now()) return null;
    return lease;
  }
}

function toLease(rec: ControllerLeaseRecord): ControllerLease {
  return {
    workspaceId: rec.workspaceId,
    controllerId: rec.controllerId,
    userId: rec.userId,
    expiresAt: new Date(rec.expiresAt),
    updatedAt: new Date(rec.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// In-memory transactional store fake for tests
// ---------------------------------------------------------------------------

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
