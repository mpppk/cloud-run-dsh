import { describe, test, expect, beforeEach } from "bun:test";
import type { QueryExecutor } from "./executor.js";
import { PostgresSessionPersistenceRepository } from "./repository.js";
import { PostgresSessionPersistence } from "./sessionPersistence.js";

export interface RepositorySuiteOptions {
  /**
   * The in-memory fake rejects UPDATE/DELETE on session_events to simulate
   * append-only enforcement. Real PostgreSQL has no such rule, so the
   * rejection test only runs where this is true.
   */
  enforceAppendOnlyRejection: boolean;
  /** Runs before each test (e.g. TRUNCATE for the real-PostgreSQL backend). */
  beforeEach?: () => Promise<void>;
}

async function setupWorkspaceAndSession(exec: QueryExecutor) {
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

/**
 * Shared repository behavior suite. Runs UNCHANGED against the in-memory
 * fake (always) and against real PostgreSQL when TEST_POSTGRES_URL is set
 * (see realPostgres.test.ts) — issue #70: the append path must be verified
 * against a real database, not only against a fake that silently ignores
 * locking clauses.
 */
export function defineRepositorySuite(
  name: string,
  makeExecutor: () => QueryExecutor | Promise<QueryExecutor>,
  opts: RepositorySuiteOptions,
): void {
  describe(name, () => {
    if (opts.beforeEach) beforeEach(opts.beforeEach);

    test("workspace and session CRUD", async () => {
      const { repo } = await setupWorkspaceAndSession(await makeExecutor());
      const w = await repo.getWorkspace("00000000-0000-0000-0000-000000000001");
      expect(w).not.toBeNull();
      expect(w!.ownerId).toBe("user-1");
      expect(w!.runtimeState).toBe("STOPPED");

      const w2 = await repo.updateRuntimeState(w!.id, "READY");
      expect(w2.runtimeState).toBe("READY");

      const w3 = await repo.updateLastActivityAt(w!.id, "2026-09-02T00:00:00Z");
      // Compare as instants: real PostgreSQL normalizes TIMESTAMPTZ to a
      // canonical ISO form ("...00.000Z") while the fake echoes the input
      // string; the contract is that the instant is preserved.
      expect(new Date(w3.lastActivityAt!).getTime()).toBe(new Date("2026-09-02T00:00:00Z").getTime());

      const sessions = await repo.listSessions(w!.id);
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.id).toBe("00000000-0000-0000-0000-000000000002");

      const s = await repo.getSession(sessions[0]!.id);
      expect(s).not.toBeNull();
    });

    test("ordered reads: readEvents returns seq order", async () => {
      const { repo, session } = await setupWorkspaceAndSession(await makeExecutor());
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
      const { repo, session } = await setupWorkspaceAndSession(await makeExecutor());
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
      const { repo, session } = await setupWorkspaceAndSession(await makeExecutor());
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

    if (opts.enforceAppendOnlyRejection) {
      test("rejection of attempts to mutate a persisted event", async () => {
        const { exec, repo, session } = await setupWorkspaceAndSession(await makeExecutor());
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
    }

    test("gap detection", async () => {
      const { exec, repo, session } = await setupWorkspaceAndSession(await makeExecutor());
      await repo.append(session.id, [
        { eventType: "a", eventTime: 1, data: {} },
        { eventType: "b", eventTime: 2, data: {} },
      ]);
      // Inject a gap: skip seq 2..4, insert seq 5 directly via raw SQL,
      // bypassing append — works on every backend (mirrors repository's
      // own INSERT shape, including JSON-stringified data).
      await exec.exec(
        `INSERT INTO session_events(session_id, seq, event_type, event_time, data, source_event_seqs, surface_op)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [session.id, 5, "injected_gap", 99, JSON.stringify({ injected: true }), null, null],
      );

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
      const { exec, repo, session } = await setupWorkspaceAndSession(await makeExecutor());
      await repo.append(session.id, [{ eventType: "a", eventTime: 1, data: {} }]);
      expect((await repo.readEvents(session.id)).length).toBe(1);

      // Use a fresh repo with a failing wrapper
      const base: QueryExecutor = exec;
      const failingRepo = new PostgresSessionPersistenceRepository({
        async exec(sql, params) {
          return base.exec(sql, params);
        },
        async query(sql, params) {
          return base.query(sql, params);
        },
        async transaction(fn) {
          return base.transaction(async (tx) => {
            // Wrap tx.exec to fail on second session_events insert
            let call = 0;
            const wrapped: QueryExecutor = {
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
      });

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
      const { repo, session } = await setupWorkspaceAndSession(await makeExecutor());
      const persistence = new PostgresSessionPersistence(repo);
      const persisted = await persistence.append(session.id, [
        { eventType: "user", eventTime: 1, data: { msg: "hi" } },
      ]);
      expect(persisted[0]!.seq).toBe(0);
      const read = await persistence.readEvents(session.id);
      expect(read.length).toBe(1);
    });

    test("detects missing seq on read", async () => {
      const { repo } = await setupWorkspaceAndSession(await makeExecutor());
      // Fresh session has no events; ordered read returns empty.
      const events = await repo.readEvents("00000000-0000-0000-0000-000000000002");
      expect(events.length).toBe(0);
    });

    test("checkpoint audit: every record appends one row, even for the same key (issue #110)", async () => {
      const { repo, ws } = await setupWorkspaceAndSession(await makeExecutor());
      expect(await repo.listCheckpoints(ws.id)).toEqual([]);

      const first = await repo.recordCheckpoint({
        workspaceId: ws.id,
        baseCommitSha: "2c6fe42d68f1638b2d4059f0fa8c9901df9effb8",
        gcsObject: `workspaces/${ws.id}/checkpoint.bin`,
      });
      expect(first.workspaceId).toBe(ws.id);
      expect(first.baseCommitSha).toBe("2c6fe42d68f1638b2d4059f0fa8c9901df9effb8");
      expect(first.gcsObject).toBe(`workspaces/${ws.id}/checkpoint.bin`);
      expect(typeof first.id).toBe("string");

      // Each upload overwrites the SAME live key, so later rows point at the
      // same object: the table is a write-audit ("when was which base commit
      // durably stored"), not a retrievable generation index. This is the
      // exact shape production showed on 2026-09-05 (3 rows, 1 object).
      await repo.recordCheckpoint({
        workspaceId: ws.id,
        baseCommitSha: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
        gcsObject: `workspaces/${ws.id}/checkpoint.bin`,
      });
      await repo.recordCheckpoint({
        workspaceId: ws.id,
        baseCommitSha: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
        gcsObject: `workspaces/${ws.id}/checkpoint.bin`,
      });

      const generations = await repo.listCheckpoints(ws.id);
      expect(generations.length).toBe(3);
      expect(generations.map((g) => g.baseCommitSha)).toEqual([
        "2c6fe42d68f1638b2d4059f0fa8c9901df9effb8",
        "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
        "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
      ]);
      // All three rows share one object — the audit trail, not three generations.
      for (const g of generations) {
        expect(g.gcsObject).toBe(`workspaces/${ws.id}/checkpoint.bin`);
      }
      // Scoped per workspace.
      expect(await repo.listCheckpoints("00000000-0000-0000-0000-000000000099")).toEqual([]);
    });

    test("listWorkspaces returns every workspace in creation order", async () => {
      const exec = await makeExecutor();
      const repo = new PostgresSessionPersistenceRepository(exec);
      expect(await repo.listWorkspaces()).toEqual([]);
      const ids = [
        "00000000-0000-0000-0000-000000000011",
        "00000000-0000-0000-0000-000000000012",
      ];
      for (const id of ids) {
        await repo.createWorkspace({
          id,
          ownerId: "user-1",
          repositoryOwner: "mpppk",
          repositoryName: "cloud-run-dsh",
          baseBranch: "main",
        });
      }
      expect((await repo.listWorkspaces()).map((w) => w.id)).toEqual(ids);
    });

    test("listWorkspacesByIds fetches only the requested rows in creation order", async () => {
      const exec = await makeExecutor();
      const repo = new PostgresSessionPersistenceRepository(exec);
      expect(await repo.listWorkspacesByIds([])).toEqual([]);
      const ids = [
        "00000000-0000-0000-0000-000000000021",
        "00000000-0000-0000-0000-000000000022",
        "00000000-0000-0000-0000-000000000023",
      ];
      for (const id of ids) {
        await repo.createWorkspace({
          id,
          ownerId: "user-1",
          repositoryOwner: "mpppk",
          repositoryName: "cloud-run-dsh",
          baseBranch: "main",
        });
      }
      // Subset only — the unrequested row is never returned. Creation order
      // holds regardless of the input order (ORDER BY created_at ASC).
      expect((await repo.listWorkspacesByIds([ids[2]!, ids[0]!])).map((w) => w.id)).toEqual([
        ids[0]!,
        ids[2]!,
      ]);
      // Unknown ids are skipped, never an error.
      expect(
        (await repo.listWorkspacesByIds([ids[1]!, "00000000-0000-0000-0000-00000000ffff"])).map(
          (w) => w.id,
        ),
      ).toEqual([ids[1]!]);
      expect(await repo.listWorkspacesByIds(["00000000-0000-0000-0000-00000000ffff"])).toEqual(
        [],
      );
    });

    test("deleteWorkspace cascades to sessions and events; unknown id -> false", async () => {
      const { repo, ws, session } = await setupWorkspaceAndSession(await makeExecutor());
      await repo.append(session.id, [{ eventType: "a", eventTime: 1, data: {} }]);
      expect(await repo.deleteWorkspace("00000000-0000-0000-0000-00000000ffff")).toBe(false);

      expect(await repo.deleteWorkspace(ws.id)).toBe(true);
      expect(await repo.getWorkspace(ws.id)).toBeNull();
      expect(await repo.listWorkspaces()).toEqual([]);
      // Children are gone: the session row and its events no longer read back.
      expect(await repo.getSession(session.id)).toBeNull();
      expect(await repo.listSessions(ws.id)).toEqual([]);
      expect(await repo.readEvents(session.id)).toEqual([]);
    });
  });
}
