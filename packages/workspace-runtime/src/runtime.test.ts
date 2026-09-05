import { describe, test, expect } from "bun:test";
import type { WorkspaceLifecycleSteps } from "./runtime.js";
import { WorkspaceRuntime, AgentInputRefusedError, InvalidOperationError } from "./runtime.js";
import type { TransactionalStateStore } from "./store.js";
import { InMemoryTransactionalStore } from "./store.js";
import { IllegalTransitionError } from "./state.js";
import type { WorkspaceRuntimeState } from "./state.js";
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
    await expect(h.runtime.assertAgentInputAllowed()).rejects.toThrow(AgentInputRefusedError);
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

describe("WorkspaceRuntime — issue #63: a STARTING failure keeps the original error", () => {
  test("health observation failure while STARTING lands in RESTORE_FAILED with the original error", async () => {
    // The GCP path: the instance started, but the agent-host health never
    // reports ready (its git clone failed inside the instance). The control
    // plane must surface the health error — not a state-transition error —
    // and still record RESTORE_FAILED (仕様書 section 8).
    const h = makeHarness();
    h.steps.failures.set(
      "waitForInstanceHealth",
      () => new Error("agent-host never became healthy"),
    );
    await expect(h.runtime.openInstance()).rejects.toThrow("agent-host never became healthy");
    expect(h.runtime.getState()).toBe("RESTORE_FAILED");
    expect(h.runtime.getLastError()).toMatchObject({
      message: "agent-host never became healthy",
    });
  });

  test("shared-row race: agent-host records RESTORE_FAILED first, control plane still surfaces its own error", async () => {
    // Two runtimes, one row (issue #60 split): the agent-host fails git clone
    // and commits RESTORE_FAILED while the control plane is still polling
    // health in STARTING. The control plane's belated bookkeeping must not
    // replace its own failure with IllegalTransitionError (the exact GCP
    // report: "illegal state transition: STARTING -> RESTORE_FAILED").
    const h = makeHarness();
    const gate = deferred<void>();
    h.steps.gates.set("waitForInstanceHealth", gate as unknown as ReturnType<typeof deferred<void>>);
    const agentSteps = new FakeSteps();
    agentSteps.failures.set("cloneRepository", () => new Error("git clone failed: boom"));
    const agent = new WorkspaceRuntime({
      workspaceId: "ws-1",
      store: h.store,
      clock: h.clock,
      instanceRuntime: h.instance,
      instanceName: "dsh-ws-1",
      steps: agentSteps,
      idle: new IdleManager(h.clock),
    });

    const caughtP = h.runtime
      .openInstance()
      .then((): Error | null => null, (e: unknown) => e as Error);
    for (let i = 0; i < 1000 && (await h.store.load("ws-1")) !== "STARTING"; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(await h.store.load("ws-1")).toBe("STARTING");

    // The agent-host fails and records RESTORE_FAILED on the shared row.
    await expect(agent.completeRestore()).rejects.toThrow("git clone failed: boom");

    // ... then the control plane's own health observation fails too.
    gate.reject(new Error("agent-host never became healthy"));
    const err = await caughtP;
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(IllegalTransitionError);
    expect(err!.message).toBe("agent-host never became healthy");
    // The failure state the agent-host recorded is left untouched.
    expect(await h.store.load("ws-1")).toBe("RESTORE_FAILED");
    expect(h.runtime.getState()).toBe("RESTORE_FAILED");
    expect(h.runtime.getLastError()).toMatchObject({
      message: "agent-host never became healthy",
    });
  });

  /**
   * Store whose compare-and-set loses a race exactly on the failure-state
   * bookkeeping edge: reload() still sees STARTING, but apply() finds the
   * row already moved on — the issue #60/#63 interleave.
   */
  class LostRaceStore implements TransactionalStateStore {
    current: WorkspaceRuntimeState | null = "STOPPED";
    constructor(private readonly onFailureEdge: (from: WorkspaceRuntimeState) => unknown) {}
    async load(_workspaceId: string): Promise<WorkspaceRuntimeState | null> {
      return this.current;
    }
    async apply(
      _workspaceId: string,
      from: WorkspaceRuntimeState,
      to: WorkspaceRuntimeState,
      _reason: string | undefined,
    ): Promise<void> {
      if (from === "STARTING" && to === "RESTORE_FAILED") {
        this.current = "RESTORE_FAILED"; // the other process won
        throw this.onFailureEdge(from);
      }
      if (this.current !== from) {
        throw new IllegalTransitionError(this.current ?? "STOPPED", to);
      }
      this.current = to;
    }
  }

  function makeRuntimeWithStore(store: TransactionalStateStore, steps: FakeSteps): WorkspaceRuntime {
    const clock = new FakeClock();
    return new WorkspaceRuntime({
      workspaceId: "ws-1",
      store,
      clock,
      instanceRuntime: new FakeInstanceRuntime(),
      instanceName: "dsh-ws-1",
      steps,
      idle: new IdleManager(clock),
    });
  }

  test("a lost bookkeeping race is chained as cause; the original error is still thrown", async () => {
    const steps = new FakeSteps();
    steps.failures.set("waitForInstanceHealth", () => new Error("health poll timed out"));
    const runtime = makeRuntimeWithStore(
      new LostRaceStore(
        () => new IllegalTransitionError("RESTORE_FAILED", "RESTORE_FAILED"),
      ),
      steps,
    );
    const err = await runtime
      .openInstance()
      .then((): Error | null => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(IllegalTransitionError);
    expect(err!.message).toBe("health poll timed out");
    // The secondary bookkeeping failure rides along as cause so the race
    // stays visible without replacing the real failure.
    expect(err!.cause).toBeInstanceOf(IllegalTransitionError);
  });

  test("a non-transition bookkeeping failure is dropped, never chained (secret hygiene)", async () => {
    // Store-level failures can carry connection details; only state-names
    // errors (IllegalTransitionError) may be chained onto errors that end up
    // in structured logs.
    const steps = new FakeSteps();
    steps.failures.set("waitForInstanceHealth", () => new Error("health poll timed out"));
    const runtime = makeRuntimeWithStore(
      new LostRaceStore(() => new Error("postgres connect failed: host=/cloudsql/p:r:i")),
      steps,
    );
    const err = await runtime
      .openInstance()
      .then((): Error | null => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toBe("health poll timed out");
    expect(err!.cause).toBeUndefined();
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

  test("issue #88: concurrent stops from two runtimes sharing one store — loser throws IllegalTransitionError, retry recovers", async () => {
    // The reviewer's 20/20 repro: two runtime objects (e.g. a rebuilt
    // control-plane handle cache, or control plane vs agent-host idle-stop)
    // against the SAME row. Unlike same-runtime stops above, there is no
    // shared stopPromise to coalesce on, so both attempt READY -> STOPPING
    // and the compare-and-set lets exactly one through.
    const clock = new FakeClock();
    const store = new InMemoryTransactionalStore();
    const makeRuntime = () =>
      new WorkspaceRuntime({
        workspaceId: "ws-1",
        store,
        clock,
        instanceRuntime: new FakeInstanceRuntime(),
        instanceName: "dsh-ws-1",
        steps: new FakeSteps(),
        idle: new IdleManager(clock),
      });
    const first = makeRuntime();
    const second = makeRuntime();
    await first.open();
    expect(await store.load("ws-1")).toBe("READY");

    const [a, b] = await Promise.allSettled([first.stop(), second.stop()]);
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<WorkspaceRuntimeState>).value).toBe("STOPPED");
    const loserError = (rejected[0] as PromiseRejectedResult).reason;
    expect(loserError).toBeInstanceOf(IllegalTransitionError);

    // The row converges and STOPPING re-entry is allowed, so a retry heals:
    // no stuck state, no lost work — the caller just retries.
    expect(await store.load("ws-1")).toBe("STOPPED");
    const loser = a.status === "rejected" ? first : second;
    await expect(loser.stop()).resolves.toBe("STOPPED");
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

describe("WorkspaceRuntime — prepareStop (issue #72)", () => {
  test("prepareStop runs the stop sequence WITHOUT the instance stop and stays STOPPING", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.instance.calls = [];
    h.steps.calls = [];
    h.store.clearHistory();
    const state = await h.runtime.prepareStop();
    expect(state).toBe("STOPPING");
    expect(h.runtime.getState()).toBe("STOPPING");
    expect(h.steps.calls).toEqual([
      "runLifecycleCheckpoint",
      "flushSessionPersistence",
      "deleteSandbox",
    ]);
    // The Cloud Run instance stop is the CALLER's job — never here.
    expect(h.instance.calls).toEqual([]);
    expect(h.store.getHistory().map((r) => `${r.from}->${r.to}`)).toEqual(["READY->STOPPING"]);
  });

  test("stop() is exactly prepareStop() plus the instance stop (no second sequence copy)", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.instance.calls = [];
    h.steps.calls = [];
    expect(await h.runtime.stop()).toBe("STOPPED");
    expect(h.steps.calls).toEqual([
      "runLifecycleCheckpoint",
      "flushSessionPersistence",
      "deleteSandbox",
    ]);
    expect(h.instance.calls).toEqual(["stop:dsh-ws-1"]);
  });

  test("prepareStop checkpoint failure -> CHECKPOINT_FAILED and instance stop NOT called", async () => {
    const h = makeHarness();
    await h.runtime.open();
    h.instance.calls = [];
    h.steps.calls = [];
    h.steps.failures.set("runLifecycleCheckpoint", () => new Error("checkpoint failed"));
    const state = await h.runtime.prepareStop();
    expect(state).toBe("CHECKPOINT_FAILED");
    expect(h.instance.calls).toEqual([]);
    expect(h.steps.calls).toEqual(["runLifecycleCheckpoint"]);
  });

  test("prepareStop when already STOPPED is a no-op", async () => {
    const h = makeHarness();
    await h.runtime.open();
    await h.runtime.stop();
    h.instance.calls = [];
    h.steps.calls = [];
    expect(await h.runtime.prepareStop()).toBe("STOPPED");
    expect(h.steps.calls).toEqual([]);
    expect(h.instance.calls).toEqual([]);
  });

  test("prepareStop from STOPPING resumes instead of throwing (unfinished-stop retry)", async () => {
    const h = makeHarness();
    await h.runtime.open();
    await h.runtime.prepareStop();
    expect(h.runtime.getState()).toBe("STOPPING");
    h.steps.calls = [];
    // A previous stop marked the row but never finished (e.g. the caller
    // crashed before the instance stop): re-running must NOT throw
    // IllegalTransitionError on the STOPPING->STOPPING "transition".
    expect(await h.runtime.prepareStop()).toBe("STOPPING");
    expect(h.steps.calls).toEqual([
      "runLifecycleCheckpoint",
      "flushSessionPersistence",
      "deleteSandbox",
    ]);
  });

  test("stop() from STOPPING resumes to STOPPED (retry after a crash between prepare and instance stop)", async () => {
    const h = makeHarness();
    await h.runtime.open();
    await h.runtime.prepareStop();
    h.instance.calls = [];
    expect(await h.runtime.stop()).toBe("STOPPED");
    expect(h.instance.calls).toEqual(["stop:dsh-ws-1"]);
  });

  test("prepareStop is refused in STARTING/RESTORING", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    h.steps.gates.set("waitForInstanceHealth", gate as unknown as ReturnType<typeof deferred<void>>);
    const openPromise = h.runtime.open();
    await new Promise((r) => setTimeout(r, 5));
    await expect(h.runtime.prepareStop()).rejects.toThrow(InvalidOperationError);
    gate.resolve();
    await openPromise;
  });

  test("concurrent prepareStop calls coalesce", async () => {
    const h = makeHarness();
    await h.runtime.open();
    const [a, b] = await Promise.all([h.runtime.prepareStop(), h.runtime.prepareStop()]);
    expect(a).toBe("STOPPING");
    expect(b).toBe("STOPPING");
    expect(h.steps.calls.filter((c) => c === "runLifecycleCheckpoint")).toHaveLength(1);
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
    // Issue #122: the operation gate is async now (it reloads the row
    // first), so registration lands a tick after the call — wait for it.
    // The assertions below (tracked + idle-stop blocked) are unchanged.
    await new Promise((r) => setTimeout(r, 5));
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

describe("WorkspaceRuntime — split open phases (issue #60 案C/案D)", () => {
  /** A second runtime over the SAME store: the other process's view of the row. */
  function makePeer(h: Harness, steps?: FakeSteps): WorkspaceRuntime {
    return new WorkspaceRuntime({
      workspaceId: "ws-1",
      store: h.store,
      clock: h.clock,
      instanceRuntime: h.instance,
      instanceName: "dsh-ws-1",
      steps: steps ?? h.steps,
      idle: h.idle,
    });
  }

  test("openInstance stops at STARTING without running any restore step", async () => {
    const h = makeHarness();
    const state = await h.runtime.openInstance();
    expect(state).toBe("STARTING");
    expect(h.instance.calls).toEqual(["start"]);
    expect(h.steps.calls).toEqual(["waitForInstanceHealth"]);
    expect(h.store.getHistory().map((r) => `${r.from}->${r.to}`)).toEqual([
      "STOPPED->STARTING",
    ]);
  });

  test("openInstance is idempotent from READY and illegal from BUSY", async () => {
    const h = makeHarness();
    await h.runtime.open();
    expect(await h.runtime.openInstance()).toBe("READY");
    expect(h.instance.calls.filter((c) => c === "start")).toHaveLength(1);

    await h.runtime.beginAgentTurn();
    await expect(h.runtime.openInstance()).rejects.toThrow(InvalidOperationError);
  });

  test("completeRestore refuses STOPPED (no control-plane open happened)", async () => {
    const h = makeHarness();
    await expect(h.runtime.completeRestore()).rejects.toThrow(InvalidOperationError);
    await expect(h.runtime.completeRestore()).rejects.toThrow(
      "open is not allowed in state STOPPED",
    );
    expect(h.steps.calls).toEqual([]);
  });

  test("two processes, one row: control plane starts, agent-host restores", async () => {
    const h = makeHarness();
    const agent = makePeer(h);

    // Control-plane phase: instance lifecycle + health observation only.
    expect(await h.runtime.openInstance()).toBe("STARTING");

    // The agent-host must NOT run the full open() on the shared row — this
    // is the exact issue-#60 production crash.
    await expect(agent.open()).rejects.toThrow("open is not allowed in state STARTING");
    // ... while the narrow restore operation proceeds to READY.
    expect(await agent.completeRestore()).toBe("READY");

    // The control plane observes the agent-persisted state via reload.
    expect(await h.runtime.reloadState()).toBe("READY");
    expect(h.store.getHistory().map((r) => `${r.from}->${r.to}`)).toEqual([
      "STOPPED->STARTING",
      "STARTING->RESTORING",
      "RESTORING->READY",
    ]);
  });

  test("completeRestore resumes from RESTORING, and the lost attempt is fenced (host crashed mid-restore)", async () => {
    const h = makeHarness();
    await h.runtime.openInstance();
    // First host attempt blocks inside the restore steps with RESTORING
    // already persisted — then its container is lost.
    const gate = deferred<void>();
    h.steps.gates.set("cloneRepository", gate as unknown as ReturnType<typeof deferred<void>>);
    const lostAttempt = h.runtime.completeRestore();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.runtime.getState()).toBe("RESTORING");

    // Rebooted host: a fresh in-memory view over the same row resumes the
    // steps and completes the restore.
    const rebooted = makePeer(h, new FakeSteps());
    expect(await rebooted.completeRestore()).toBe("READY");

    // The lost attempt wakes up afterwards: its final write is rejected by
    // the store CAS (the row moved on without it) — a stale host can never
    // silently rewrite the state machine.
    gate.resolve();
    await expect(lostAttempt).rejects.toThrow();
    expect(await rebooted.reloadState()).toBe("READY");
  });

  test("completeRestore retries from RESTORE_FAILED through STARTING", async () => {
    const h = makeHarness();
    await h.runtime.openInstance();
    const agent = makePeer(h);
    h.steps.failures.set("createSandbox", () => new Error("sandbox create failed"));
    await expect(agent.completeRestore()).rejects.toThrow("sandbox create failed");
    expect(await agent.reloadState()).toBe("RESTORE_FAILED");

    h.steps.failures.clear();
    expect(await agent.completeRestore()).toBe("READY");
    expect(h.store.getHistory().map((r) => r.to)).toEqual([
      "STARTING",
      "RESTORING",
      "RESTORE_FAILED",
      "STARTING",
      "RESTORING",
      "READY",
    ]);
  });

  test("two concurrent openInstance calls coalesce into a single start", async () => {
    const h = makeHarness();
    const gate = deferred<void>();
    h.steps.gates.set("waitForInstanceHealth", gate as unknown as ReturnType<typeof deferred<void>>);

    const both = Promise.all([h.runtime.openInstance(), h.runtime.openInstance()]);
    gate.resolve();
    const [a, b] = await both;

    expect(a).toBe("STARTING");
    expect(b).toBe("STARTING");
    expect(h.instance.calls.filter((c) => c === "start")).toHaveLength(1);
  });
});

describe("WorkspaceRuntime — issue #122: the turn gate must not stick on a stale in-memory state", () => {
  test("a turn is accepted after another process restores the row to READY (no re-open)", async () => {
    // The #122 timeline: this runtime (the control plane) fails its health
    // observation and records RESTORE_FAILED — in memory AND in the store.
    const h = makeHarness();
    h.steps.failures.set("waitForInstanceHealth", () => new Error("agent-host never became healthy"));
    await expect(h.runtime.openInstance()).rejects.toThrow("agent-host never became healthy");
    expect(h.runtime.getState()).toBe("RESTORE_FAILED");
    expect(await h.store.load("ws-1")).toBe("RESTORE_FAILED");

    // ... then the agent-host (a DIFFERENT process over the SAME row)
    // recovers late and persists READY — the `workspace.restore.completed`
    // that the issue observed 44s after the control plane gave up.
    const agent = new WorkspaceRuntime({
      workspaceId: "ws-1",
      store: h.store,
      clock: h.clock,
      instanceRuntime: h.instance,
      instanceName: "dsh-ws-1",
      steps: new FakeSteps(),
      idle: new IdleManager(h.clock),
    });
    await expect(agent.completeRestore()).resolves.toBe("READY");

    // The DB read (what GET /v1/workspaces/:id serves) now says READY.
    expect(await h.store.load("ws-1")).toBe("READY");

    // So the turn gate on THIS runtime must agree — without calling open()
    // again here. Before the fix this threw
    // AgentInputRefusedError(RESTORE_FAILED) off the stale in-memory cache
    // while GET answered READY.
    await h.runtime.assertAgentInputAllowed();
    await h.runtime.beginAgentTurn();
    expect(h.runtime.getState()).toBe("BUSY");
    await h.runtime.endAgentTurn();
    expect(h.runtime.getState()).toBe("READY");
  });

  test("the gate still refuses while the row itself is RESTORE_FAILED", async () => {
    // The reload must not invent READY: when nobody recovered the row, the
    // gate keeps refusing (仕様書 section 8).
    const h = makeHarness();
    h.steps.failures.set("restoreCheckpoint", () => new Error("checkpoint download failed"));
    await expect(h.runtime.open()).rejects.toThrow("checkpoint download failed");
    expect(await h.store.load("ws-1")).toBe("RESTORE_FAILED");
    // try/catch (not rejects) so this holds for both the old sync gate and
    // the fixed async gate.
    let gateError: unknown = null;
    try {
      await h.runtime.assertAgentInputAllowed();
    } catch (e) {
      gateError = e;
    }
    expect(gateError).toBeInstanceOf(AgentInputRefusedError);
    await expect(h.runtime.beginAgentTurn()).rejects.toThrow(AgentInputRefusedError);
  });
});