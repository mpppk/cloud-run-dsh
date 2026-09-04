import { describe, expect, test } from "bun:test";
import { LeaseAlreadyHeldError } from "@cloud-run-dsh/controller-lease";
import { InMemoryLogger } from "@cloud-run-dsh/observability";
import { composeTestHost, seedWorkspace } from "./fakes.js";
import type { AgentTurnInput, TurnStarter } from "./gateway.js";

/** Recording resumer fake: stands in for HarnessTurnStarter.resumeSessions. */
class RecordingResumer implements TurnStarter {
  resumedBatches: string[][] = [];
  failWith: Error | null = null;
  async startTurn(_input: AgentTurnInput): Promise<void> {}
  async resumeSessions(sessionIds: readonly string[]): Promise<{ resumed: string[] }> {
    this.resumedBatches.push([...sessionIds]);
    if (this.failWith) throw this.failWith;
    return { resumed: [...sessionIds] };
  }
}

describe("RestartRecovery (実装手順書 section 30)", () => {
  test("happy path: metadata -> restore -> session -> sandbox -> READY", async () => {
    const th = await composeTestHost();
    await seedWorkspace(th);
    const sessionId = "sess-1";
    await th.repository.createSession({ id: sessionId, workspaceId: "ws-1" });
    await th.repository.append(sessionId, [
      { eventType: "user_message", eventTime: th.clock.nowMs(), data: { text: "hello" } },
    ]);

    const result = await th.host.recover();

    expect(result.state).toBe("READY");
    expect(th.host.health.snapshot().status).toBe("READY");

    // State machine is READY.
    expect(th.host.runtime.getState()).toBe("READY");

    // Instance health checked.
    expect(th.instance.calls.some((c) => c.startsWith("get:dsh-ws-1"))).toBe(true);

    // Sandbox created for the workspace.
    const runArgv = th.sandboxRunner.recorded.find((argv) => argv[1] === "run");
    expect(runArgv).toBeDefined();
    expect(runArgv).toContain("dsh-ws-1");

    // Session metadata restored into the harness.
    expect(th.host.harness.restoredSessions().map((s) => s.id)).toEqual([sessionId]);

    // Controller lease held by this host.
    const lease = await th.host.lease.getActive("ws-1");
    expect(lease?.controllerId).toBe("ctrl-1");

    // GitHub token discarded after successful bootstrap.
    expect(th.host.bootstrapper.isTokenDiscarded).toBe(true);
  });

  test("refuses recovery when the workspace is unknown", async () => {
    const th = await composeTestHost();
    expect(th.host.recover()).rejects.toThrow(/workspace not found/);
    expect(th.host.health.snapshot().status).toBe("RESTORE_FAILED");
  });

  test("refuses a second controller acquiring the same workspace", async () => {
    const th = await composeTestHost({ controllerId: "ctrl-1" });
    await seedWorkspace(th);
    await expect(
      th.host.lease.acquire("ws-1", "ctrl-1", "user-1").then(() =>
        th.host.lease.acquire("ws-1", "ctrl-2", "user-1"),
      ),
    ).rejects.toThrow(LeaseAlreadyHeldError);
  });

  test("restore failure -> RESTORE_FAILED, health failed, token discarded", async () => {
    const th = await composeTestHost();
    await seedWorkspace(th);
    th.instance.state = "NOT_READY";

    await expect(th.host.recover()).rejects.toThrow(/not healthy/);
    expect(th.host.health.snapshot().status).toBe("RESTORE_FAILED");
    expect(th.host.bootstrapper.isTokenDiscarded).toBe(true);
    expect(th.host.runtime.getState()).toBe("RESTORE_FAILED");
  });

  test("health reports READY only after restore succeeds", async () => {
    const th = await composeTestHost();
    await seedWorkspace(th);
    expect(th.host.health.snapshot().status).toBe("RESTORING");
    await th.host.recover();
    expect(th.host.health.snapshot().status).toBe("READY");
  });

  test("graceful stop runs the lifecycle checkpoint and deletes the sandbox", async () => {    const th = await composeTestHost();
    await seedWorkspace(th);
    // Make the workspace dirty so the lifecycle checkpoint actually runs.
    th.git.responses.set("status", { exitCode: 0, stdout: "?? dirty.txt\0", stderr: "" });
    await th.host.recover();

    const state = await th.host.runtime.stop();
    expect(state).toBe("STOPPED");

    // Lifecycle checkpoint uploaded a bundle.
    expect(th.storage.keys()).toContain("workspaces/ws-1/checkpoint.bin");
    // Sandbox deleted.
    const deleteArgv = th.sandboxRunner.recorded.find((argv) => argv[1] === "delete");
    expect(deleteArgv).toBeDefined();
    // Instance stopped.
    expect(th.instance.calls).toContain("stop:dsh-ws-1");
  });
});

describe("agent resume on recovery (issue #39)", () => {
  test("persisted sessions are resumed once with their ids; the path is logged", async () => {
    const logger = new InMemoryLogger();
    const resumer = new RecordingResumer();
    const th = await composeTestHost({}, { turnStarter: resumer, logger });
    await seedWorkspace(th);
    await th.repository.createSession({ id: "sess-1", workspaceId: "ws-1" });
    await th.repository.createSession({ id: "sess-2", workspaceId: "ws-1" });
    await th.repository.append("sess-1", [
      { eventType: "user_message", eventTime: th.clock.nowMs(), data: { text: "hello" } },
    ]);

    await th.host.recover();

    expect(resumer.resumedBatches).toEqual([["sess-1", "sess-2"]]);
    expect(
      logger.parsed.some(
        (e) =>
          e["event"] === "turn.resume.completed" &&
          JSON.stringify(e["resumed"]) === JSON.stringify(["sess-1", "sess-2"]),
      ),
    ).toBe(true);
  });

  test("no sessions: nothing resumed, the empty path is logged", async () => {
    const logger = new InMemoryLogger();
    const resumer = new RecordingResumer();
    const th = await composeTestHost({}, { turnStarter: resumer, logger });
    await seedWorkspace(th);

    await th.host.recover();

    expect(resumer.resumedBatches).toEqual([]);
    expect(logger.parsed.some((e) => e["event"] === "turn.resume.empty")).toBe(true);
  });

  test("starter without resumeSessions: recovery still succeeds, skip is logged", async () => {
    const logger = new InMemoryLogger();
    const messageOnly: TurnStarter = {
      async startTurn(): Promise<void> {},
    };
    const th = await composeTestHost({}, { turnStarter: messageOnly, logger });
    await seedWorkspace(th);
    await th.repository.createSession({ id: "sess-1", workspaceId: "ws-1" });

    await th.host.recover();

    expect(th.host.health.snapshot().status).toBe("READY");
    expect(logger.parsed.some((e) => e["event"] === "turn.resume.skipped_no_starter")).toBe(true);
  });

  test("resume failure surfaces: recovery rejects, no silent fresh start", async () => {
    const resumer = new RecordingResumer();
    resumer.failWith = new Error("persisted log is corrupt");
    const th = await composeTestHost({}, { turnStarter: resumer });
    await seedWorkspace(th);
    await th.repository.createSession({ id: "sess-1", workspaceId: "ws-1" });

    await expect(th.host.recover()).rejects.toThrow(/corrupt/);
    expect(th.host.health.snapshot().status).toBe("RESTORE_FAILED");
    // The failure went through the resume path exactly once — no fallback
    // create was attempted behind it.
    expect(resumer.resumedBatches).toEqual([["sess-1"]]);
  });
});
