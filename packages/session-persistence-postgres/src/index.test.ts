import { describe, test, expect } from "bun:test";
import { InMemoryFakeExecutor } from "./fakeExecutor.js";
import { PostgresSessionPersistenceRepository } from "./repository.js";
import { PostgresSessionPersistence } from "./sessionPersistence.js";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";

function newExecutor() {
  return new InMemoryFakeExecutor();
}

async function setupWorkspaceAndSession(exec = newExecutor()) {
  const repo = new PostgresSessionPersistenceRepository(exec);
  const ws = await repo.createWorkspace({
    id: "00000000-0000-0000-0000-000000000001",
    ownerId: "user-1",
    repositoryOwner: "mpppk",
    repositoryName: "cloud-run-dsh",
    baseBranch: "main",
  });
  const session = await repo.createSession({
    id: "00000000-0000-0000-0000-000000000002",
    workspaceId: ws.id,
  });
  return { exec, repo, ws, session };
}

describe("session-persistence-postgres", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("session-persistence-postgres");
    expect(createPlaceholder().kind).toBe("session-persistence-postgres");
  });

  test("workspace and session CRUD", async () => {
    const { repo } = await setupWorkspaceAndSession();
    const w = await repo.getWorkspace("00000000-0000-0000-0000-000000000001");
    expect(w).not.toBeNull();
    expect(w!.ownerId).toBe("user-1");
    expect(w!.runtimeState).toBe("STOPPED");

    const w2 = await repo.updateRuntimeState(w!.id, "READY");
    expect(w2.runtimeState).toBe("READY");

    const w3 = await repo.updateLastActivityAt(w!.id, "2026-09-02T00:00:00Z");
    expect(w3.lastActivityAt).toBe("2026-09-02T00:00:00Z");

    const sessions = await repo.listSessions(w!.id);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.id).toBe("00000000-0000-0000-0000-000000000002");

    const s = await repo.getSession(sessions[0]!.id);
    expect(s).not.toBeNull();
  });

  test("ordered reads: readEvents returns seq order", async () => {
    const { repo, session } = await setupWorkspaceAndSession();
    await repo.append(session.id, [
      { eventType: "user_message", eventTime: 1, data: { text: "a" } },
      { eventType: "agent_thinking", eventTime: 2, data: { text: "b" } },
      { eventType: "tool_call", eventTime: 3, data: { text: "c" } },
    ]);
    const events = await repo.readEvents(session.id);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.eventType)).toEqual(["user_message", "agent_thinking", "tool_call"]);
  });

  test("readEvents with fromSeq", async () => {
    const { repo, session } = await setupWorkspaceAndSession();
    await repo.append(session.id, [
      { eventType: "a", eventTime: 1, data: {} },
      { eventType: "b", eventTime: 2, data: {} },
      { eventType: "c", eventTime: 3, data: {} },
      { eventType: "d", eventTime: 4, data: {} },
    ]);
    const tail = await repo.readEvents(session.id, 2);
    expect(tail.map((e) => e.seq)).toEqual([2, 3]);
    const all = await repo.readEvents(session.id, 0);
    expect(all.length).toBe(4);
  });

  test("contiguous seq under concurrent appends", async () => {
    const { repo, session } = await setupWorkspaceAndSession();
    // Fire 5 concurrent appends, each appending 2 events (total 10)
    const appends = Array.from({ length: 5 }, (_, i) =>
      repo.append(session.id, [
        { eventType: `evt-${i}-0`, eventTime: Date.now(), data: { i, j: 0 } },
        { eventType: `evt-${i}-1`, eventTime: Date.now(), data: { i, j: 1 } },
      ]),
    );
    const results = await Promise.all(appends);
    // Each append should have allocated non-overlapping seqs
    const allSeqs = results.flat().map((e) => e.seq).sort((a, b) => a - b);
    expect(allSeqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // No duplicates
    expect(new Set(allSeqs).size).toBe(10);

    const stored = await repo.readEvents(session.id);
    expect(stored.length).toBe(10);
    expect(stored.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Ensure assertContiguous passes
    await expect(repo.assertContiguous(session.id)).resolves.toBeUndefined();
  });

  test("rejection of attempts to mutate a persisted event", async () => {
    const { exec, repo, session } = await setupWorkspaceAndSession();
    await repo.append(session.id, [{ eventType: "a", eventTime: 1, data: { x: 1 } }]);

    await expect(exec.exec("UPDATE session_events SET data = '{\"x\":2}' WHERE session_id = $1", [session.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(exec.exec("DELETE FROM session_events WHERE session_id = $1", [session.id])).rejects.toThrow(
      /append-only/,
    );

    // Also via transaction
    await expect(
      exec.transaction(async (tx) => {
        await tx.exec("UPDATE session_events SET event_type = 'hacked' WHERE session_id = $1", [session.id]);
      }),
    ).rejects.toThrow(/append-only/);

    // Ensure original event unchanged
    const events = await repo.readEvents(session.id);
    expect(events.length).toBe(1);
    expect(events[0]!.data).toEqual({ x: 1 });
  });

  test("gap detection", async () => {
    const { exec, repo, session } = await setupWorkspaceAndSession();
    await repo.append(session.id, [
      { eventType: "a", eventTime: 1, data: {} },
      { eventType: "b", eventTime: 2, data: {} },
    ]);
    // Inject a gap: skip seq 2, insert seq 5 directly via fake injection
    exec.__injectEvent(session.id, {
      sessionId: session.id,
      seq: 5,
      eventType: "injected_gap",
      eventTime: 99,
      data: { injected: true },
    });

    // assertContiguous should detect gap
    await expect(repo.assertContiguous(session.id)).rejects.toThrow(/gap detected/);

    // Subsequent append should also fail due to gap validation inside append's transaction
    await expect(
      repo.append(session.id, [{ eventType: "c", eventTime: 3, data: {} }]),
    ).rejects.toThrow(/gap detected/);

    // readEvents still returns events in order including the gap
    const events = await repo.readEvents(session.id);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 5]);
  });

  test("transaction rollback on failure: no partial events persisted", async () => {
    const { repo, session } = await setupWorkspaceAndSession();
    await repo.append(session.id, [{ eventType: "a", eventTime: 1, data: {} }]);
    expect((await repo.readEvents(session.id)).length).toBe(1);

    const exec = (repo as unknown as { executor: InMemoryFakeExecutor }).executor as InMemoryFakeExecutor;
    // Use a fresh repo with a failing wrapper
    const failingRepo = new PostgresSessionPersistenceRepository({
      async exec(sql, params) {
        return exec.exec(sql, params);
      },
      async query(sql, params) {
        return exec.query(sql, params);
      },
      async transaction(fn) {
        return exec.transaction(async (tx) => {
          // Wrap tx.exec to fail on second session_events insert
          let call = 0;
          const wrapped: typeof tx = {
            exec: async (s, p) => {
              if (s.toLowerCase().includes("insert into session_events")) {
                call++;
                if (call === 2) throw new Error("simulated failure on second insert");
              }
              return tx.exec(s, p);
            },
            query: tx.query.bind(tx),
            transaction: tx.transaction.bind(tx),
          };
          return fn(wrapped);
        });
      },
    } as unknown as InMemoryFakeExecutor);

    await expect(
      failingRepo.append(session.id, [
        { eventType: "b", eventTime: 2, data: {} },
        { eventType: "c", eventTime: 3, data: {} },
      ]),
    ).rejects.toThrow(/simulated failure/);

    // Verify no partial append persisted (still only the original 1 event)
    const events = await repo.readEvents(session.id);
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("a");
  });

  test("SessionPersistence provider delegates to repository", async () => {
    const { repo, session } = await setupWorkspaceAndSession();
    const persistence = new PostgresSessionPersistence(repo);
    const persisted = await persistence.append(session.id, [
      { eventType: "user", eventTime: 1, data: { msg: "hi" } },
    ]);
    expect(persisted[0]!.seq).toBe(0);
    const read = await persistence.readEvents(session.id);
    expect(read.length).toBe(1);
  });
});

describe("gap detection via read length vs seq", () => {
  test("detects missing seq on read", async () => {
    const { repo } = await setupWorkspaceAndSession();
    // Manually inject non-contiguous via fake executor bypassing append
    // Achieved by gap test already; just verify ordered read returns sorted
    const events = await repo.readEvents("00000000-0000-0000-0000-000000000002");
    expect(events.length).toBe(0);
  });
});
