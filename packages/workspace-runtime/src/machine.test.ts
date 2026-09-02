import { describe, test, expect } from "bun:test";
import { WorkspaceStateMachine } from "./machine.js";
import { InMemoryTransactionalStore } from "./store.js";
import { IllegalTransitionError } from "./state.js";

describe("WorkspaceStateMachine", () => {
  function makeMachine(initial: "STOPPED" | "READY" = "STOPPED") {
    const store = new InMemoryTransactionalStore();
    const machine = new WorkspaceStateMachine("ws-1", store, initial);
    return { store, machine };
  }

  test("starts in the given initial state", () => {
    const { machine } = makeMachine();
    expect(machine.getState()).toBe("STOPPED");
    const { machine: ready } = makeMachine("READY");
    expect(ready.getState()).toBe("READY");
  });

  test("legal transition applies through the store", async () => {
    const { store, machine } = makeMachine();
    await machine.transition("STARTING", "open");
    expect(machine.getState()).toBe("STARTING");
    expect(await store.load("ws-1")).toBe("STARTING");
    expect(store.getHistory()).toHaveLength(1);
  });

  test("persist callback commits together with the transition", async () => {
    const store = new InMemoryTransactionalStore({ "ws-1": "READY" });
    const machine = new WorkspaceStateMachine("ws-1", store, "READY");
    await machine.transition("STOPPING", "graceful-stop", async (tx) => {
      tx.persist({ flushedAt: tx.record.at.toISOString() });
    });
    expect(store.getPersisted()).toHaveLength(1);
    expect(store.getPersisted()[0]!.record.to).toBe("STOPPING");
  });

  test("illegal transition throws and leaves state unchanged", async () => {
    const { store, machine } = makeMachine();
    let caught: unknown = null;
    try {
      await machine.transition("READY");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    expect(machine.getState()).toBe("STOPPED");
    expect(store.getHistory()).toHaveLength(0);
  });

  test("canTransition mirrors the table", async () => {
    const { machine } = makeMachine();
    expect(machine.canTransition("STARTING")).toBe(true);
    expect(machine.canTransition("READY")).toBe(false);
  });

  test("reload picks up state from the store", async () => {
    const store = new InMemoryTransactionalStore({ "ws-1": "RESTORE_FAILED" });
    const machine = new WorkspaceStateMachine("ws-1", store, "STOPPED");
    expect(await machine.reload()).toBe("RESTORE_FAILED");
    expect(machine.getState()).toBe("RESTORE_FAILED");
  });

  test("full lifecycle walk through the machine", async () => {
    const { store, machine } = makeMachine();
    await machine.transition("STARTING", "open");
    await machine.transition("RESTORING", "instance-healthy");
    await machine.transition("READY", "restore-complete");
    await machine.transition("BUSY", "agent-turn");
    await machine.transition("READY", "agent-turn-complete");
    await machine.transition("CHECKPOINTING", "periodic-checkpoint");
    await machine.transition("READY", "checkpoint-complete");
    await machine.transition("STOPPING", "graceful-stop");
    await machine.transition("STOPPED", "stop-complete");
    expect(machine.getState()).toBe("STOPPED");
    expect(store.getHistory()).toHaveLength(9);
  });
});