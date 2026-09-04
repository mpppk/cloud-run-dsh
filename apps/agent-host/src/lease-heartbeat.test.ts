// Controller-lease renewal loop tests (review BLOCKER fix).
// The renewals are driven entirely by the INJECTED fake clock: advancing the
// clock fires the scheduled heartbeats through FakeIntervalScheduler, so the
// tests prove the lease survives several LEASE_EXPIRY_MS lifetimes without
// waiting on wall time.

import { describe, expect, test } from "bun:test";
import { HEARTBEAT_INTERVAL_MS, LEASE_EXPIRY_MS } from "@cloud-run-dsh/controller-lease";
import { composeTestHost, seedWorkspace } from "./fakes.js";

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost:8080${path}`, { method, headers });
}

const IAP = { "x-goog-authenticated-user-email": "user@example.com" };

/** Flushes the async heartbeat ticks scheduled by the last clock advance. */
async function flushTicks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("LeaseHeartbeatLoop (review BLOCKER fix)", () => {
  test("agent input still returns 202 several lease lifetimes past recover()", async () => {
    // Messages need a TurnStarter since #22 (otherwise the gateway
    // honestly answers 503 turn_not_implemented). The lease-renewal
    // assertion is what matters here, so a trivial starter is injected.
    const th = await composeTestHost({}, { turnStarter: { startTurn: async () => {} } });
    await seedWorkspace(th);
    await th.host.recover();
    expect(th.host.leaseHeartbeat.running).toBe(true);

    // Advance 4x the lease expiry (>2 lease lifetimes beyond the first
    // renewal window). Without the renewal loop getActive() would be null
    // after 45s and the gateway would 409 forever.
    for (let i = 0; i < Math.ceil((LEASE_EXPIRY_MS * 4) / HEARTBEAT_INTERVAL_MS); i++) {
      th.clock.advance(HEARTBEAT_INTERVAL_MS);
      await flushTicks();
    }

    expect(th.clock.nowMs() - 1_000_000_000_000).toBeGreaterThan(LEASE_EXPIRY_MS * 3);

    const lease = await th.host.lease.getActive("ws-1");
    expect(lease).not.toBeNull();
    expect(lease?.controllerId).toBe("ctrl-1");

    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP),
    );
    expect(res.status).toBe(202);
    expect(th.host.health.snapshot().status).toBe("READY");
  });

  test("a failed renewal surfaces on health (RESTORE_FAILED)", async () => {
    const th = await composeTestHost();
    await seedWorkspace(th);
    await th.host.recover();

    // A competing controller takes the lease over (we are demoted) before
    // the next renewal fires.
    await th.host.lease.takeover("ws-1", "ctrl-2", "user-1");
    th.clock.advance(HEARTBEAT_INTERVAL_MS);
    await flushTicks();

    // The failed renewal must surface — the host must NOT silently continue.
    expect(th.host.health.snapshot().status).toBe("RESTORE_FAILED");

    // Re-acquire keeps failing while ctrl-2 holds the lease; health stays failed.
    th.clock.advance(HEARTBEAT_INTERVAL_MS);
    await flushTicks();
    expect(th.host.health.snapshot().status).toBe("RESTORE_FAILED");
  });

  test("a regained lease restores health when the runtime is READY", async () => {
    const th = await composeTestHost();
    await seedWorkspace(th);
    await th.host.recover();

    await th.host.lease.takeover("ws-1", "ctrl-2", "user-1");
    th.clock.advance(HEARTBEAT_INTERVAL_MS);
    await flushTicks();
    expect(th.host.health.snapshot().status).toBe("RESTORE_FAILED");

    // The other holder releases; the loop's re-acquire succeeds on a later tick.
    await th.host.lease.release("ws-1", "ctrl-2");
    th.clock.advance(HEARTBEAT_INTERVAL_MS);
    await flushTicks();

    const lease = await th.host.lease.getActive("ws-1");
    expect(lease?.controllerId).toBe("ctrl-1");
    expect(th.host.health.snapshot().status).toBe("READY");
  });

  test("graceful stop stops the loop; a stopped host is not kept renewing", async () => {
    const th = await composeTestHost();
    await seedWorkspace(th);
    await th.host.recover();
    expect(th.host.leaseHeartbeat.running).toBe(true);

    await th.host.runtime.stop();
    expect(th.host.runtime.getState()).toBe("STOPPED");
    expect(th.host.leaseHeartbeat.running).toBe(false);

    // A forced tick after stop is a no-op (self-terminated via the STOPPED check).
    await th.host.leaseHeartbeat.tick();
    expect(th.host.leaseHeartbeat.running).toBe(false);

    // Advancing the clock past several lease lifetimes must not re-acquire
    // or otherwise resurrect anything: the lease simply expires, unheld.
    for (let i = 0; i < 4; i++) {
      th.clock.advance(LEASE_EXPIRY_MS);
      await flushTicks();
    }
    expect(th.host.leaseHeartbeat.running).toBe(false);
    expect(await th.host.lease.getActive("ws-1")).toBeNull();
  });

  test("failed recover() does not start the loop", async () => {
    const th = await composeTestHost();
    await expect(th.host.recover()).rejects.toThrow(/workspace not found/);
    expect(th.host.leaseHeartbeat.running).toBe(false);
    expect(th.host.health.snapshot().status).toBe("RESTORE_FAILED");
  });
});
