// Unit tests for the Postgres DSH persistence mapping (issue #39).
// The live write path is unchanged (turn.ts subscription); these prove the
// READ side converts stored rows back to faithful DSH events — and fails
// loud instead of resuming a gutted session.

import { describe, expect, test } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { InMemoryLogger } from "@cloud-run-dsh/observability";
import {
  PostgresSessionPersistenceRepository,
} from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import { SessionPersistenceNotFoundError } from "@deepseek-ai/dsh-session-persistence";
import { SessionId } from "@deepseek-ai/dsh-session";
import { makeConfig } from "./fakes.js";
import { PostgresSessionPersistence, toDshEvents } from "./session-persistence.js";

async function makePersistence(workspaceId = "ws-1") {
  const repository = new PostgresSessionPersistenceRepository(new InMemoryFakeExecutor());
  const config = makeConfig({ workspaceId });
  await repository.createWorkspace({
    id: config.workspaceId,
    ownerId: config.userId,
    repositoryOwner: config.repositoryOwner,
    repositoryName: config.repositoryName,
    baseBranch: config.baseBranch,
  });
  const ctx = new Context();
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SessionStore);
  await ctx.plugin(PostgresSessionPersistence, {
    repository,
    workspaceId: config.workspaceId,
    workspaceRoot: config.workspaceRoot,
    logger: new InMemoryLogger(),
  });
  const persistence = ctx.sessionPersistence;
  return { repository, persistence, ctx };
}

describe("toDshEvents mapping", () => {
  test("user_message is consumed after the first step/start of its turn", async () => {
    const { repository } = await makePersistence();
    await repository.createSession({ id: "s1", workspaceId: "ws-1" });
    await repository.append("s1", [
      { eventType: "user_message", eventTime: 1000, data: { content: "hello" } },
      { eventType: "agent/inbox/spliced", eventTime: 1001, data: { target: "next-turn" } },
      { eventType: "turn/start", eventTime: 1002, data: { turn: 1 } },
      { eventType: "agent/inbox/spliced", eventTime: 1003, data: { target: "next-turn" } },
      { eventType: "step/start", eventTime: 1004, data: { step: 1 } },
      { eventType: "request/header", eventTime: 1005, data: { reason: "initial" } },
    ]);
    const rows = await repository.readEvents("s1");
    const events = toDshEvents("s1", rows);
    const types = events.map((e) => (e as unknown as { type: string }).type);
    // The live loop consumes the message after step/start (measured) — the
    // replay mirrors that order, not the stored row order.
    expect(types).toEqual([
      "agent/inbox/spliced",
      "turn/start",
      "agent/inbox/spliced",
      "step/start",
      "user/message",
      "request/header",
    ]);
    expect(events.map((e) => (e as unknown as { seq: number }).seq)).toEqual([0, 1, 2, 3, 4, 5]);
    const userMsg = events[4] as unknown as {
      data: Record<string, unknown>;
      surfaceOp: unknown;
    };
    expect(userMsg.data).toMatchObject({
      id: "resumed-s1-0",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user" },
    });
    expect(userMsg.surfaceOp).toBe("append");
    // Deterministic: a second load of the same rows agrees exactly.
    expect(toDshEvents("s1", rows)).toEqual(events);
  });

  test("citations resolve by rank to the preceding verbatim rows", async () => {
    const { repository } = await makePersistence();
    await repository.createSession({ id: "s1", workspaceId: "ws-1" });
    await repository.append("s1", [
      { eventType: "user_message", eventTime: 1, data: { content: "hi" } },
      { eventType: "agent/inbox/spliced", eventTime: 2, data: {} },
      { eventType: "turn/start", eventTime: 3, data: { turn: 1 } },
      { eventType: "step/start", eventTime: 4, data: { step: 1 } },
      { eventType: "assistant/chunk", eventTime: 5, data: { turn: 1, step: 1 } },
      {
        eventType: "assistant/message",
        eventTime: 6,
        data: { text: "done" },
        // Stored values are true-space and opaque — rank does the resolving:
        // one cited run -> the one verbatim predecessor (the chunk).
        sourceEventSeqs: [4242],
        surfaceOp: "append",
      },
    ]);
    const events = toDshEvents("s1", await repository.readEvents("s1"));
    expect(events.map((e) => (e as unknown as { type: string }).type)).toEqual([
      "agent/inbox/spliced",
      "turn/start",
      "step/start",
      "user/message",
      "assistant/chunk",
      "assistant/message",
    ]);
    // The chunk sits at replay 4; the citation follows it there.
    expect(events[5]).toMatchObject({ sourceEventSeqs: [4], surfaceOp: "append" });
  });

  test("every replayed citation references an earlier replay seq", async () => {
    const { repository } = await makePersistence();
    await repository.createSession({ id: "s1", workspaceId: "ws-1" });
    await repository.append("s1", [
      { eventType: "user_message", eventTime: 1, data: { content: "first" } },
      { eventType: "turn/start", eventTime: 2, data: { turn: 1 } },
      { eventType: "step/start", eventTime: 3, data: { step: 1 } },
      { eventType: "assistant/chunk", eventTime: 4, data: { turn: 1, step: 1 } },
      {
        eventType: "assistant/message",
        eventTime: 5,
        data: { text: "one" },
        sourceEventSeqs: [77],
        surfaceOp: "append",
      },
      { eventType: "turn/end", eventTime: 6, data: { turn: 1 } },
      { eventType: "user_message", eventTime: 7, data: { content: "second" } },
      { eventType: "turn/start", eventTime: 8, data: { turn: 2 } },
      { eventType: "step/start", eventTime: 9, data: { step: 1 } },
    ]);
    const events = toDshEvents("s1", await repository.readEvents("s1"));
    const types = events.map((e) => (e as unknown as { type: string }).type);
    expect(types).toEqual([
      "turn/start",
      "step/start",
      "user/message",
      "assistant/chunk",
      "assistant/message",
      "turn/end",
      "turn/start",
      "step/start",
      "user/message",
    ]);
    for (const [index, e] of events.entries()) {
      const cited = (e as unknown as { sourceEventSeqs?: number[] }).sourceEventSeqs ?? [];
      for (const c of cited) {
        expect(c).toBeLessThan(index);
      }
    }
    expect(events[4]).toMatchObject({ sourceEventSeqs: [3] });
  });

  test("a measured live 2-step turn replays with valid citations", async () => {
    // Stored rows copied from a real scripted-adapter TOOL turn (write tool
    // + closing reply): 25 rows. The second message cites [18..22] while a
    // text-only turn's cites [19..23] — the snapshot count varies per step,
    // which is why citations resolve by rank, not by value.
    const { repository } = await makePersistence();
    await repository.createSession({ id: "s1", workspaceId: "ws-1" });
    const chunk = (t: number) => ({ eventType: "assistant/chunk", eventTime: t, data: {} });
    await repository.append("s1", [
      { eventType: "user_message", eventTime: 1, data: { content: "hi" } },
      { eventType: "agent/inbox/spliced", eventTime: 2, data: {} },
      { eventType: "turn/start", eventTime: 3, data: { turn: 1 } },
      { eventType: "agent/inbox/spliced", eventTime: 4, data: {} },
      { eventType: "step/start", eventTime: 5, data: { step: 1 } },
      { eventType: "request/header", eventTime: 6, data: { reason: "initial" } },
      { eventType: "request/context", eventTime: 7, data: {} },
      chunk(8),
      chunk(9),
      chunk(10),
      chunk(11),
      chunk(12),
      {
        eventType: "assistant/message",
        eventTime: 13,
        data: {},
        sourceEventSeqs: [8, 9, 10, 11, 12],
        surfaceOp: "append",
      },
      { eventType: "tool/call", eventTime: 14, data: {} },
      {
        eventType: "tool/result",
        eventTime: 15,
        data: {},
        sourceEventSeqs: [14],
        surfaceOp: "append",
      },
      { eventType: "step/end", eventTime: 16, data: {} },
      { eventType: "step/start", eventTime: 17, data: { step: 2 } },
      chunk(18),
      chunk(19),
      chunk(20),
      chunk(21),
      chunk(22),
      {
        eventType: "assistant/message",
        eventTime: 23,
        data: {},
        sourceEventSeqs: [18, 19, 20, 21, 22],
        surfaceOp: "append",
      },
      { eventType: "step/end", eventTime: 24, data: {} },
      { eventType: "turn/end", eventTime: 25, data: { turn: 1 } },
    ]);
    const events = toDshEvents("s1", await repository.readEvents("s1"));
    // 25 rows in, 1 user text replayed (snapshots are regenerated live),
    // approval/cancel-free: 25 events out.
    expect(events).toHaveLength(25);
    // Every citation points strictly backwards in replay space.
    for (const [index, e] of events.entries()) {
      const cited = (e as unknown as { sourceEventSeqs?: number[] }).sourceEventSeqs ?? [];
      for (const c of cited) {
        expect(c, `event ${index} cites ${c}`).toBeLessThan(index);
      }
    }
    // The formerly self-citing message now cites its five chunks.
    const firstMessage = events.find(
      (e) => (e as unknown as { type: string }).type === "assistant/message",
    ) as unknown as { sourceEventSeqs: number[] };
    expect(firstMessage.sourceEventSeqs).toHaveLength(5);
  });

  test("approval/cancel rows are dropped (they never entered the DSH log)", async () => {
    const { repository } = await makePersistence();
    await repository.createSession({ id: "s1", workspaceId: "ws-1" });
    await repository.append("s1", [
      { eventType: "user_message", eventTime: 1, data: { content: "hi" } },
      { eventType: "approval", eventTime: 2, data: { approvalId: "a", decision: "approved" } },
      { eventType: "cancel", eventTime: 3, data: { cancelledBy: "alice" } },
      { eventType: "turn/start", eventTime: 4, data: { turn: 1 } },
    ]);
    const events = toDshEvents("s1", await repository.readEvents("s1"));
    expect(events.map((e) => (e as unknown as { type: string }).type)).toEqual([
      "turn/start",
      "user/message",
    ]);
  });

  test("approval audit rows between call and result do not disturb the citation", async () => {
    // The measured live shape: tool/call … approval/asked … approval (CP row,
    // dropped) … approval/decided … tool/result citing the call.
    const { repository } = await makePersistence();
    await repository.createSession({ id: "s1", workspaceId: "ws-1" });
    await repository.append("s1", [
      { eventType: "user_message", eventTime: 1, data: { content: "hi" } },
      { eventType: "turn/start", eventTime: 2, data: { turn: 1 } },
      { eventType: "step/start", eventTime: 3, data: { step: 1 } },
      { eventType: "tool/call", eventTime: 4, data: {} },
      { eventType: "approval/asked", eventTime: 5, data: { id: "ask-1" } },
      {
        eventType: "approval",
        eventTime: 6,
        data: { approvalId: "ask-1", decision: "rejected" },
      },
      { eventType: "approval/decided", eventTime: 7, data: { id: "ask-1" } },
      {
        eventType: "tool/result",
        eventTime: 8,
        data: {},
        sourceEventSeqs: [999],
        surfaceOp: "append",
      },
    ]);
    const events = toDshEvents("s1", await repository.readEvents("s1"));
    const types = events.map((e) => (e as unknown as { type: string }).type);
    expect(types).toEqual([
      "turn/start",
      "step/start",
      "user/message",
      "tool/call",
      "approval/asked",
      "approval/decided",
      "tool/result",
    ]);
    const result = events[6] as unknown as { sourceEventSeqs: number[] };
    // Resolves across the audit pair to the call at replay 3.
    expect(result.sourceEventSeqs).toEqual([3]);
  });

  test("unconsumed tail messages trail at the end as pending history", async () => {
    const { repository } = await makePersistence();
    await repository.createSession({ id: "s1", workspaceId: "ws-1" });
    await repository.append("s1", [
      { eventType: "turn/start", eventTime: 1, data: { turn: 1 } },
      { eventType: "turn/end", eventTime: 2, data: { turn: 1 } },
      { eventType: "user_message", eventTime: 3, data: { content: "pending" } },
    ]);
    const events = toDshEvents("s1", await repository.readEvents("s1"));
    expect(events.map((e) => (e as unknown as { type: string }).type)).toEqual([
      "turn/start",
      "turn/end",
      "user/message",
    ]);
  });

  test("corrupt user_message (non-text content) throws instead of resuming gutted", async () => {
    const { repository } = await makePersistence();
    await repository.createSession({ id: "s1", workspaceId: "ws-1" });
    await repository.append("s1", [
      { eventType: "user_message", eventTime: 1, data: { content: 42 } },
    ]);
    expect(() => toDshEvents("s1", [])).not.toThrow();
    await expect(
      (async () => toDshEvents("s1", await repository.readEvents("s1")))(),
    ).rejects.toThrow(/corrupt user_message/);
  });
});

describe("PostgresSessionPersistence service", () => {
  test("load returns header + events; missing session is not-found (never empty)", async () => {
    const { repository, persistence } = await makePersistence();
    await repository.createSession({ id: "s1", workspaceId: "ws-1" });
    await repository.append("s1", [
      { eventType: "user_message", eventTime: 1000, data: { content: "hi" } },
      { eventType: "turn/start", eventTime: 1001, data: { turn: 1 } },
    ]);
    const loaded = await persistence.load(SessionId("s1"));
    expect(loaded.meta.id).toBe("s1");
    expect(loaded.meta.cwd).toBe("/workspace");
    expect(loaded.events).toHaveLength(2);

    await expect(persistence.load(SessionId("nope"))).rejects.toBeInstanceOf(
      SessionPersistenceNotFoundError,
    );
  });

  test("foreign-workspace sessions are refused", async () => {
    const { repository, persistence } = await makePersistence("ws-1");
    await repository.createWorkspace({
      id: "ws-other",
      ownerId: "u",
      repositoryOwner: "o",
      repositoryName: "r",
      baseBranch: "main",
    });
    await repository.createSession({ id: "s-foreign", workspaceId: "ws-other" });
    await expect(persistence.load(SessionId("s-foreign"))).rejects.toThrow(/belongs to workspace/);
  });

  test("registers as ctx.sessionPersistence (the AgentLoop.resume source)", async () => {
    const { ctx } = await makePersistence();
    expect(ctx.sessionPersistence).toBeDefined();
  });

  test("append honors the user/message single-writer filter", async () => {
    const { repository, persistence } = await makePersistence();
    await repository.createSession({ id: "s1", workspaceId: "ws-1" });
    await persistence.append(SessionId("s1"), [
      {
        type: "user/message",
        seq: 0,
        time: 1,
        data: { content: "must not duplicate" },
      } as unknown as never,
      { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } } as unknown as never,
    ]);
    const rows = await repository.readEvents("s1");
    // Only the turn event landed — the user/message copy was filtered.
    expect(rows.map((r) => r.eventType)).toEqual(["turn/start"]);
  });

  test("list/listSnapshots cover the workspace sessions with changing revisions", async () => {
    const { repository, persistence } = await makePersistence();
    await repository.createSession({ id: "s1", workspaceId: "ws-1" });
    const before = await persistence.listSnapshots();
    expect(before.map((s) => s.header.id)).toEqual(["s1"]);
    await repository.append("s1", [
      { eventType: "user_message", eventTime: 1, data: { content: "hi" } },
    ]);
    const after = await persistence.listSnapshots();
    expect(after[0]!.revision).not.toBe(before[0]!.revision);
    expect((await persistence.list()).map((h) => h.id)).toEqual(["s1"]);
  });
});
