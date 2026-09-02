import { describe, test, expect } from "bun:test";
import type { WorkspaceLifecycleSteps } from "./runtime.js";
import { WorkspaceRuntime, AgentInputRefusedError, InvalidOperationError } from "./runtime.js";
import { InMemoryTransactionalStore } from "./store.js";
import { IdleManager } from "./idle.js";
import type { InstanceRuntime, InstanceInfo, Workspace as InstanceWorkspace } from "@cloud-run-dsh/cloud-run-instance-client";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve as (v?: T) => void, reject };
}

class FakeClock {
  private ms = 1_000_000;
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

class FakeInstanceRuntime implements InstanceRuntime {
  calls: string[] = [];
  failStart = false;
  failStop = false;

  async create(_workspace: InstanceWorkspace): Promise<InstanceInfo> {
    this.calls.push("create");
    return { name: "dsh-ws-1", state: "READY" };
  }
  async start(_instanceName: string): Promise<void> {
    this.calls.push("start");
    if (this.failStart) throw new Error("instance start failed");
  }
  async stop(instanceName: string): Promise<void> {
    this.calls.push(`stop:${instanceName}`);
    if (this.failStop) throw new Error("instance stop failed");
  }
  async get(_instanceName: string): Promise<InstanceInfo> {
    return { name: "dsh-ws-1", state: "RUNNING" };
  }
  async delete(_instanceName: string): Promise<void> {
    this.calls.push("delete");
  }
}

class FakeSteps implements WorkspaceLifecycleSteps {
  calls: string[] = [];
  failures = new Map<string, () => Error>();
  gates = new Map<string, ReturnType<typeof deferred<void>>>();

  private async run(name: string): Promise<void> {
    this.calls.push(name);
    const gate = this.gates.get(name);
    if (gate) await gate.promise;
    const failure = this.failures.get(name);
    if (failure) throw failure();
  }

  waitForInstanceHealth(): Promise<void> {
    return this.run("waitForInstanceHealth");
  }
  cloneRepository(): Promise<void> {
    return this.run("cloneRepository");
  }
  checkoutBase(): Promise<void> {
    return this.run("checkoutBase");
  }
  restoreCheckpoint(): Promise<void> {
    return this.run("restoreCheckpoint");
  }
  createSandbox(): Promise<void> {
    return this.run("createSandbox");
  }
  restoreHarness(): Promise<void> {
    return this.run("restoreHarness");
  }
  runLifecycleCheckpoint(): Promise<void> {
    return this.run("runLifecycleCheckpoint");
  }
  flushSessionPersistence(): Promise<void> {
    return this.run("flushSessionPersistence");
  }
  deleteSandbox(): Promise<void> {
    return this.run("deleteSandbox");
  }
}

interface Harness {
  clock: FakeClock;
  store: InMemoryTransactionalStore;
  instance: FakeInstanceRuntime;
  steps: FakeSteps;
  idle: IdleManager;
  runtime: WorkspaceRuntime;
}

function makeHarness(): Harness {
  const clock = new FakeClock();
  const store = new InMemoryTransactionalStore();
  const instance = new FakeInstanceRuntime();
  const steps = new FakeSteps();
  const idle = new IdleManager(clock);
  const runtime = new WorkspaceRuntime({
    workspaceId: "ws-1",
    store,
    clock,
    instanceRuntime: instance,
    instanceName: "dsh-ws-1",
    steps,
    idle,
  });
  return { clock, store, instance, steps, idle, runtime };
}

describe("WorkspaceRuntime — restore orchestration (仕様書 section 8, 実装手順書 19/22/27/30)", () => {
  test("open walks STARTING -> RESTORING -> READY in the spec order", async () => {
    const h = makeHarness();
    const state = await h.runtime.open();
    expect(state).toBe("READY");
    expect(h.instance.calls).toEqual(["start"]);
    expect(h.steps.calls).toEqual([
      "waitForInstanceHealth",
      "cloneRepository",
      "checkoutBase",
      "restoreCheckpoint",
      "createSandbox",
      "restoreHarness",
    ]);
    // every transition was persisted through the transactional store
    expect(h.store.getHistory().map((r) => `${r.from}->${r.to}`)).toEqual([
      "STOPPED->STARTING",
      "STARTING->RESTORING",
      "RESTORING->READY",
    ]);
  });

  test("instance start failure goes to RESTORE_FAILED (実装手順書 section 27 path)", async () => {
    const h = makeHarness();
    h.instance.failStart = true;
    await expect(h.runtime.open()).rejects.toThrow("instance start failed");
    expect(h.runtime.getState()).toBe("RESTORE_FAILED");
    expect(h.instance.calls).toEqual(["start"]);
    expect(h.instance.calls.includes("stop:dsh-ws-1")).toBe(false);
  });

  test("restore failure goes to RESTORE_FAILED and agent input is refused (仕様書 section 8)", async () => {
    const h = makeHarness();
    h.steps.failures.set("restoreCheckpoint", () => new Error("checkpoint download failed"));
    await expect(h.runtime.open()).rejects.toThrow("checkpoint download failed");
    expect(h.runtime.getState()).toBe("RESTORE_FAILED");
    expect(h.steps.calls).toEqual([
      "waitForInstanceHealth",
      "cloneRepository",
      "checkoutBase",
      "restoreCheckpoint",
    ]);
    expect(() => h.runtime.assertAgentInputAllowed()).toThrow(AgentInputRefusedError);
    await expect(h.runtime.beginAgentTurn()).rejects.toThrow(AgentInputRefusedError);
  });

  test("agent input is refused while restoring (mid-open)", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    h.steps.gates.set("restoreCheckpoint", gate as unknown as ReturnType<typeof deferred<void>>);
    const openPromise = h.runtime.open();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.runtime.getState()).toBe("RESTORING");
    await expect(h.runtime.beginAgentTurn()).rejects.toThrow(AgentInputRefusedError);
    gate.resolve();
    await openPromise;
    expect(h.runtime.getState()).toBe("READY");
    await h.runtime.beginAgentTurn(); // now allowed
    expect(h.runtime.getState()).toBe("BUSY");
    await h.runtime.endAgentTurn();
    expect(h.runtime.getState()).toBe("READY");
  });

  test("open is invalid from states that are not openable", async () => {
    const h = makeHarness();
    await h.store.apply("ws-1", "STOPPED", "STARTING", "open");
    await h.runtime.reloadState();
    await expect(h.runtime.open()).rejects.toThrow(InvalidOperationError);
  });

  test("re-open after RESTORE_FAILED retries the whole sequence", async () => {
    const h = makeHarness();
    h.steps.failures.set("cloneRepository", () => new Error("clone failed"));
    await expect(h.runtime.open()).rejects.toThrow("clone failed");
    expect(h.runtime.getState()).toBe("RESTORE_FAILED");
    h.steps.failures.clear();
    const state = await h.runtime.open();
    expect(state).toBe("READY");
    expect(h.store.getHistory().map((r) => r.to)).toEqual([
      "STARTING",
      "RESTORING",
      "RESTORE_FAILED",
      "STARTING",
      "RESTORING",
      "READY",
    ]);
  });
});

describe("WorkspaceRuntime — concurrent open coalescing (実装手順書 section 27)", () => {
  test("two concurrent opens coalesce into a single start operation", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    h.steps.gates.set("restoreCheckpoint", gate as unknown as ReturnType<typeof deferred<void>>);

    const openPromise = Promise.all([h.runtime.open(), h.runtime.open()]);
    gate.resolve();
    const [a, b] = await openPromise;

    expect(a).toBe("READY");
    expect(b).toBe("READY");
    expect(h.instance.calls.filter((c) => c === "start")).toHaveLength(1);
    expect(h.steps.calls.filter((c) => c === "restoreCheckpoint")).toHaveLength(1);
    expect(h.steps.calls.filter((c) => c === "cloneRepository")).toHaveLength(1);
    expect(h.store.getHistory()).toHaveLength(3); // STARTING, RESTORING, READY
  });

  test("open after READY is idempotent and does not restart the instance", async () => {
    const h = makeHarness();
    await h.runtime.open();
    const state = await h.runtime.open();
    expect(state).toBe("READY");
    expect(h.instance.calls.filter((c) => c === "start")).toHaveLength(1);
    expect(h.steps.calls).toHaveLength(6);
  });

  test("the second caller joins the in-flight open even after the first fails", async () => {
    const h = makeHarness();
    h.steps.failures.set("createSandbox", () => new Error("sandbox create failed"));
    const [a, b] = await Promise.allSettled([h.runtime.open(), h.runtime.open()]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(h.runtime.getState()).toBe("RESTORE_FAILED");
    expect(h.instance.calls.filter((c) => c === "start")).toHaveLength(1);
  });
});

describe("WorkspaceRuntime — graceful stop (実装手順書 section 29)", () => {
  test("stop walks the full sequence and lands in STOPPED", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.instance.calls = [];
    h.steps.calls = [];
    h.store.clearHistory();
    const state = await h.runtime.stop();
    expect(state).toBe("STOPPED");
    expect(h.steps.calls).toEqual([
      "runLifecycleCheckpoint",
      "flushSessionPersistence",
      "deleteSandbox",
    ]);
    expect(h.instance.calls).toEqual(["stop:dsh-ws-1"]);
    expect(h.store.getHistory().map((r) => `${r.from}->${r.to}`)).toEqual([
      "READY->STOPPING",
      "STOPPING->STOPPED",
    ]);
  });

  test("stop from BUSY drains the in-flight agent turn before checkpointing", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.instance.calls = [];
    h.steps.calls = [];
    h.store.clearHistory();
    await h.runtime.beginAgentTurn();

    const stopPromise = h.runtime.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.runtime.getState()).toBe("STOPPING");
    // the lifecycle checkpoint must NOT run while the turn is in flight
    expect(h.steps.calls).not.toContain("runLifecycleCheckpoint");

    // the in-flight turn completes cleanly during STOPPING
    await h.runtime.endAgentTurn();
    const state = await stopPromise;

    expect(state).toBe("STOPPED");
    expect(h.runtime.pendingOperationCount()).toBe(0);
    expect(h.steps.calls).toContain("runLifecycleCheckpoint");
    expect(h.instance.calls).toEqual(["stop:dsh-ws-1"]);
    expect(h.idle.isAgentRunning()).toBe(false);
    expect(h.store.getHistory().map((r) => `${r.from}->${r.to}`)).toEqual([
      "READY->BUSY",
      "BUSY->STOPPING",
      "STOPPING->STOPPED",
    ]);
  });

  test("new operations started during STOPPING are refused", async () => {
    const h = makeHarness();
    await h.runtime.open();
    await h.runtime.beginAgentTurn();
    const stopPromise = h.runtime.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.runtime.getState()).toBe("STOPPING");

    await expect(h.runtime.beginAgentTurn()).rejects.toThrow(AgentInputRefusedError);
    await expect(h.runtime.runSubprocess(async () => "x")).rejects.toThrow(AgentInputRefusedError);
    await expect(h.runtime.runToolInvocation(async () => "x")).rejects.toThrow(AgentInputRefusedError);
    await expect(h.runtime.runCheckpoint(async () => "x")).rejects.toThrow(AgentInputRefusedError);

    // refused work leaves no tracked operations behind
    expect(h.runtime.pendingOperationCount()).toBe(1); // only the agent turn
    await h.runtime.endAgentTurn();
    await stopPromise;
    expect(h.runtime.getState()).toBe("STOPPED");
    expect(h.idle.isSubprocessRunning()).toBe(false);
    expect(h.idle.isCheckpointRunning()).toBe(false);
  });

  test("endAgentTurn succeeds during STOPPING without changing the state", async () => {
    const h = makeHarness();
    await h.runtime.open();
    await h.runtime.beginAgentTurn();
    const stopPromise = h.runtime.stop();
    await new Promise((r) => setTimeout(r, 5));
    await h.runtime.endAgentTurn();
    expect(h.runtime.getState()).toBe("STOPPING");
    await stopPromise;
    expect(h.runtime.getState()).toBe("STOPPED");
  });

  test("endAgentTurn without an active turn is refused", async () => {
    const h = makeHarness();
    await h.runtime.open();
    await expect(h.runtime.endAgentTurn()).rejects.toThrow(InvalidOperationError);
    await h.runtime.beginAgentTurn();
    await h.runtime.endAgentTurn();
    await expect(h.runtime.endAgentTurn()).rejects.toThrow(InvalidOperationError);
  });

  test("new agent turns are rejected during STOPPING", async () => {
    const h = makeHarness();
    await h.runtime.open();
    await h.runtime.beginAgentTurn();
    const gate = deferred<void>();
    const opPromise = h.runtime.runToolInvocation(async () => {
      await gate.promise;
      return "ok";
    });
    const stopPromise = h.runtime.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.runtime.getState()).toBe("STOPPING");
    await expect(h.runtime.beginAgentTurn()).rejects.toThrow(AgentInputRefusedError);
    // the running operation is awaited before the checkpoint
    expect(h.steps.calls).not.toContain("runLifecycleCheckpoint");
    gate.resolve();
    await opPromise;
    // the agent turn itself is also drained before the checkpoint completes
    await h.runtime.endAgentTurn();
    await stopPromise;
    expect(h.steps.calls).toContain("runLifecycleCheckpoint");
    expect(h.runtime.getState()).toBe("STOPPED");
  });

  test("stop waits for running operations before checkpointing", async () => {
    const h = makeHarness();
    await h.runtime.open();
    let opDone = false;
    const op = h.runtime.runToolInvocation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      opDone = true;
      return "ok";
    });
    const stopPromise = h.runtime.stop();
    expect(h.steps.calls).not.toContain("runLifecycleCheckpoint");
    await op;
    await stopPromise;
    expect(opDone).toBe(true);
    expect(h.runtime.getState()).toBe("STOPPED");
  });

  test("lifecycle checkpoint failure -> CHECKPOINT_FAILED and instance stop NOT called", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.instance.calls = [];
    h.steps.calls = [];
    h.store.clearHistory();
    h.steps.failures.set("runLifecycleCheckpoint", () => new Error("checkpoint failed"));
    const state = await h.runtime.stop();
    expect(state).toBe("CHECKPOINT_FAILED");
    expect(h.runtime.getState()).toBe("CHECKPOINT_FAILED");
    expect(h.instance.calls).toEqual([]); // Cloud Run stop NOT called
    expect(h.steps.calls).toEqual(["runLifecycleCheckpoint"]);
    expect(h.steps.calls).not.toContain("flushSessionPersistence");
    expect(h.steps.calls).not.toContain("deleteSandbox");
    expect(h.runtime.getLastError()).toBeInstanceOf(Error);
    expect(h.store.getHistory().map((r) => `${r.from}->${r.to}`)).toEqual([
      "READY->STOPPING",
      "STOPPING->CHECKPOINT_FAILED",
    ]);
  });

  test("retrying stop after CHECKPOINT_FAILED can succeed", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.steps.failures.set("runLifecycleCheckpoint", () => new Error("checkpoint failed"));
    expect(await h.runtime.stop()).toBe("CHECKPOINT_FAILED");
    h.instance.calls = [];
    h.steps.failures.clear();
    const state = await h.runtime.stop();
    expect(state).toBe("STOPPED");
    expect(h.instance.calls).toEqual(["stop:dsh-ws-1"]);
  });

  test("sandbox deletion failure -> ERROR state", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.instance.calls = [];
    h.steps.failures.set("deleteSandbox", () => new Error("sandbox delete failed"));
    await expect(h.runtime.stop()).rejects.toThrow("sandbox delete failed");
    expect(h.runtime.getState()).toBe("ERROR");
    expect(h.instance.calls).toEqual([]);
  });

  test("stop when already STOPPED is a no-op", async () => {
    const h = makeHarness();
    await h.runtime.open();
    await h.runtime.stop();
    h.instance.calls = [];
    const state = await h.runtime.stop();
    expect(state).toBe("STOPPED");
    expect(h.instance.calls).toEqual([]);
  });

  test("concurrent stops coalesce", async () => {
    const h = makeHarness();
    await h.runtime.open();
    const [a, b] = await Promise.all([h.runtime.stop(), h.runtime.stop()]);
    expect(a).toBe("STOPPED");
    expect(b).toBe("STOPPED");
    expect(h.instance.calls.filter((c) => c === "stop:dsh-ws-1")).toHaveLength(1);
    expect(h.steps.calls.filter((c) => c === "runLifecycleCheckpoint")).toHaveLength(1);
  });

  test("stop is refused in STARTING/RESTORING", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    h.steps.gates.set("waitForInstanceHealth", gate as unknown as ReturnType<typeof deferred<void>>);
    const openPromise = h.runtime.open();
    await new Promise((r) => setTimeout(r, 5));
    await expect(h.runtime.stop()).rejects.toThrow(InvalidOperationError);
    gate.resolve();
    await openPromise;
  });
});

describe("WorkspaceRuntime — idle integration (仕様書 section 11)", () => {
  test("open and agent turns are meaningful; 30 min of silence triggers idle stop", async () => {
    const h = makeHarness();
    await h.runtime.open();
    expect(h.idle.getLastMeaningfulActivityAt()).toEqual(h.clock.now());
    await h.runtime.beginAgentTurn();
    await h.runtime.endAgentTurn();
    expect(h.idle.isAgentRunning()).toBe(false);
    h.clock.advance(30 * 60 * 1000);
    expect(await h.runtime.maybeStopForIdle()).toBe(true);
    expect(h.runtime.getState()).toBe("STOPPED");
    expect(h.instance.calls.includes("stop:dsh-ws-1")).toBe(true);
  });

  test("no idle stop before the 30 minute timeout", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.clock.advance(29 * 60 * 1000);
    expect(await h.runtime.maybeStopForIdle()).toBe(false);
    expect(h.runtime.getState()).toBe("READY");
  });

  test("agent turn running blocks the idle stop", async () => {
    const h = makeHarness();
    await h.runtime.open();
    await h.runtime.beginAgentTurn();
    h.clock.advance(31 * 60 * 1000);
    expect(await h.runtime.maybeStopForIdle()).toBe(false);
    await h.runtime.endAgentTurn();
    h.clock.advance(30 * 60 * 1000);
    expect(await h.runtime.maybeStopForIdle()).toBe(true);
  });

  test("subprocess running blocks the idle stop and is tracked as an operation", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.clock.advance(31 * 60 * 1000);
    let done = false;
    const sub = h.runtime.runSubprocess(async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
      return "ok";
    });
    expect(h.runtime.pendingOperationCount()).toBe(1);
    expect(await h.runtime.maybeStopForIdle()).toBe(false);
    await sub;
    expect(done).toBe(true);
    expect(h.idle.isSubprocessRunning()).toBe(false);
    h.clock.advance(30 * 60 * 1000);
    expect(await h.runtime.maybeStopForIdle()).toBe(true);
  });

  test("non-meaningful activity does not postpone the idle stop", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.clock.advance(25 * 60 * 1000);
    h.runtime.recordActivity("health_check");
    h.runtime.recordActivity("sse_heartbeat");
    h.runtime.recordActivity("browser_connection");
    h.runtime.recordActivity("status_polling");
    h.runtime.recordActivity("metrics_collection");
    h.clock.advance(5 * 60 * 1000);
    expect(await h.runtime.maybeStopForIdle()).toBe(true);
  });

  test("idle polling stop ends in STOPPED via the graceful path", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.clock.advance(30 * 60 * 1000);
    expect(await h.runtime.maybeStopForIdle()).toBe(true);
    expect(h.steps.calls).toContain("runLifecycleCheckpoint");
    expect(h.steps.calls).toContain("flushSessionPersistence");
    expect(h.steps.calls).toContain("deleteSandbox");
    expect(h.runtime.getState()).toBe("STOPPED");
  });
});