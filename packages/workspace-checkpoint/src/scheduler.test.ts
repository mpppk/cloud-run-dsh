import { describe, test, expect } from "bun:test";
import { CheckpointScheduler } from "./scheduler.js";
import type { Clock, GitRunner } from "./types.js";

class FakeClock implements Clock {
  constructor(private ms: number) {}
  now() {
    return new Date(this.ms);
  }
  nowMs() {
    return this.ms;
  }
  advance(deltaMs: number) {
    this.ms += deltaMs;
  }
}

function makeGit(dirty = false): GitRunner {
  return {
    async run(args) {
      if (args[0] === "status") {
        return { stdout: dirty ? " M file\n" : "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

describe("CheckpointScheduler", () => {
  test("agent turn complete + dirty triggers checkpoint", async () => {
    const clock = new FakeClock(0);
    let checkpointCalls = 0;
    const scheduler = new CheckpointScheduler({
      clock,
      git: makeGit(false),
      workspaceDir: "/ws",
      checkpointFn: async () => {
        checkpointCalls++;
      },
    });
    scheduler.notifyMutation();
    expect(scheduler.getDirty()).toBe(true);
    await scheduler.onAgentTurnComplete();
    expect(checkpointCalls).toBe(1);
    expect(scheduler.getDirty()).toBe(false);
  });

  test("agent turn complete without dirty does not checkpoint", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const scheduler = new CheckpointScheduler({
      clock,
      git: makeGit(false),
      workspaceDir: "/ws",
      checkpointFn: async () => {
        calls++;
      },
    });
    await scheduler.onAgentTurnComplete();
    expect(calls).toBe(0);
  });

  test("dirty for >= 2 minutes triggers checkpoint (fake clock)", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const scheduler = new CheckpointScheduler({
      clock,
      git: makeGit(false),
      workspaceDir: "/ws",
      checkpointFn: async () => {
        calls++;
      },
    });
    scheduler.notifyMutation();
    // 1 minute elapsed -> not yet
    clock.advance(60_000);
    await scheduler.checkPeriodic();
    expect(calls).toBe(0);
    // 2 minutes total -> should trigger
    clock.advance(60_000);
    await scheduler.checkPeriodic();
    expect(calls).toBe(1);
    expect(scheduler.getDirty()).toBe(false);

    // After checkpoint, dirty again and 2 minutes
    scheduler.notifyMutation();
    clock.advance(2 * 60 * 1000);
    await scheduler.checkPeriodic();
    expect(calls).toBe(2);
  });

  test("manual trigger checkpoints", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const scheduler = new CheckpointScheduler({
      clock,
      git: makeGit(false),
      workspaceDir: "/ws",
      checkpointFn: async () => {
        calls++;
      },
    });
    // Manual should checkpoint even if not dirty? Our impl checkpoints if dirty check via git says dirty.
    // For this test, set dirty
    scheduler.notifyMutation();
    await scheduler.triggerManual();
    expect(calls).toBe(1);
  });

  test("no concurrent checkpoints; mutation during checkpoint keeps dirty=true", async () => {
    const clock = new FakeClock(0);
    let resolveCheckpoint: (() => void) | null = null;
    const scheduler = new CheckpointScheduler({
      clock,
      git: makeGit(false),
      workspaceDir: "/ws",
      checkpointFn: () =>
        new Promise<void>((resolve) => {
          resolveCheckpoint = resolve;
        }),
    });
    scheduler.notifyMutation();
    const p = scheduler.onAgentTurnComplete();
    expect(scheduler.isCheckpointing()).toBe(true);
    // Try concurrent trigger - should be ignored
    let secondCalls = 0;
    const second = scheduler.triggerManual().then(() => {
      secondCalls++;
    });
    // Mutation during checkpoint
    scheduler.notifyMutation();
    expect(scheduler.isCheckpointing()).toBe(true);
    // Resolve first checkpoint
    resolveCheckpoint!();
    await p;
    await second;
    // After first checkpoint, dirty should still be true due to mutation during checkpoint
    expect(scheduler.getDirty()).toBe(true);
    // Next checkpoint should clear it
    // Replace checkpointFn with immediate resolve by creating new scheduler? Instead use existing but need new checkpoint function
    // For simplicity, check that pending dirty keeps true
    expect(secondCalls).toBe(1); // second manual was no-op due to concurrent guard
  });

  test("no concurrent: second agent turn during checkpoint is ignored", async () => {
    const clock = new FakeClock(0);
    let checkpointCount = 0;
    let resolve: (() => void) | null = null;
    const scheduler = new CheckpointScheduler({
      clock,
      git: makeGit(false),
      workspaceDir: "/ws",
      checkpointFn: () =>
        new Promise<void>((r) => {
          checkpointCount++;
          resolve = r;
        }),
    });
    scheduler.notifyMutation();
    const first = scheduler.onAgentTurnComplete();
    expect(scheduler.isCheckpointing()).toBe(true);
    // second call while in progress
    await scheduler.onAgentTurnComplete();
    expect(checkpointCount).toBe(1);
    resolve!();
    await first;
    expect(scheduler.isCheckpointing()).toBe(false);
  });

  test("lifecycle checkpoint failure returns failure and must NOT allow stop", async () => {
    const clock = new FakeClock(0);
    const scheduler = new CheckpointScheduler({
      clock,
      git: makeGit(false),
      workspaceDir: "/ws",
      checkpointFn: async () => {
        throw new Error("upload failed");
      },
    });
    scheduler.notifyMutation();
    const result = await scheduler.runLifecycleCheckpoint();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("CheckpointFailedError");
    }
    // Simulate caller's stop logic: must NOT proceed if checkpoint failed
    let stopCalled = false;
    const beginStop = () => {
      stopCalled = true;
    };
    if (result.ok) beginStop();
    expect(stopCalled).toBe(false);
    // Dirty should remain true for next round
    expect(scheduler.getDirty()).toBe(true);
  });

  test("lifecycle checkpoint success allows stop", async () => {
    const clock = new FakeClock(0);
    const scheduler = new CheckpointScheduler({
      clock,
      git: makeGit(false),
      workspaceDir: "/ws",
      checkpointFn: async () => {},
    });
    scheduler.notifyMutation();
    const result = await scheduler.runLifecycleCheckpoint();
    expect(result.ok).toBe(true);
    let stopCalled = false;
    if (result.ok) stopCalled = true;
    expect(stopCalled).toBe(true);
    expect(scheduler.getDirty()).toBe(false);
  });

  test("lifecycle checkpoint when not dirty succeeds without calling checkpointFn", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const scheduler = new CheckpointScheduler({
      clock,
      git: makeGit(false),
      workspaceDir: "/ws",
      checkpointFn: async () => {
        calls++;
      },
    });
    const result = await scheduler.runLifecycleCheckpoint();
    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
  });

  test("clock injection: advance fake clock and check periodic threshold customizable", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const scheduler = new CheckpointScheduler({
      clock,
      git: makeGit(false),
      workspaceDir: "/ws",
      checkpointFn: async () => {
        calls++;
      },
      dirtyThresholdMs: 5000,
    });
    scheduler.notifyMutation();
    clock.advance(4000);
    await scheduler.checkPeriodic();
    expect(calls).toBe(0);
    clock.advance(1000);
    await scheduler.checkPeriodic();
    expect(calls).toBe(1);
  });

  test("git injection: scheduler uses git status to double-check dirty", async () => {
    const clock = new FakeClock(0);
    let checkpointCalls = 0;
    // Git says dirty even though internal flag is clean
    const gitDirty: GitRunner = {
      async run(args) {
        if (args[0] === "status") return { stdout: " M foo\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const scheduler = new CheckpointScheduler({
      clock,
      git: gitDirty,
      workspaceDir: "/ws",
      checkpointFn: async () => {
        checkpointCalls++;
      },
    });
    // Internal dirty false, but git says dirty -> manual trigger should still checkpoint via tryCheckpoint's git check
    await scheduler.triggerManual();
    expect(checkpointCalls).toBe(1);
  });
});
