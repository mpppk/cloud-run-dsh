// Turn starter tests (issue #21) — drive a full agent turn through the REAL
// harness composition (tool-fs write executes for real inside a temp
// workspace) with a scripted fake LLM adapter (zero network).
//
// What each test proves:
//   - basic turn: user message → model tool call → file written → assistant
//     reply, all visible as Postgres events, with NO `user_message` duplicate.
//   - cancel: cancelTurn aborts the live turn (the adapter sees the abort).
//   - approval: a live `approval.request` pends in the starter's answerer and
//     settles via resolveApproval; the audit pair reaches Postgres.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryLogger } from "@cloud-run-dsh/observability";
import {
  PostgresSessionPersistenceRepository,
} from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import { LlmAdapter, ToolCallId } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import { makeConfig } from "./fakes.js";
import { HarnessTurnStarter, LLM_PROVIDER_ROUTE } from "./turn.js";

const TEST_MODEL = "test-fake-model";

type ChunkStep = () => AsyncIterable<StreamChunk>;

function textReply(text: string): ChunkStep {
  return async function* () {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: "finish", reason: { kind: "stop" } };
  };
}

function writeCall(callId: string, filePath: string, content: string): ChunkStep {
  return async function* () {
    const id = ToolCallId(callId);
    const args = JSON.stringify({ file_path: filePath, content });
    yield { type: "block-start", index: 0, blockType: "tool-call" };
    yield { type: "tool-call-delta", index: 0, id, name: "write", argumentsDelta: args };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id, name: "write", arguments: args },
    };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: "finish", reason: { kind: "tool-calls" } };
  };
}

/** Scripted fake adapter: pops one script step per model call, records calls. */
class ScriptedFakeAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  readonly script: ChunkStep[] = [];
  readonly fallback: ChunkStep = textReply("(no scripted step left)");

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "test-fake" };
  }

  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined;
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [{ provider, id: TEST_MODEL, name: TEST_MODEL }];
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model };
  }

  async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    yield* (this.script.shift() ?? this.fallback)();
  }
}

async function waitFor(
  cond: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface TurnFixture {
  readonly starter: HarnessTurnStarter;
  readonly repository: PostgresSessionPersistenceRepository;
  readonly adapter: ScriptedFakeAdapter;
  readonly workspaceRoot: string;
  seedSession(sessionId: string): Promise<void>;
}

async function makeStarter(): Promise<TurnFixture> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "turn-test-"));
  const repository = new PostgresSessionPersistenceRepository(new InMemoryFakeExecutor());
  const adapter = new ScriptedFakeAdapter();
  const config = makeConfig({ workspaceRoot, llmModel: TEST_MODEL });
  await repository.createWorkspace({
    id: config.workspaceId,
    ownerId: config.userId,
    repositoryOwner: config.repositoryOwner,
    repositoryName: config.repositoryName,
    baseBranch: config.baseBranch,
  });
  const starter = await HarnessTurnStarter.create({
    config,
    repository,
    logger: new InMemoryLogger(),
    llmTestAdapter: adapter,
  });
  return {
    starter,
    repository,
    adapter,
    workspaceRoot,
    async seedSession(sessionId: string): Promise<void> {
      await repository.createSession({ id: sessionId, workspaceId: config.workspaceId });
    },
  };
}

describe("HarnessTurnStarter", () => {
  test("one turn runs the model, executes the write tool, and persists events", async () => {
    const fx = await makeStarter();
    const sessionId = "sess-turn-1";
    await fx.seedSession(sessionId);
    fx.adapter.script.push(
      writeCall("call-write-1", "notes.txt", "hi from the model"),
      textReply("done"),
    );

    // startTurn enqueues and returns promptly — well before the turn finishes.
    await fx.starter.startTurn({ workspaceId: "ws-1", sessionId, seq: 0, content: "write notes" });
    const agent = fx.starter.agentFor(sessionId);
    expect(agent).toBeDefined();

    await waitFor(async () => {
      const events = await fx.repository.readEvents(sessionId);
      return events.some(
        (e) => e.eventType === "assistant/message" && JSON.stringify(e.data).includes("done"),
      );
    }, 20_000, "assistant reply in Postgres");

    // The model-facing write tool ran for real inside the temp workspace.
    const written = await readFile(join(fx.workspaceRoot, "notes.txt"), "utf8");
    expect(written).toContain("hi from the model");

    const events = await fx.repository.readEvents(sessionId);
    const types = events.map((e) => e.eventType);
    // Turn/step boundaries, the tool call + result, and the final reply.
    expect(types).toContain("turn/start");
    expect(types).toContain("assistant/message");
    expect(types).toContain("tool/result");
    // The control plane owns `user_message` — the host must not duplicate it.
    expect(types).not.toContain("user/message");
    expect(types).not.toContain("user_message");
    // Two model calls: tool call, then the closing text reply.
    expect(fx.adapter.calls).toHaveLength(2);
    // Both calls rode the configured provider route + model.
    for (const call of fx.adapter.calls) {
      expect(call.provider).toBe(LLM_PROVIDER_ROUTE);
      expect(call.model).toBe(TEST_MODEL);
    }
  });

  test("cancelTurn aborts the live turn; unknown sessions cancel nothing", async () => {
    const fx = await makeStarter();
    const sessionId = "sess-cancel-1";
    await fx.seedSession(sessionId);
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    fx.adapter.script.push(async function* () {
      yield { type: "block-start", index: 0, blockType: "text" };
      await gate;
      yield { type: "text-delta", index: 0, text: "too late" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "too late" } };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: "finish", reason: { kind: "stop" } };
    });

    expect(await fx.starter.cancelTurn("sess-unknown")).toBe(0);
    await fx.starter.startTurn({ workspaceId: "ws-1", sessionId, seq: 0, content: "slow" });
    await waitFor(() => fx.starter.agentFor(sessionId)?.status === "running", 10_000, "running");
    // Cancel mid-stream (not during pre-step): the adapter must observe the abort.
    await waitFor(() => fx.adapter.calls.length >= 1, 10_000, "first model call");

    expect(await fx.starter.cancelTurn(sessionId)).toBe(1);
    // The in-flight model call observes the abort.
    await waitFor(() => fx.adapter.calls[0]?.signal.aborted === true, 10_000, "adapter abort");
    releaseGate();
  });

  test("a live approval ask pends until resolveApproval settles it", async () => {    const fx = await makeStarter();
    const sessionId = "sess-approval-1";
    await fx.seedSession(sessionId);
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    fx.adapter.script.push(async function* () {
      yield { type: "block-start", index: 0, blockType: "text" };
      await gate;
      yield { type: "text-delta", index: 0, text: "approved-flow" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "approved-flow" } };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: "finish", reason: { kind: "stop" } };
    });

    expect(await fx.starter.resolveApproval("no-such-ask", "approved")).toBe(false);

    await fx.starter.startTurn({ workspaceId: "ws-1", sessionId, seq: 0, content: "needs ok" });
    // The ask must happen inside an open turn.
    await waitFor(async () => {
      const events = await fx.repository.readEvents(sessionId);
      return events.some((e) => e.eventType === "turn/start");
    }, 10_000, "open turn");

    const agent = fx.starter.agentFor(sessionId);
    expect(agent).toBeDefined();
    const callId = ToolCallId("call-appr-1");
    // Property access enforces inject on scoped contexts; .get() does not.
    const approval = agent!.ctx.get("approval");
    expect(approval).toBeDefined();
    const pending = approval!.request({
      agent: agent!,
      toolName: "test-tool",
      reason: "test needs a decision",
      callId,
    });
    // Give the answerer a chance to pend (the outcome promise must not settle early).
    let settled: ApprovalOutcome | null = null;
    void pending.then((o) => (settled = o));
    await new Promise((r) => setTimeout(r, 200));
    expect(settled).toBeNull();

    expect(await fx.starter.resolveApproval(String(callId), "approved")).toBe(true);
    await expect(pending).resolves.toBe("allowed-once");

    // The audit pair reached Postgres.
    await waitFor(async () => {
      const events = await fx.repository.readEvents(sessionId);
      return events.some((e) => e.eventType === "approval/decided");
    }, 10_000, "approval audit in Postgres");
    const events = await fx.repository.readEvents(sessionId);
    expect(events.map((e) => e.eventType)).toContain("approval/asked");

    releaseGate();
    await waitFor(async () => {
      const evts = await fx.repository.readEvents(sessionId);
      return evts.some(
        (e) => e.eventType === "assistant/message" && JSON.stringify(e.data).includes("approved-flow"),
      );
    }, 10_000, "turn completion after approval");
  });
});

describe("HarnessTurnStarter.resumeSessions (issue #39)", () => {
  /** A fresh starter sharing the SAME repository: simulates a new process after restart. */
  async function restartStarter(fx: TurnFixture): Promise<{
    starter: HarnessTurnStarter;
    adapter: ScriptedFakeAdapter;
  }> {
    const adapter = new ScriptedFakeAdapter();
    const starter = await HarnessTurnStarter.create({
      config: makeConfig({ workspaceRoot: fx.workspaceRoot, llmModel: TEST_MODEL }),
      repository: fx.repository,
      logger: new InMemoryLogger(),
      llmTestAdapter: adapter,
    });
    return { starter, adapter };
  }

  async function runCompletedTurn(fx: TurnFixture, sessionId: string): Promise<void> {
    await fx.repository.append(sessionId, [
      { eventType: "user_message", eventTime: Date.now(), data: { content: "write notes" } },
    ]);
    fx.adapter.script.push(
      writeCall("call-write-1", "notes.txt", "hi from the model"),
      textReply("done"),
    );
    await fx.starter.startTurn({ workspaceId: "ws-1", sessionId, seq: 0, content: "write notes" });
    await waitFor(async () => {
      const events = await fx.repository.readEvents(sessionId);
      return events.some((e) => e.eventType === "turn/end");
    }, 20_000, "turn completion in Postgres");
  }

  test("resumes the agent with history intact and continues the conversation", async () => {
    const fx = await makeStarter();
    const sessionId = "sess-resume-1";
    await fx.seedSession(sessionId);
    await runCompletedTurn(fx, sessionId);
    const eventsBefore = await fx.repository.readEvents(sessionId);
    expect(eventsBefore.map((e) => e.eventType)).toContain("assistant/message");

    // ---- simulated restart ----
    const { starter: starter2, adapter: adapter2 } = await restartStarter(fx);
    expect(starter2.agentFor(sessionId)).toBeUndefined();

    const { resumed } = await starter2.resumeSessions([sessionId]);
    expect(resumed).toEqual([sessionId]);
    expect(starter2.agentFor(sessionId)).toBeDefined();

    // Resume replays stored history — it must not append duplicates.
    expect(await fx.repository.readEvents(sessionId)).toHaveLength(eventsBefore.length);

    // The next turn sees the resumed history: the model's first request
    // carries the earlier user text AND the earlier assistant reply.
    adapter2.script.push(textReply("second done"));
    const seq = (await fx.repository.readEvents(sessionId)).length;
    await starter2.startTurn({ workspaceId: "ws-1", sessionId, seq, content: "again" });
    await waitFor(async () => {
      const events = await fx.repository.readEvents(sessionId);
      return events.some(
        (e) => e.eventType === "assistant/message" && JSON.stringify(e.data).includes("second done"),
      );
    }, 20_000, "second turn completion after resume");
    expect(adapter2.calls.length).toBeGreaterThanOrEqual(1);
    const firstMessages = JSON.stringify(adapter2.calls[0]!.messages);
    expect(firstMessages).toContain("write notes");
    expect(firstMessages).toContain("done");
  });

  test("unknown session ids reject — never silently create an empty agent", async () => {
    const fx = await makeStarter();
    const { starter: starter2 } = await restartStarter(fx);
    await expect(starter2.resumeSessions(["no-such-session"])).rejects.toThrow(
      /no-such-session.*not found|not found.*no-such-session/,
    );
    expect(starter2.agentFor("no-such-session")).toBeUndefined();
  });

  test("an empty session list resumes nothing", async () => {
    const fx = await makeStarter();
    const { starter: starter2 } = await restartStarter(fx);
    await expect(starter2.resumeSessions([])).resolves.toEqual({ resumed: [] });
  });

  test("already-live sessions are skipped, not double-resumed", async () => {
    const fx = await makeStarter();
    const sessionId = "sess-resume-live";
    await fx.seedSession(sessionId);
    await runCompletedTurn(fx, sessionId);
    const { starter: starter2 } = await restartStarter(fx);
    await starter2.resumeSessions([sessionId]);
    await expect(starter2.resumeSessions([sessionId])).resolves.toEqual({ resumed: [] });
    expect(starter2.agentFor(sessionId)).toBeDefined();
  });

  test("resumes mid-turn after a crash: the open turn restores without failing", async () => {
    const fx = await makeStarter();
    const sessionId = "sess-resume-crash";
    await fx.seedSession(sessionId);
    await fx.repository.append(sessionId, [
      { eventType: "user_message", eventTime: Date.now(), data: { content: "slow" } },
    ]);
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    fx.adapter.script.push(async function* () {
      yield { type: "block-start", index: 0, blockType: "text" };
      await gate;
      yield { type: "text-delta", index: 0, text: "late" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "late" } };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    await fx.starter.startTurn({ workspaceId: "ws-1", sessionId, seq: 0, content: "slow" });
    // The turn opened but the model stream is stuck: this is the crash shape
    // (stored log ends mid-turn, no turn/end).
    await waitFor(async () => {
      const events = await fx.repository.readEvents(sessionId);
      return events.some((e) => e.eventType === "step/start");
    }, 10_000, "open turn in Postgres");
    expect(
      (await fx.repository.readEvents(sessionId)).some((e) => e.eventType === "turn/end"),
    ).toBe(false);

    // The old process dies here (gate never released on fx's side).
    const { starter: starter2 } = await restartStarter(fx);
    const { resumed } = await starter2.resumeSessions([sessionId]);
    expect(resumed).toEqual([sessionId]);
    expect(starter2.agentFor(sessionId)).toBeDefined();

    releaseGate();
  });
});
