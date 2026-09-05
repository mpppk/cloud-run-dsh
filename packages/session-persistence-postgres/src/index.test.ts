import { describe, test, expect } from "bun:test";
import { InMemoryFakeExecutor } from "./fakeExecutor.js";
import { PLACEHOLDER_KIND, createPlaceholder } from "./index.js";
import { defineRepositorySuite } from "./repository.suite.js";

describe("session-persistence-postgres placeholder", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("session-persistence-postgres");
    expect(createPlaceholder().kind).toBe("session-persistence-postgres");
  });
});

defineRepositorySuite(
  "session-persistence-postgres (fake)",
  () => new InMemoryFakeExecutor(),
  { enforceAppendOnlyRejection: true },
);

describe("InMemoryFakeExecutor SQL fidelity (issue #70)", () => {
  test("rejects locking clause with aggregate function, like PostgreSQL does", async () => {
    const exec = new InMemoryFakeExecutor();
    // The exact query shape that reached production and failed there with
    // "FOR UPDATE is not allowed with aggregate functions" must fail here too.
    await expect(
      exec.query("SELECT max(seq) as max FROM session_events WHERE session_id = $1 FOR UPDATE", ["x"]),
    ).rejects.toThrow(/rejected by PostgreSQL/);
    await expect(
      exec.query("SELECT count(*) FROM session_events WHERE session_id = $1 FOR UPDATE", ["x"]),
    ).rejects.toThrow(/rejected by PostgreSQL/);
  });

  test("still accepts the valid replacements", async () => {
    const exec = new InMemoryFakeExecutor();
    // Plain aggregate (no locking clause) — used by the fixed append path.
    await expect(
      exec.query("SELECT max(seq) as max FROM session_events WHERE session_id = $1", ["x"]),
    ).resolves.toEqual([{ max: null }]);
    // Locking clause without aggregate — parent-row lock used by the fixed append path.
    // (No sessions row exists, so it resolves to zero rows rather than throwing.)
    await expect(
      exec.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", ["x"]),
    ).resolves.toEqual([]);
  });
});
