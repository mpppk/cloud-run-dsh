import { describe, test, expect } from "bun:test";
import type { WorkspaceStateTransaction } from "./store.js";
import { InMemoryTransactionalStore } from "./store.js";
import { IllegalTransitionError } from "./state.js";
import type { Clock } from "@cloud-run-dsh/workspace-checkpoint";

class FixedClock implements Clock {
  constructor(private readonly date: Date) {}
  now(): Date {
    return this.date;
  }
  nowMs(): number {
    return this.date.getTime();
  }
}

describe("InMemoryTransactionalStore", () => {
  test("load returns null for unknown workspace", async () => {
    const store = new InMemoryTransactionalStore();
    expect(await store.load("ws-1")).toBeNull();
  });

  test("apply persists the new state atomically", async () => {
    const store = new InMemoryTransactionalStore();
    await store.apply("ws-1", "STOPPED", "STARTING", "open");
    expect(await store.load("ws-1")).toBe("STARTING");
    expect(store.getHistory()).toHaveLength(1);
    expect(store.getHistory()[0]!.from).toBe("STOPPED");
    expect(store.getHistory()[0]!.to).toBe("STARTING");
    expect(store.getHistory()[0]!.reason).toBe("open");
  });

  test("persist callback runs inside the same transaction (実装手順書 section 4)", async () => {
    const store = new InMemoryTransactionalStore();
    await store.apply(
      "ws-1",
      "STOPPED",
      "STARTING",
      "open",
      async (tx: WorkspaceStateTransaction) => {
        tx.persist({ event: "open-requested" });
      },
    );
    expect(store.getPersisted()).toHaveLength(1);
    expect(store.getPersisted()[0]!.data).toEqual({ event: "open-requested" });
    expect(store.getPersisted()[0]!.record.to).toBe("STARTING");
  });

  test("transition is NOT applied when the persist callback throws (atomicity)", async () => {
    const store = new InMemoryTransactionalStore();
    await store.apply("ws-1", "STOPPED", "STARTING", "open");

    let caught: unknown = null;
    try {
      await store.apply("ws-1", "STARTING", "RESTORING", "healthy", async (tx) => {
        // data written before the failure must NOT survive the abort
        tx.persist({ x: 1 });
        throw new Error("db write failed");
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe("db write failed");
    // rollback: state remains STARTING, no history entry, nothing persisted
    expect(await store.load("ws-1")).toBe("STARTING");
    expect(store.getHistory()).toHaveLength(1);
    expect(store.getPersisted()).toHaveLength(0);
  });

  test("nothing is persisted from an aborted transaction (rollback semantics)", async () => {
    const store = new InMemoryTransactionalStore();
    await store.apply("ws-1", "STOPPED", "STARTING", "open");
    try {
      await store.apply("ws-1", "STARTING", "RESTORING", "healthy", async (tx) => {
        await tx.persist({ payload: "doomed" });
        throw new Error("abort");
      });
    } catch {
      // expected
    }
    expect(store.getPersisted()).toHaveLength(0);
    // the committed transaction's data is still there and intact
    await store.apply("ws-1", "STARTING", "RESTORING", "healthy", async (tx) => {
      await tx.persist({ payload: "committed" });
    });
    expect(store.getPersisted()).toHaveLength(1);
    expect(store.getPersisted()[0]!.data).toEqual({ payload: "committed" });
  });

  test("TransitionRecord.at comes from the injected clock (deterministic timestamps)", async () => {
    const fixed = new Date("2026-01-01T12:00:00.000Z");
    const store = new InMemoryTransactionalStore(undefined, new FixedClock(fixed));
    await store.apply("ws-1", "STOPPED", "STARTING", "open");
    const record = store.getHistory()[0]!;
    expect(record.at).toEqual(fixed);
    expect(record.at.getTime()).toBe(fixed.getTime());
  });

  test("apply against a mismatched current state throws IllegalTransitionError", async () => {
    const store = new InMemoryTransactionalStore({ "ws-1": "READY" });
    await expect(store.apply("ws-1", "STOPPED", "STARTING", "open")).rejects.toThrow(
      IllegalTransitionError,
    );
    expect(await store.load("ws-1")).toBe("READY");
  });

  test("concurrent applies to the same workspace are serialized", async () => {
    const store = new InMemoryTransactionalStore();
    const order: string[] = [];
    const slowFirst = store.apply("ws-1", "STOPPED", "STARTING", "open", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("first-committed");
    });
    const second = store.apply("ws-1", "STARTING", "RESTORING", "healthy").then(() =>
      order.push("second-committed"),
    );
    await Promise.all([slowFirst, second]);
    expect(order).toEqual(["first-committed", "second-committed"]);
    expect(await store.load("ws-1")).toBe("RESTORING");
  });

  test("transitions for different workspaces do not interfere", async () => {
    const store = new InMemoryTransactionalStore();
    await Promise.all([
      store.apply("ws-a", "STOPPED", "STARTING", "open"),
      store.apply("ws-b", "STOPPED", "STARTING", "open"),
    ]);
    expect(await store.load("ws-a")).toBe("STARTING");
    expect(await store.load("ws-b")).toBe("STARTING");
  });

  test("initial states can be seeded", async () => {
    const store = new InMemoryTransactionalStore({ "ws-x": "READY" });
    expect(await store.load("ws-x")).toBe("READY");
  });
});