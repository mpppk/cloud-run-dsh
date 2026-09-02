import { describe, expect, test } from "bun:test";
import { IDLE_TIMEOUT_MS, IdleManager } from "@cloud-run-dsh/workspace-runtime";
import { HealthService, healthzResponse } from "./health.js";
import { FakeClock } from "./fakes.js";

describe("HealthService", () => {
  test("starts RESTORING and becomes READY only after restore", () => {
    const health = new HealthService("ws-1");
    expect(health.isReady()).toBe(false);
    expect(health.snapshot().status).toBe("RESTORING");
    health.setReady();
    expect(health.isReady()).toBe(true);
    expect(health.snapshot()).toEqual({ status: "READY", workspaceId: "ws-1" });
  });

  test("healthz response is 200 only for READY", () => {
    const health = new HealthService("ws-1");
    expect(healthzResponse(health.snapshot()).status).toBe(503);
    health.setReady();
    expect(healthzResponse(health.snapshot()).status).toBe(200);
    health.setRestoreFailed();
    expect(healthzResponse(health.snapshot()).status).toBe(503);
  });
});

describe("health checks are not meaningful activity (仕様書 section 11)", () => {
  test("health_check activity never resets the idle timer", () => {
    const clock = new FakeClock();
    const idle = new IdleManager(clock);
    idle.recordActivity("workspace_operation");
    clock.advance(IDLE_TIMEOUT_MS + 1);
    // Non-meaningful kinds — including health_check — must not reset the timer.
    idle.recordActivity("health_check");
    idle.recordActivity("sse_heartbeat");
    idle.recordActivity("status_polling");
    idle.recordActivity("metrics_collection");
    expect(idle.shouldStop()).toBe(true);
  });

  test("meaningful activity resets the idle timer", () => {
    const clock = new FakeClock();
    const idle = new IdleManager(clock);
    idle.recordActivity("workspace_operation");
    clock.advance(IDLE_TIMEOUT_MS + 1);
    idle.recordActivity("user_message");
    expect(idle.shouldStop()).toBe(false);
  });
});
