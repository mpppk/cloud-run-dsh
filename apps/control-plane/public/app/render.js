// Conversation rendering rules for the product UI (issue #147).
//
// Plain ES module — no npm dependencies, no bundler, no DOM, no fetch.
// `app.js` (browser) and `bun test` (conversation-render.test.ts) share this
// file, so "what the conversation shows for a recorded event sequence" is
// pinned by tests instead of by eyeballing a browser.
//
// The rule, inverted from the pre-#147 default: an event is shown ONLY when
// this module explicitly says so. Unknown event types — and every internal
// plumbing type (request/*, turn/*, step/*, agent/*, usage-in-chunk,
// tool payloads) — resolve to `{ kind: "hidden" }`, so a future event type
// can never leak raw JSON onto the screen the way #147 did.
//
// Visible kinds:
// - user: the human's own message.
// - assistant: `assistant/message` text parts joined (tool-call-only
//   messages have no readable body and stay hidden).
// - stream: an `assistant/chunk` text-delta fragment. Shown as a live
//   bubble while the turn streams; the closing `assistant/message` replaces
//   it with the final text. Every other chunk type (tool-call deltas,
//   usage, block markers, finish) is hidden — token counts, call ids and
//   argument fragments never reach the screen.
// - tool: a one-line Japanese summary of a `tool/call` (tool name only —
//   never callId / arguments / file paths). `tool/result` bodies are raw
//   file/command output, so they stay hidden; the call line already marks
//   the action and the final assistant text carries the outcome.
// - approval-asked / approval / approval-decided / cancel: owned by the
//   approval-card flow in app.js (#142) — this module only classifies them.
//
// The debug UI (`/`, public/app.js) intentionally keeps raw rendering;
// that division of labour is pinned by test and must not change here.

/**
 * Joins the readable text parts of an `assistant/message` payload.
 * Returns "" when there is no human-readable body (e.g. tool-call-only).
 */
export function assistantTextOf(data) {
  const content = data?.message?.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/**
 * One-line Japanese summary for a `tool/call` payload. Tool name only —
 * callId / arguments / paths never leave this function.
 */
export function toolSummaryOf(data) {
  const name = typeof data?.name === "string" ? data.name : "";
  switch (name) {
    case "read":
      return "ファイルを読みました";
    case "edit":
      return "ファイルを編集しました";
    case "write":
      return "ファイルを作成しました";
    case "glob":
    case "grep":
      return "ファイルを探しました";
    case "bash":
    case "shell":
      return "コマンドを実行しました";
    default:
      return "ツールを使いました";
  }
}

/**
 * Classifies one SSE event for the conversation view. `ev` is the parsed
 * `{ eventType, data }` shape (seq is irrelevant to rendering).
 *
 * Every branch returns; the fallthrough at the end is "hidden" on purpose —
 * allow-listing, not deny-listing (issue #147).
 */
export function describeEvent(ev) {
  const type = ev?.eventType;
  const data = ev?.data;

  if (type === "user_message") {
    const content = data?.content ?? data;
    const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
    return { kind: "user", text };
  }

  if (type === "assistant/message") {
    const text = assistantTextOf(data);
    if (!text) return { kind: "hidden" };
    return { kind: "assistant", text };
  }

  if (type === "assistant/chunk") {
    // Streaming display (issue #147): only text deltas surface, appended to
    // the live bubble by app.js. Usage / tool-call deltas / block markers /
    // finish reasons are internal and stay hidden. Judgement call, recorded
    // here: hiding chunks entirely would also satisfy the acceptance rule
    // (the closing assistant/message always carries the full text), but
    // streaming the deltas keeps long turns visibly alive for the same
    // implementation cost — one branch, no new state shape.
    const chunk = data?.chunk;
    if (chunk && typeof chunk === "object" && chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text) {
      return { kind: "stream", text: chunk.text };
    }
    return { kind: "hidden" };
  }

  if (type === "tool/call") {
    return { kind: "tool", text: toolSummaryOf(data) };
  }

  // tool/result bodies are raw file/command output — never conversation.
  // The tool/call line above already marks the action.
  if (type === "tool/result") return { kind: "hidden" };

  if (type === "approval/asked") return { kind: "approval-asked" };
  if (type === "approval") return { kind: "approval" };
  if (type === "approval/decided") return { kind: "approval-decided" };
  if (type === "cancel") return { kind: "cancel" };

  // Internal plumbing — never conversation:
  // request/* (model names, system prompt, context window), turn/*,
  // step/*, agent/*, usage, and anything not yet invented.
  return { kind: "hidden" };
}
