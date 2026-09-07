// Conversation rendering rules (issue #147): the product UI must never
// show raw internal-event JSON.
//
// Strategy: the recorded production sequence
// (`testdata/g2-sse-reference.txt` — one full turn captured from the live
// GCP agent-host, secrets-free) is parsed and run through the SAME
// `describeEvent` the browser executes (`public/app/render.js`, imported
// directly — it has no DOM/fetch imports). This pins "what the screen
// shows for what actually flowed" instead of eyeballing a browser.
//
// Pre-#147 behaviour for this exact sequence was 47 msg-system + 4 msg-tool
// + 3 msg-assistant of raw JSON and zero readable bodies.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assistantTextOf, describeEvent, toolSummaryOf } from "../public/app/render.js";
import { parseRecordedSse, type RecordedEvent } from "./dev.js";

const FIXTURE = join(import.meta.dir, "..", "testdata", "g2-sse-reference.txt");

type FixtureEvent = RecordedEvent;

async function loadFixture(): Promise<FixtureEvent[]> {
  return parseRecordedSse(await Bun.file(FIXTURE).text());
}

describe("issue #147: recorded production sequence renders zero raw JSON", () => {
  test("fixture is the full real turn (71 events, secrets-free)", async () => {
    const events = await loadFixture();
    expect(events.length).toBe(71);
    const types = events.map((e) => e.eventType);
    for (const want of [
      "user_message",
      "turn/start",
      "step/start",
      "request/header",
      "request/context",
      "assistant/chunk",
      "assistant/message",
      "tool/call",
      "tool/result",
      "step/end",
      "turn/end",
    ]) {
      expect(types).toContain(want);
    }
    expect(events.filter((e) => e.eventType === "assistant/chunk").length).toBe(51);
  });

  test("classification counts: 1 user + 1 assistant + 10 stream + 2 tool, rest hidden", async () => {
    const events = await loadFixture();
    const kinds = events.map((e) => describeEvent(e).kind);
    const count = (k: string): number => kinds.filter((x) => x === k).length;
    expect(count("user")).toBe(1);
    expect(count("assistant")).toBe(1);
    expect(count("stream")).toBe(10);
    expect(count("tool")).toBe(2);
    expect(count("hidden")).toBe(57);
  });

  test("the agent's reply body is readable (assistant/message text)", async () => {
    const events = await loadFixture();
    const assistants = events
      .map((e) => describeEvent(e))
      .filter((d) => d.kind === "assistant");
    expect(assistants.length).toBe(1);
    expect((assistants[0] as { text: string }).text).toContain("追加しました");
  });

  test("stream fragments reassemble to the final reply", async () => {
    const events = await loadFixture();
    const streamed = events
      .map((e) => describeEvent(e))
      .filter((d) => d.kind === "stream")
      .map((d) => (d as { text: string }).text)
      .join("");
    const final = events
      .map((e) => describeEvent(e))
      .filter((d) => d.kind === "assistant")
      .map((d) => (d as { text: string }).text)
      .join("");
    // The deltas carry the same reply the closing message settles on —
    // streaming shows the answer early, the message settles it exactly.
    expect(streamed).toContain("追加しました");
    expect(final).toBe(streamed);
  });

  test("no visible text leaks internals or raw JSON", async () => {
    const events = await loadFixture();
    const visible = events
      .map((e) => describeEvent(e))
      .filter((d) => "text" in d)
      .map((d) => (d as { text: string }).text);
    expect(visible.length).toBe(14); // 1 user + 1 assistant + 10 stream + 2 tool
    const joined = visible.join("\n");
    // Raw-JSON shape never reaches the screen.
    expect(joined).not.toContain('{"');
    // Internal vocabulary from the recorded payloads stays internal.
    for (const word of [
      "deepseek",
      "maxTokens",
      "contextWindow",
      "inputTokens",
      "outputTokens",
      "callId",
      "call_c302",
      "call_445e",
      "reasoningEffort",
      "system prompt",
    ]) {
      expect(joined).not.toContain(word);
    }
    // turn/step counters and provider names are plumbing, not conversation.
    expect(joined).not.toMatch(/\bprovider\b/);
    expect(joined).not.toMatch(/"turn"/);
    expect(joined).not.toMatch(/"step"/);
  });

  test("tool summaries name the action, never the payload", async () => {
    const events = await loadFixture();
    const tools = events
      .map((e) => describeEvent(e))
      .filter((d) => d.kind === "tool")
      .map((d) => (d as { text: string }).text);
    expect(tools).toEqual(["ファイルを読みました", "ファイルを編集しました"]);
  });
});

describe("issue #147: default is hidden (allow-list, not deny-list)", () => {
  test("internal plumbing stays hidden", () => {
    const hiddenTypes = [
      "request/header",
      "request/context",
      "turn/start",
      "turn/end",
      "step/start",
      "step/end",
      "agent/inbox/spliced",
      "tool/result",
      "usage",
    ];
    for (const eventType of hiddenTypes) {
      expect(describeEvent({ eventType, data: { turn: 1, step: 1 } }).kind).toBe("hidden");
    }
  });

  test("every non-text chunk type stays hidden", () => {
    for (const chunk of [
      { type: "block-start", index: 0, blockType: "tool-call" },
      { type: "tool-call-delta", index: 0, id: "call_x", name: "read", argumentsDelta: '{"a":1}' },
      { type: "block-end", index: 0, block: { type: "tool-call" } },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "finish", reason: { kind: "tool-calls" } },
      { type: "text-delta", index: 0, text: "" },
    ]) {
      expect(describeEvent({ eventType: "assistant/chunk", data: { turn: 1, step: 1, chunk } }).kind).toBe(
        "hidden",
      );
    }
  });

  test("tool-call-only assistant/message has no readable body, stays hidden", () => {
    expect(
      describeEvent({
        eventType: "assistant/message",
        data: {
          turn: 1,
          step: 1,
          message: {
            role: "assistant",
            content: [{ type: "tool-call", id: "call_x", name: "read", arguments: "{}" }],
          },
        },
      }).kind,
    ).toBe("hidden");
    expect(assistantTextOf({ message: { content: [] } })).toBe("");
    expect(assistantTextOf(null)).toBe("");
  });

  test("unknown event types — including future ones — are hidden", () => {
    for (const eventType of [
      "mystery/new-thing",
      "assistant/summary",
      "billing/receipt",
      "USER_MESSAGE",
      "",
      null,
      undefined,
    ]) {
      expect(describeEvent({ eventType: eventType as string, data: { hello: "world" } }).kind).toBe(
        "hidden",
      );
    }
  });

  test("unknown tool names fall back to a payload-free summary", () => {
    expect(toolSummaryOf({ name: "quantum-compute", callId: "call_secret", arguments: "{}" })).toBe(
      "ツールを使いました",
    );
    expect(toolSummaryOf({})).toBe("ツールを使いました");
    expect(toolSummaryOf(null)).toBe("ツールを使いました");
  });

  test("approval + cancel classification still routes to the #142 cards", () => {
    expect(describeEvent({ eventType: "approval/asked", data: {} }).kind).toBe("approval-asked");
    expect(describeEvent({ eventType: "approval", data: {} }).kind).toBe("approval");
    expect(describeEvent({ eventType: "approval/decided", data: {} }).kind).toBe("approval-decided");
    expect(describeEvent({ eventType: "cancel", data: {} }).kind).toBe("cancel");
  });
});

describe("issue #147: product app.js renders only classified text", () => {
  test("no raw-JSON fallback remains in the conversation path", async () => {
    const js = await Bun.file(join(import.meta.dir, "..", "public", "app", "app.js")).text();
    // The pre-#147 shortText JSON.stringify(data) fallback is gone; the
    // only JSON.stringify left is the fetch request body in api().
    expect(js).not.toContain("JSON.stringify(data)");
    expect(js).toContain('from "./render.js"');
    // describeEvent is total: renderEvent handles every kind it returns.
    for (const kind of ["hidden", "user", "assistant", "stream", "tool", "cancel", "approval"]) {
      expect(js).toContain(`"${kind}"`);
    }
  });

  test("served /app/render.js is the tested file, and ships with the three", async () => {
    const disk = await Bun.file(join(import.meta.dir, "..", "public", "app", "render.js")).text();
    expect(disk).toContain("export function describeEvent");
    for (const file of ["index.html", "app.js", "render.js", "app.css"]) {
      expect(await Bun.file(join(import.meta.dir, "..", "public", "app", file)).exists()).toBe(true);
    }
  });

  test("debug UI (/) still renders raw events — the division of labour", async () => {
    const js = await Bun.file(join(import.meta.dir, "..", "public", "app.js")).text();
    expect(js).toContain("JSON.stringify(ev.data)");
    expect(js).toContain("ev-unknown");
  });
});
