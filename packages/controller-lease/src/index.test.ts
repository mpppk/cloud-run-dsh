import { describe, test, expect } from "bun:test";
import {
  CONTROLLERS_PER_WORKSPACE,
  HEARTBEAT_INTERVAL_MS,
  LEASE_EXPIRY_MS,
  ControllerLeaseService,
  LeaseAlreadyHeldError,
  NotLeaseOwnerError,
  LeaseNotFoundError,
  LeaseExpiredError,
  type ControllerLeaseRecord,
  type LeaseStore,
  type LeaseTransaction,
} from "./index.js";
import { InMemoryLeaseStore, FakeClock } from "./testing.js";

describe("controller-lease constants", () => {
  test("named constants", () => {
    expect(CONTROLLERS_PER_WORKSPACE).toBe(1);
    expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(LEASE_EXPIRY_MS).toBe(45_000);
  });
});

describe("controller-lease acquire", () => {
  test("two concurrent acquires -> exactly one winner", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock();
    const svc = new ControllerLeaseService({ store, clock });

    const results = await Promise.allSettled([
      svc.acquire("ws-1", "ctrl-A", "user-1"),
      svc.acquire("ws-1", "ctrl-B", "user-2"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LeaseAlreadyHeldError);

    const lease = await svc.get("ws-1");
    expect(lease).not.toBeNull();
    const winnerId = (fulfilled[0] as PromiseFulfilledResult<{ controllerId: string }>).value.controllerId;
    expect(["ctrl-A", "ctrl-B"]).toContain(winnerId);
    expect(lease!.controllerId).toBe(winnerId);
  });

  test("expired lease can be acquired", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const svc = new ControllerLeaseService({ store, clock });

    await svc.acquire("ws-1", "ctrl-A", "user-1");
    // Advance past expiry (45s)
    clock.advance(LEASE_EXPIRY_MS + 1000);

    const lease = await svc.acquire("ws-1", "ctrl-B", "user-2");
    expect(lease.controllerId).toBe("ctrl-B");
    expect(lease.userId).toBe("user-2");
  });

  test("unexpired lease cannot be acquired", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock();
    const svc = new ControllerLeaseService({ store, clock });

    await svc.acquire("ws-1", "ctrl-A", "user-1");
    clock.advance(10_000); // still valid

    await expect(svc.acquire("ws-1", "ctrl-B", "user-2")).rejects.toBeInstanceOf(LeaseAlreadyHeldError);
  });

  test("at exact expiry boundary can be acquired", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const svc = new ControllerLeaseService({ store, clock });

    await svc.acquire("ws-1", "ctrl-A", "user-1");
    clock.advance(LEASE_EXPIRY_MS); // expiresAt == now -> treated as expired (<=)

    const lease = await svc.acquire("ws-1", "ctrl-B", "user-2");
    expect(lease.controllerId).toBe("ctrl-B");
  });
});

describe("controller-lease heartbeat", () => {
  test("heartbeat extends expiry for owner", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const svc = new ControllerLeaseService({ store, clock });

    const first = await svc.acquire("ws-1", "ctrl-A", "user-1");
    clock.advance(10_000);
    const hb = await svc.heartbeat("ws-1", "ctrl-A");
    expect(hb.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
    expect(hb.expiresAt.getTime()).toBe(clock.now().getTime() + LEASE_EXPIRY_MS);
  });

  test("heartbeat by non-owner is rejected", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock();
    const svc = new ControllerLeaseService({ store, clock });

    await svc.acquire("ws-1", "ctrl-A", "user-1");
    await expect(svc.heartbeat("ws-1", "ctrl-B")).rejects.toBeInstanceOf(NotLeaseOwnerError);
  });

  test("heartbeat on expired lease is rejected", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const svc = new ControllerLeaseService({ store, clock });

    await svc.acquire("ws-1", "ctrl-A", "user-1");
    clock.advance(LEASE_EXPIRY_MS + 1000);
    await expect(svc.heartbeat("ws-1", "ctrl-A")).rejects.toBeInstanceOf(LeaseExpiredError);
  });

  test("heartbeat with no lease is rejected", async () => {
    const store = new InMemoryLeaseStore();
    const svc = new ControllerLeaseService({ store, clock: new FakeClock() });
    await expect(svc.heartbeat("ws-1", "ctrl-A")).rejects.toBeInstanceOf(LeaseNotFoundError);
  });
});

describe("controller-lease release", () => {
  test("owner can release", async () => {
    const store = new InMemoryLeaseStore();
    const svc = new ControllerLeaseService({ store, clock: new FakeClock() });
    await svc.acquire("ws-1", "ctrl-A", "user-1");
    await svc.release("ws-1", "ctrl-A");
    expect(await svc.get("ws-1")).toBeNull();
  });

  test("non-owner cannot release", async () => {
    const store = new InMemoryLeaseStore();
    const svc = new ControllerLeaseService({ store, clock: new FakeClock() });
    await svc.acquire("ws-1", "ctrl-A", "user-1");
    await expect(svc.release("ws-1", "ctrl-B")).rejects.toBeInstanceOf(NotLeaseOwnerError);
  });

  test("release non-existent lease throws", async () => {
    const store = new InMemoryLeaseStore();
    const svc = new ControllerLeaseService({ store, clock: new FakeClock() });
    await expect(svc.release("ws-1", "ctrl-A")).rejects.toBeInstanceOf(LeaseNotFoundError);
  });
});

describe("controller-lease takeover", () => {
  test("takeover succeeds and fences old controller", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock();
    const svc = new ControllerLeaseService({ store, clock });

    await svc.acquire("ws-1", "ctrl-A", "user-1");
    const result = await svc.takeover("ws-1", "ctrl-B", "user-2");

    expect(result.lease.controllerId).toBe("ctrl-B");
    expect(result.lease.userId).toBe("user-2");
    expect(result.previousControllerId).toBe("ctrl-A");
    expect(result.previousUserId).toBe("user-1");

    // Old controller heartbeat should now be rejected
    await expect(svc.heartbeat("ws-1", "ctrl-A")).rejects.toBeInstanceOf(NotLeaseOwnerError);
    // New controller can heartbeat
    const hb = await svc.heartbeat("ws-1", "ctrl-B");
    expect(hb.controllerId).toBe("ctrl-B");
  });

  test("takeover with no prior lease", async () => {
    const store = new InMemoryLeaseStore();
    const svc = new ControllerLeaseService({ store, clock: new FakeClock() });

    const result = await svc.takeover("ws-1", "ctrl-B", "user-2");
    expect(result.previousControllerId).toBeNull();
    expect(result.previousUserId).toBeNull();
    expect(result.lease.controllerId).toBe("ctrl-B");
  });

  test("takeover atomically replaces even if lease active", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock();
    const svc = new ControllerLeaseService({ store, clock });

    await svc.acquire("ws-1", "ctrl-A", "user-1");
    clock.advance(5_000);
    // Takeover should succeed regardless of expiry
    const result = await svc.takeover("ws-1", "ctrl-C", "user-3");
    expect(result.previousControllerId).toBe("ctrl-A");
    expect((await svc.get("ws-1"))!.controllerId).toBe("ctrl-C");
  });
});

describe("controller-lease get", () => {
  test("get returns null when no lease", async () => {
    const store = new InMemoryLeaseStore();
    const svc = new ControllerLeaseService({ store, clock: new FakeClock() });
    expect(await svc.get("ws-1")).toBeNull();
  });

  test("get returns lease even if expired (caller can check)", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const svc = new ControllerLeaseService({ store, clock });
    await svc.acquire("ws-1", "ctrl-A", "user-1");
    clock.advance(LEASE_EXPIRY_MS + 1000);
    const lease = await svc.get("ws-1");
    expect(lease).not.toBeNull();
    expect(lease!.controllerId).toBe("ctrl-A");
  });

  test("getActive returns null when expired", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const svc = new ControllerLeaseService({ store, clock });
    await svc.acquire("ws-1", "ctrl-A", "user-1");
    clock.advance(LEASE_EXPIRY_MS + 1000);
    expect(await svc.getActive("ws-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CAS contract tests
// ---------------------------------------------------------------------------

/**
 * Simulates a real SQL store under READ COMMITTED: `transaction` does NOT
 * serialise (read-then-write inside `fn` races as lost updates), but the
 * conditional primitives are single atomic "statements".
 */
class NonSerialisingLeaseStore implements LeaseStore {
  private data = new Map<string, ControllerLeaseRecord>();

  async transaction<T>(fn: (tx: LeaseTransaction) => Promise<T>): Promise<T> {
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
    return fn(tx);
  }

  async upsertIfExpired(
    record: ControllerLeaseRecord,
    now: Date,
  ): Promise<ControllerLeaseRecord | null> {
    const existing = this.data.get(record.workspaceId);
    if (existing && existing.expiresAt > now) {
      return null;
    }
    this.data.set(record.workspaceId, { ...record });
    return { ...record };
  }

  async extendIfOwner(
    workspaceId: string,
    controllerId: string,
    extendTo: Date,
    now: Date,
  ): Promise<ControllerLeaseRecord | null> {
    const existing = this.data.get(workspaceId);
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
  }

  peek(workspaceId: string): ControllerLeaseRecord | null {
    const rec = this.data.get(workspaceId);
    return rec ? { ...rec } : null;
  }

  seed(record: ControllerLeaseRecord): void {
    this.data.set(record.workspaceId, { ...record });
  }
}

describe("controller-lease CAS atomicity", () => {
  test("concurrent acquires -> exactly one winner via the CAS path (no serialisable transaction)", async () => {
    const store = new NonSerialisingLeaseStore();
    const clock = new FakeClock();
    const svc = new ControllerLeaseService({ store, clock });

    const results = await Promise.allSettled([
      svc.acquire("ws-1", "ctrl-A", "user-1"),
      svc.acquire("ws-1", "ctrl-B", "user-2"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(LeaseAlreadyHeldError);
    expect((reason as Error).message).not.toContain("duplicate key");

    const winnerId = (
      fulfilled[0] as PromiseFulfilledResult<{ controllerId: string }>
    ).value.controllerId;
    expect(["ctrl-A", "ctrl-B"]).toContain(winnerId);
    expect(store.peek("ws-1")!.controllerId).toBe(winnerId);
  });

  test("heartbeat after takeover is rejected and does NOT resurrect the demoted controller", async () => {
    const store = new NonSerialisingLeaseStore();
    const clock = new FakeClock();
    const svc = new ControllerLeaseService({ store, clock });

    await svc.acquire("ws-1", "ctrl-A", "user-1");
    clock.advance(10_000);
    await svc.takeover("ws-1", "ctrl-B", "user-2");
    const afterTakeover = store.peek("ws-1")!;

    await expect(svc.heartbeat("ws-1", "ctrl-A")).rejects.toBeInstanceOf(
      NotLeaseOwnerError,
    );

    // The stale heartbeat must not have overwritten the committed takeover.
    expect(store.peek("ws-1")).toEqual(afterTakeover);
    expect(store.peek("ws-1")!.controllerId).toBe("ctrl-B");
  });

  test("insert conflict surfaces as LeaseAlreadyHeldError, not a raw driver error", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const svc = new ControllerLeaseService({ store, clock });

    // Seed an unexpired lease as if committed by another controller.
    const now = clock.now();
    store.seed({
      workspaceId: "ws-1",
      controllerId: "ctrl-A",
      userId: "user-1",
      expiresAt: new Date(now.getTime() + LEASE_EXPIRY_MS),
      updatedAt: now,
    });

    const err = await svc.acquire("ws-1", "ctrl-B", "user-2").catch((e) => e);
    expect(err).toBeInstanceOf(LeaseAlreadyHeldError);
    expect((err as LeaseAlreadyHeldError).holderControllerId).toBe("ctrl-A");
    expect((err as Error).message).not.toContain("duplicate key");
  });

  test("stale heartbeat cannot resurrect an expired lease taken over by another controller", async () => {
    const store = new InMemoryLeaseStore();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const svc = new ControllerLeaseService({ store, clock });

    await svc.acquire("ws-1", "ctrl-A", "user-1");
    clock.advance(LEASE_EXPIRY_MS + 1000);
    await svc.acquire("ws-1", "ctrl-B", "user-2");

    await expect(svc.heartbeat("ws-1", "ctrl-A")).rejects.toBeInstanceOf(
      NotLeaseOwnerError,
    );
    expect((await svc.get("ws-1"))!.controllerId).toBe("ctrl-B");
  });
});

describe("InMemoryLeaseStore CAS primitives", () => {
  const baseRecord = (at: Date, controllerId = "ctrl-A"): ControllerLeaseRecord => ({
    workspaceId: "ws-1",
    controllerId,
    userId: "user-1",
    expiresAt: new Date(at.getTime() + LEASE_EXPIRY_MS),
    updatedAt: at,
  });

  test("upsertIfExpired inserts when no row exists", async () => {
    const store = new InMemoryLeaseStore();
    const now = new Date("2026-01-01T00:00:00Z");
    const stored = await store.upsertIfExpired(baseRecord(now), now);
    expect(stored!.controllerId).toBe("ctrl-A");
    expect(store.peek("ws-1")!.controllerId).toBe("ctrl-A");
  });

  test("upsertIfExpired returns null (no write) when an unexpired lease is held", async () => {
    const store = new InMemoryLeaseStore();
    const now = new Date("2026-01-01T00:00:00Z");
    store.seed(baseRecord(now));
    const stored = await store.upsertIfExpired(baseRecord(now, "ctrl-B"), now);
    expect(stored).toBeNull();
    expect(store.peek("ws-1")!.controllerId).toBe("ctrl-A");
  });

  test("upsertIfExpired replaces an expired lease", async () => {
    const store = new InMemoryLeaseStore();
    const now = new Date("2026-01-01T00:00:00Z");
    store.seed(baseRecord(now));
    const later = new Date(now.getTime() + LEASE_EXPIRY_MS + 1000);
    const stored = await store.upsertIfExpired(baseRecord(later, "ctrl-B"), later);
    expect(stored!.controllerId).toBe("ctrl-B");
  });

  test("extendIfOwner extends for the unexpired owner", async () => {
    const store = new InMemoryLeaseStore();
    const now = new Date("2026-01-01T00:00:00Z");
    store.seed(baseRecord(now));
    const later = new Date(now.getTime() + 10_000);
    const updated = await store.extendIfOwner(
      "ws-1",
      "ctrl-A",
      new Date(later.getTime() + LEASE_EXPIRY_MS),
      later,
    );
    expect(updated!.expiresAt.getTime()).toBe(later.getTime() + LEASE_EXPIRY_MS);
  });

  test("extendIfOwner returns null without writing when not the owner, expired, or missing", async () => {
    const store = new InMemoryLeaseStore();
    const now = new Date("2026-01-01T00:00:00Z");

    expect(await store.extendIfOwner("ws-1", "ctrl-A", now, now)).toBeNull();

    store.seed(baseRecord(now));
    const later = new Date(now.getTime() + 10_000);
    expect(
      await store.extendIfOwner("ws-1", "ctrl-B", later, later),
    ).toBeNull();
    expect(store.peek("ws-1")!.controllerId).toBe("ctrl-A");

    const afterExpiry = new Date(now.getTime() + LEASE_EXPIRY_MS + 1000);
    expect(
      await store.extendIfOwner(
        "ws-1",
        "ctrl-A",
        new Date(afterExpiry.getTime() + LEASE_EXPIRY_MS),
        afterExpiry,
      ),
    ).toBeNull();
    expect(store.peek("ws-1")!.controllerId).toBe("ctrl-A");
  });
});
