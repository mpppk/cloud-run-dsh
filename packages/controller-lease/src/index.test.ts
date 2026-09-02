import { describe, test, expect } from "bun:test";
import {
  CONTROLLERS_PER_WORKSPACE,
  HEARTBEAT_INTERVAL_MS,
  LEASE_EXPIRY_MS,
  ControllerLeaseService,
  InMemoryLeaseStore,
  FakeClock,
  LeaseAlreadyHeldError,
  NotLeaseOwnerError,
  LeaseNotFoundError,
  LeaseExpiredError,
} from "./index.js";

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
