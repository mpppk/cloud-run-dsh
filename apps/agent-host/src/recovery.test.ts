import { describe, expect, test } from "bun:test";
import { LeaseAlreadyHeldError } from "@cloud-run-dsh/controller-lease";
import { InMemoryLogger } from "@cloud-run-dsh/observability";
import { InvalidOperationError } from "@cloud-run-dsh/workspace-runtime";
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
    // The in-memory store is exposed for transition assertions only when no
    // shared store was injected (always the case in this file).
    const states = th.inMemoryStateStore!;
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

    // Issue #60 案C: instance start/health observation is the control
    // plane's job — the host must never touch the instance lifecycle of the
    // instance it runs inside (no start, no health poll).
    expect(th.instance.calls).toEqual([]);

    // The host drove only its own phase on the shared row: the seed stands
    // in for the control plane's STOPPED -> STARTING, and recovery must
    // continue STARTING -> RESTORING -> READY (never re-run the open).
    const transitions = states.getHistory().map((r) => `${r.from}->${r.to}`);
    expect(transitions).toEqual([
      "STOPPED->STARTING",
      "STARTING->RESTORING",
      "RESTORING->READY",
    ]);

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
    // Issue #60: instance health is the control plane's job now — the host
    // fails in its OWN restore steps (here: git clone fails; the clone argv
    // leads with broker auth args, so match on the verb, not argv[0]).
    const originalRun = th.git.run.bind(th.git);
    th.git.run = async (args, opts) => {
      if (args.includes("clone")) throw new Error("git clone failed: connection refused");
      return originalRun(args, opts);
    };

    await expect(th.host.recover()).rejects.toThrow(/clone failed/);
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
    th.git.responses.set("rev-parse", {
      exitCode: 0,
      stdout: "2c6fe42d68f1638b2d4059f0fa8c9901df9effb8\n",
      stderr: "",
    });
    await th.host.recover();

    const state = await th.host.runtime.stop();
    expect(state).toBe("STOPPED");

    // Lifecycle checkpoint uploaded a bundle.
    expect(th.storage.keys()).toContain("workspaces/ws-1/checkpoint.bin");
    // Issue #95 案A: the same checkpoint appended one index row carrying
    // the manifest base commit and the GCS object key — the row the
    // production incident proved was never written before this fix.
    const generations = await th.repository.listCheckpoints("ws-1");
    expect(generations.length).toBe(1);
    expect(generations[0]!.baseCommitSha).toBe("2c6fe42d68f1638b2d4059f0fa8c9901df9effb8");
    expect(generations[0]!.gcsObject).toBe("workspaces/ws-1/checkpoint.bin");
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

describe("lease adoption on recovery (issue #60 案B)", () => {
  test("no active lease: the host acquires its injected CONTROLLER_ID", async () => {
    const th = await composeTestHost();
    await seedWorkspace(th);

    await th.host.recover();

    // First boot / post-expiry failover: nobody holds the row, so the host
    // takes it as self (its env identity, injected by the control plane).
    const lease = await th.host.lease.getActive("ws-1");
    expect(lease?.controllerId).toBe("ctrl-1");
    expect(lease?.userId).toBe("user-1");
    expect(th.host.runtime.getState()).toBe("READY");
  });

  test("active lease with the same id: the host heartbeats instead of re-acquiring", async () => {
    const th = await composeTestHost();
    await seedWorkspace(th);
    // The control-plane open established this lease before the instance boot.
    await th.host.lease.acquire("ws-1", "ctrl-1", "user-1");
    // Time passes between the open and the host boot.
    th.clock.advance(10_000);
    const before = (await th.host.lease.getActive("ws-1"))!.expiresAt.getTime();

    await th.host.recover();

    // Adopted, not replaced: same controller, expiry extended, restore done.
    const lease = await th.host.lease.getActive("ws-1");
    expect(lease?.controllerId).toBe("ctrl-1");
    expect(lease!.expiresAt.getTime()).toBeGreaterThan(before);
    expect(th.host.runtime.getState()).toBe("READY");
  });

  test("active lease with another id: the second host is refused (§26-8)", async () => {
    const first = await composeTestHost();
    await seedWorkspace(first);
    await first.host.recover();
    expect((await first.host.lease.getActive("ws-1"))?.controllerId).toBe("ctrl-1");

    // A second host generation (stale env, or a true duplicate) boots with a
    // different identity against the SAME lease row.
    const second = await composeTestHost(
      { controllerId: "ctrl-2" },
      { leaseStore: first.leaseStore },
    );

    await expect(second.host.recover()).rejects.toThrow(LeaseAlreadyHeldError);
    expect(second.host.health.snapshot().status).toBe("RESTORE_FAILED");
    expect(second.host.bootstrapper.isTokenDiscarded).toBe(true);
    // The winner's lease is untouched — the refused host never overwrote it.
    expect((await first.host.lease.getActive("ws-1"))?.controllerId).toBe("ctrl-1");
    // ... and the refused host never ran a single restore step.
    expect(second.host.runtime.getState()).toBe("STOPPED");
  });

  test("STOPPED workspace: recovery is refused — the control plane never started this generation", async () => {
    const th = await composeTestHost();
    // Workspace row exists but the control-plane phase never ran (no
    // seedWorkspace STARTING transition): a host process here is anomalous —
    // in production its instance would not exist.
    await th.repository.createWorkspace({
      id: "ws-1",
      ownerId: "user-1",
      repositoryOwner: "mpppk",
      repositoryName: "cloud-run-dsh",
      baseBranch: "main",
      instanceName: "dsh-ws-1",
    });

    await expect(th.host.recover()).rejects.toThrow(InvalidOperationError);
    expect(th.host.health.snapshot().status).toBe("RESTORE_FAILED");
  });
});
