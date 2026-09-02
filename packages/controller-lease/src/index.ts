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
  /**
   * Runs `fn` inside a transaction.
   *
   * Isolation contract: the implementation MUST serialise concurrent
   * transactions — reads inside `fn` must observe a consistent snapshot and
   * its writes must not be lost against concurrent transactions. A real SQL
   * store can satisfy this with `SERIALIZABLE` isolation, or with
   * `SELECT ... FOR UPDATE` row locks under READ COMMITTED.
   *
   * Note: `acquire` and `heartbeat` do NOT depend on this contract — they use
   * the single-statement conditional primitives `upsertIfExpired` /
   * `extendIfOwner`, which are safe even under READ COMMITTED. Only flows
   * that intentionally do read-then-write inside `fn` (takeover, release)
   * rely on the serialisation guaranteed here.
   */
  transaction<T>(fn: (tx: LeaseTransaction) => Promise<T>): Promise<T>;

  /**
   * Atomic conditional upsert (single-statement CAS for acquire).
   *
   * Inserts `record`, or replaces the existing row for
   * `record.workspaceId` when that row has already expired as of `now`
   * (`existing.expiresAt <= now`). Expresses the condition in a single
   * operation — the shape a real store implements as:
   *
   *   INSERT ... ON CONFLICT (workspace_id) DO UPDATE SET ...
   *   WHERE controller_leases.expires_at <= $now
   *
   * Returns the stored row on success (fresh insert or expiry-replace), or
   * `null` when an unexpired lease is still held. Implementations MUST map
   * driver-level conflict errors (e.g. a unique violation surfacing from a
   * concurrent insert) to the `null` return — a raw driver error must never
   * escape to callers; callers map `null` to `LeaseAlreadyHeldError`.
   */
  upsertIfExpired(
    record: ControllerLeaseRecord,
    now: Date,
  ): Promise<ControllerLeaseRecord | null>;

  /**
   * Atomic conditional extend (single-statement CAS for heartbeat).
   *
   * Extends the lease for `workspaceId` to expire at `extendTo` (with
   * `updatedAt = now`) only when it is currently owned by `controllerId` and
   * still unexpired as of `now`. Expresses the condition in a single
   * operation — the shape a real store implements as:
   *
   *   UPDATE controller_leases
   *   SET expires_at = $extendTo, updated_at = $now
   *   WHERE workspace_id = $workspaceId
   *     AND controller_id = $controllerId
   *     AND expires_at > $now
   *
   * Returns the updated row, or `null` when the CAS failed (lease missing,
   * owned by another controller, or expired). A failed CAS MUST NOT write
   * anything; callers map `null` to the typed heartbeat errors.
   */
  extendIfOwner(
    workspaceId: string,
    controllerId: string,
    extendTo: Date,
    now: Date,
  ): Promise<ControllerLeaseRecord | null>;
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
   * Delegates to the single-statement CAS `upsertIfExpired` (`INSERT ... ON
   * CONFLICT ... WHERE expires_at <= now`): it succeeds only when no lease
   * exists or the existing lease has expired (expiresAt <= now). A lost CAS
   * (an unexpired lease is held) is mapped to `LeaseAlreadyHeldError` — no
   * raw driver error escapes.
   */
  async acquire(
    workspaceId: string,
    controllerId: string,
    userId: string,
  ): Promise<ControllerLease> {
    const now = this.clock.now();

    const record: ControllerLeaseRecord = {
      workspaceId,
      controllerId,
      userId,
      expiresAt: new Date(now.getTime() + LEASE_EXPIRY_MS),
      updatedAt: now,
    };

    const stored = await this.store.upsertIfExpired(record, now);
    if (!stored) {
      const holder = await this.store.transaction((tx) =>
        tx.findByWorkspaceId(workspaceId),
      );
      throw new LeaseAlreadyHeldError(
        workspaceId,
        holder?.controllerId ?? "unknown",
      );
    }

    return toLease(stored);
  }

  /**
   * Extend the lease expiry for the owning controller.
   *
   * Delegates to the single-statement CAS `extendIfOwner`
   * (`UPDATE ... WHERE controller_id = $1 AND expires_at > now`): the extend
   * is applied only if the caller still owns an unexpired lease at execution
   * time. A failed CAS never writes, so a stale heartbeat issued after a
   * takeover cannot overwrite the committed lease or resurrect the demoted
   * controller; the failure is classified into the typed errors below.
   */
  async heartbeat(workspaceId: string, controllerId: string): Promise<ControllerLease> {
    const now = this.clock.now();
    const extendTo = new Date(now.getTime() + LEASE_EXPIRY_MS);

    const updated = await this.store.extendIfOwner(
      workspaceId,
      controllerId,
      extendTo,
      now,
    );
    if (updated) {
      return toLease(updated);
    }

    // CAS failed — classify for the typed error only (no write has occurred).
    const existing = await this.store.transaction((tx) =>
      tx.findByWorkspaceId(workspaceId),
    );
    if (!existing) {
      throw new LeaseNotFoundError(workspaceId);
    }
    if (existing.controllerId !== controllerId) {
      throw new NotLeaseOwnerError(workspaceId, controllerId);
    }
    if (existing.expiresAt <= now) {
      throw new LeaseExpiredError(workspaceId);
    }
    // The CAS failed but the row now looks extendable: the row changed
    // between the CAS and this read. Fence with NotLeaseOwnerError.
    throw new NotLeaseOwnerError(workspaceId, controllerId);
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
