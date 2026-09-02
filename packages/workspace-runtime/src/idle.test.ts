import { describe, test, expect } from "bun:test";
import { IDLE_TIMEOUT_MS, IdleManager, isMeaningfulActivity, isNonMeaningfulActivity } from "./idle.js";
import type { ActivityKind } from "./idle.js";
import { SystemClock } from "@cloud-run-dsh/workspace-checkpoint";

/** Manually-advanced fake clock — tests use fakes only, no real timers. */
class FakeClock {
  private ms: number;
  constructor(startMs = 1_000_000) {
    this.ms = startMs;
  }
  nowMs(): number {
    return this.ms;
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

const MEANINGFUL: readonly ActivityKind[] = [
  "user_message",
  "approval",
  "agent_turn",
  "tool_invocation",
  "subprocess",
  "filesystem_mutation",
  "checkpoint",
  "workspace_operation",
];

const NON_MEANINGFUL: readonly ActivityKind[] = [
  "health_check",
  "sse_heartbeat",
  "browser_connection",
  "status_polling",
  "metrics_collection",
];

describe("IdleManager (仕様書 section 11, 実装手順書 section 28)", () => {
  test("IDLE_TIMEOUT_MS is the named 30 minute constant", () => {
    expect(IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  test("meaningful / non-meaningful classification covers all kinds", () => {
    const all = [...MEANINGFUL, ...NON_MEANINGFUL];
    expect(new Set(all).size).toBe(13);
    for (const kind of MEANINGFUL) {
      expect(isMeaningfulActivity(kind)).toBe(true);
      expect(isNonMeaningfulActivity(kind)).toBe(false);
    }
    for (const kind of NON_MEANINGFUL) {
      expect(isNonMeaningfulActivity(kind)).toBe(true);
      expect(isMeaningfulActivity(kind)).toBe(false);
    }
  });

  test("meaningful activities set and extend lastMeaningfulActivityAt", () => {
    for (const kind of MEANINGFUL) {
      const clock = new FakeClock();
      const idle = new IdleManager(clock);
      expect(idle.getLastMeaningfulActivityAt()).toBeNull();
      idle.recordActivity(kind);
      expect(idle.getLastMeaningfulActivityAt()).toEqual(clock.now());
      clock.advance(5 * 60 * 1000);
      idle.recordActivity(kind);
      const idleAfter = idle.getIdleMs();
      expect(idleAfter).not.toBeNull();
      expect(idleAfter! < 5 * 60 * 1000).toBe(true); // timer restarted
    }
  });

  // Explicit per-kind tests: each non-meaningful kind must NOT extend the timer
  describe("non-meaningful activities do not extend the idle timer", () => {
    for (const kind of NON_MEANINGFUL) {
      test(`${kind} is ignored`, () => {
        const clock = new FakeClock();
        const idle = new IdleManager(clock);
        idle.recordActivity("user_message");
        const before = idle.getLastMeaningfulActivityAt();
        clock.advance(10 * 60 * 1000);
        idle.recordActivity(kind);
        expect(idle.getLastMeaningfulActivityAt()).toEqual(before);
        clock.advance(20 * 60 * 1000);
        // 30 minutes elapsed since the only meaningful activity -> stop proposed
        expect(idle.shouldStop()).toBe(true);
      });

      test(`${kind} alone never starts the idle timer`, () => {
        const clock = new FakeClock();
        const idle = new IdleManager(clock);
        idle.recordActivity(kind);
        clock.advance(24 * 60 * 60 * 1000);
        expect(idle.getLastMeaningfulActivityAt()).toBeNull();
        expect(idle.getIdleMs()).toBeNull();
        expect(idle.shouldStop()).toBe(false);
      });
    }
  });

  describe("stop condition (実装手順書 section 28)", () => {
    function idleAfterTimeout(): { clock: FakeClock; idle: IdleManager } {
      const clock = new FakeClock();
      const idle = new IdleManager(clock);
      idle.recordActivity("user_message");
      clock.advance(IDLE_TIMEOUT_MS);
      return { clock, idle };
    }

    test("proposes stop when 30 min elapsed and nothing is running", () => {
      const { idle } = idleAfterTimeout();
      expect(idle.shouldStop()).toBe(true);
    });

    test("does not propose stop before 30 minutes", () => {
      const clock = new FakeClock();
      const idle = new IdleManager(clock);
      idle.recordActivity("user_message");
      clock.advance(IDLE_TIMEOUT_MS - 1);
      expect(idle.shouldStop()).toBe(false);
    });

    test("agent running blocks the stop", () => {
      const { idle } = idleAfterTimeout();
      idle.setAgentRunning(true);
      expect(idle.shouldStop()).toBe(false);
      idle.setAgentRunning(false);
      expect(idle.shouldStop()).toBe(true);
    });

    test("subprocess running blocks the stop", () => {
      const { idle } = idleAfterTimeout();
      idle.setSubprocessRunning(true);
      expect(idle.shouldStop()).toBe(false);
      idle.setSubprocessRunning(false);
      expect(idle.shouldStop()).toBe(true);
    });

    test("checkpoint running blocks the stop", () => {
      const { idle } = idleAfterTimeout();
      idle.setCheckpointRunning(true);
      expect(idle.shouldStop()).toBe(false);
      idle.setCheckpointRunning(false);
      expect(idle.shouldStop()).toBe(true);
    });

    test("never stops when no activity was ever recorded", () => {
      const idle = new IdleManager(new FakeClock());
      expect(idle.shouldStop()).toBe(false);
    });

    test("a meaningful activity inside the timeout window prevents the stop", () => {
      const clock = new FakeClock();
      const idle = new IdleManager(clock);
      idle.recordActivity("user_message");
      clock.advance(29 * 60 * 1000);
      idle.recordActivity("tool_invocation");
      clock.advance(29 * 60 * 1000);
      expect(idle.shouldStop()).toBe(false); // only 29 min since last activity
      clock.advance(60 * 1000);
      expect(idle.shouldStop()).toBe(true);
    });

    test("non-meaningful activity inside the window does NOT prevent the stop", () => {
      const clock = new FakeClock();
      const idle = new IdleManager(clock);
      idle.recordActivity("user_message");
      clock.advance(29 * 60 * 1000);
      idle.recordActivity("sse_heartbeat");
      idle.recordActivity("health_check");
      idle.recordActivity("status_polling");
      clock.advance(60 * 1000);
      expect(idle.shouldStop()).toBe(true);
    });

    test("browser connection alone does not keep the instance alive (仕様書 section 11)", () => {
      const clock = new FakeClock();
      const idle = new IdleManager(clock);
      idle.recordActivity("workspace_operation");
      clock.advance(60 * 1000);
      // browser opens and keeps a connection alive with no meaningful activity
      for (let i = 0; i < 40; i++) {
        idle.recordActivity("browser_connection");
        clock.advance(60 * 1000);
      }
      expect(idle.shouldStop()).toBe(true);
    });
  });

  test("works with the real SystemClock as injected clock", () => {
    const idle = new IdleManager(new SystemClock());
    idle.recordActivity("user_message");
    expect(idle.shouldStop()).toBe(false);
    expect(idle.getIdleMs()).not.toBeNull();
    expect(idle.getIdleMs()! < IDLE_TIMEOUT_MS).toBe(true);
  });
});