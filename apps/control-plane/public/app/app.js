// Product UI (issue #138). Plain ES module — no npm dependencies, no bundler.
//
// One document, two screens: `/app` (home: workspace list + start) and
// `/app?ws=<id>` (conversation). The query string drives the screen; the
// pathname stays `/app` because the static allowlist serves exact paths
// only (dynamic `/app/<id>` pathnames are never served).
//
// What this screen deliberately does NOT do:
// - no auth header inputs (in production IAP injects them; locally the dev
//   server's fake IAP stands in — see src/dev.ts). fetch() sends no custom
//   auth headers at all, so the same file works under IAP untouched.
// - no controller acquire / heartbeat / release calls: the server lines up
//   single-writer ownership on prepare and the agent-host keeps it alive.
//   When a write still meets a 409 with nobody holding the role (lapsed
//   ownership — e.g. the dev server has no agent-host keep-alive), the
//   screen prepares once more and retries the write once.
//   Read-only state comes from GET .../controller's {held, mine} only.
// - no polling route that extends the idle timer (spec section 11): the
//   timers below only hit GET workspace, GET controller and the SSE stream
//   (plus the one-shot list/sessions reads) — all recordActivity-free.
// - every prepare-then-send happens behind one button: the user never sees
//   startup or single-writer internals, only Japanese status words.
//
// The event stream is read with fetch + ReadableStream (NOT the built-in
// browser SSE client, which cannot attach custom headers), parsing through
// the shared ./sse.js module (same file the debug UI imports).

import { createSseParser, parseSseChunks } from "./sse.js";
import { describeEvent } from "./render.js";

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body: status alone is the signal
  }
  return { status: res.status, json };
}

function wsPath(id, suffix) {
  return `/v1/workspaces/${encodeURIComponent(id)}${suffix ?? ""}`;
}

// ---------------------------------------------------------------------------
// Status words (server state names never reach the screen)
// ---------------------------------------------------------------------------

const SETTLED_USABLE = new Set(["READY", "BUSY", "CHECKPOINTING"]);
const TRANSIENT = new Set(["STARTING", "RESTORING", "STOPPING"]);
const FAILED = new Set(["RESTORE_FAILED", "ERROR", "CHECKPOINT_FAILED"]);

function statusWord(state) {
  if (state === "READY") return { text: "使えます", cls: "ws-ready" };
  if (state === "BUSY" || state === "CHECKPOINTING") return { text: "応答しています", cls: "ws-working" };
  if (state === "STOPPED" || state === "STOPPING") return { text: "停止しています", cls: "ws-stopped" };
  if (state === "STARTING" || state === "RESTORING") return { text: "準備中です", cls: "ws-working" };
  if (FAILED.has(state)) return { text: "準備に失敗しました", cls: "ws-failed" };
  return { text: "状態を確認しています", cls: "ws-stopped" };
}

function needsPrepare(state) {
  return !SETTLED_USABLE.has(state);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function esc(text) {
  return String(text ?? "");
}

// ---------------------------------------------------------------------------
// Home screen
// ---------------------------------------------------------------------------

async function loadList() {
  const state = $("list-state");
  state.textContent = "読み込んでいます…";
  const r = await api("GET", "/v1/workspaces");
  if (r.status !== 200 || !Array.isArray(r.json?.workspaces)) {
    state.textContent = "一覧を読み込めませんでした。更新ボタンでもう一度お試しください。";
    return;
  }
  state.textContent = "";
  const ul = $("ws-list");
  ul.replaceChildren();
  const items = r.json.workspaces;
  if (items.length === 0) {
    ul.append(el("li", null, "まだ作業場がありません。下のフォームから始めてください。"));
    return;
  }
  for (const ws of items) {
    const li = el("li");
    const word = statusWord(ws.runtimeState);
    const repo = el("span", "ws-repo", `${esc(ws.repositoryOwner)}/${esc(ws.repositoryName)}`);
    const st = el("span", `ws-status ${word.cls}`, word.text);
    const go = el("button", null, "会話を開く");
    go.setAttribute("data-testid", "ws-row");
    go.onclick = () => {
      location.href = `/app?ws=${encodeURIComponent(ws.id)}`;
    };
    li.append(repo, st, " ", go);
    ul.append(li);
  }
}

/**
 * "リポジトリを開く" as ONE action: create -> prepare -> session, then move
 * to the conversation screen. The screen never blocks: progress stays in the
 * inline state line while the list remains usable.
 */
async function startFlow() {
  const btn = $("btn-start");
  const state = $("start-state");
  btn.disabled = true;
  try {
    state.textContent = "作業場を作っています…";
    const created = await api("POST", "/v1/workspaces", {
      repositoryOwner: $("in-repo-owner").value.trim(),
      repositoryName: $("in-repo-name").value.trim(),
      baseBranch: $("in-base-branch").value.trim() || "main",
    });
    if (created.status !== 201 || !created.json?.id) {
      state.textContent = "作業場を作れませんでした。入力を確認してもう一度お試しください。";
      return;
    }
    const id = created.json.id;
    state.textContent = "準備しています…";
    // 202 = preparing now, 200 = already usable. Either way the
    // conversation screen owns the wait — move on as soon as a session
    // exists so this screen never blocks.
    await api("POST", wsPath(id, "/open"), {});
    state.textContent = "会話の準備をしています…";
    const sessions = await api("GET", wsPath(id, "/sessions"));
    let sessionId = null;
    if (sessions.status === 200 && Array.isArray(sessions.json?.sessions)) {
      sessionId = pickLatestSession(sessions.json.sessions)?.id ?? null;
    }
    if (!sessionId) {
      const made = await api("POST", wsPath(id, "/sessions"), {});
      if (made.status !== 200 && made.status !== 201) {
        state.textContent = "会話を用意できませんでした。もう一度お試しください。";
        return;
      }
      sessionId = made.json?.id ?? null;
    }
    if (!sessionId) {
      state.textContent = "会話を用意できませんでした。もう一度お試しください。";
      return;
    }
    location.href = `/app?ws=${encodeURIComponent(id)}`;
  } finally {
    btn.disabled = false;
  }
}

function pickLatestSession(sessions) {
  if (sessions.length === 0) return null;
  let best = sessions[0];
  for (const s of sessions) {
    if ((s.updatedAt ?? s.createdAt ?? "") >= (best.updatedAt ?? best.createdAt ?? "")) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Conversation screen
// ---------------------------------------------------------------------------

const conv = {
  workspaceId: null,
  sessionId: null,
  // Highest event number seen (resume cursor for reconnects; internal only).
  maxNum: -1,
  stream: null, // { abort: AbortController } while connected
  decidedAsks: new Map(), // ask id -> decision text (cards update in place)
  streamingAssistant: null, // live assistant bubble while text-delta chunks stream (issue #147)
  sending: false,
  timers: [],
};

function showHome() {
  $("home-view").hidden = false;
  $("ws-view").hidden = true;
  void loadList();
  $("btn-refresh-list").onclick = () => void loadList();
  $("btn-start").onclick = () => void startFlow();
}

async function showConversation(workspaceId) {
  conv.workspaceId = workspaceId;
  $("home-view").hidden = true;
  $("ws-view").hidden = false;

  const read = await api("GET", wsPath(workspaceId));
  if (read.status !== 200 || !read.json) {
    renderBanner("unknown", "作業場が見つかりません。一覧に戻ってもう一度お試しください。");
    $("ws-title").textContent = "";
    return;
  }
  renderWorkspace(read.json);
  await refreshRole();
  await ensureSession();
  void connectStream();
  // Timers poll recordActivity-free reads only (spec section 11): the
  // workspace every 5s, the single-writer status piggybacked every 3rd tick.
  let ticks = 0;
  conv.timers.push(
    setInterval(async () => {
      ticks += 1;
      const r = await api("GET", wsPath(workspaceId));
      if (r.status === 200 && r.json) renderWorkspace(r.json);
      if (ticks % 3 === 0) await refreshRole();
    }, 5000),
  );

  $("btn-send").onclick = () => void sendFlow();
  $("in-message").addEventListener("keydown", (e) => {
    if (e.key === "Enter") void sendFlow();
  });
  wireStopButton();
}

function renderWorkspace(ws) {
  $("ws-title").textContent = ` ${esc(ws.repositoryOwner)}/${esc(ws.repositoryName)}`;
  renderBanner(ws.runtimeState, null);
}

/** Banner from the server state; raw state names never shown. */
function renderBanner(state, overrideText) {
  const banner = $("status-banner");
  banner.replaceChildren();
  const failed = FAILED.has(state);
  if (state === "READY") {
    banner.className = "banner banner-hidden";
    return;
  }
  if (state === "BUSY" || state === "CHECKPOINTING") {
    banner.className = "banner banner-working";
    banner.textContent = overrideText ?? "応答しています…";
    return;
  }
  if (state === "STOPPING") {
    banner.className = "banner banner-stopped";
    banner.textContent = overrideText ?? "停止しています…";
    return;
  }
  if (state === "STOPPED" || state === "STARTING" || state === "RESTORING" || TRANSIENT.has(state)) {
    banner.className = state === "STOPPED" ? "banner banner-stopped" : "banner banner-working";
    banner.textContent =
      overrideText ?? (state === "STOPPED"
        ? "停止しています。メッセージを送ると自動で再開します。"
        : "準備中です。しばらくお待ちください。");
    return;
  }
  if (failed) {
    banner.className = "banner banner-failed";
    banner.append("準備に失敗しました。もう一度お試しください。");
    const retry = el("button", null, "再試行する");
    retry.setAttribute("data-testid", "retry-prepare");
    retry.onclick = () => void prepareAndWait(true);
    banner.append(" ", retry);
    return;
  }
  banner.className = "banner banner-stopped";
  banner.textContent = overrideText ?? "状態を確認しています…";
}

function setBannerBusy(text) {
  const banner = $("status-banner");
  banner.replaceChildren();
  banner.className = "banner banner-working";
  banner.textContent = text;
}

/** Single-writer status: only "someone else is using it" ever surfaces. */
async function refreshRole() {
  const box = $("readonly-banner");
  const r = await api("GET", wsPath(conv.workspaceId, "/controller"));
  const readonly = r.status === 200 && r.json?.held === true && r.json?.mine === false;
  box.hidden = !readonly;
  if (readonly) box.textContent = "他の人が使用中です。閲覧のみとなります。";
  setComposerEnabled(!readonly && !conv.sending);
  return readonly;
}

function setComposerEnabled(enabled) {
  $("in-message").disabled = !enabled;
  $("btn-send").disabled = !enabled;
}

async function ensureSession() {
  const r = await api("GET", wsPath(conv.workspaceId, "/sessions"));
  if (r.status === 200 && Array.isArray(r.json?.sessions)) {
    const latest = pickLatestSession(r.json.sessions);
    if (latest) {
      conv.sessionId = latest.id;
      return;
    }
  }
  const made = await api("POST", wsPath(conv.workspaceId, "/sessions"), {});
  if ((made.status === 200 || made.status === 201) && made.json?.id) {
    conv.sessionId = made.json.id;
  }
}

// --- prepare + wait (202 then poll GET; never blocks the screen) ---

const PREPARE_POLL_MS = 2000;
const PREPARE_POLL_MAX = 150; // ~5 min, past the dev 3s stand-in by far

async function prepareAndWait(fromRetry) {
  setBannerBusy(fromRetry ? "再試行しています…" : "再開しています…");
  const started = await api("POST", wsPath(conv.workspaceId, "/open"), {});
  if (started.status !== 200 && started.status !== 202) return false;
  for (let i = 0; i < PREPARE_POLL_MAX; i++) {
    await new Promise((r) => setTimeout(r, PREPARE_POLL_MS));
    const read = await api("GET", wsPath(conv.workspaceId));
    const s = read.json?.runtimeState;
    if (read.status === 200 && !needsPrepare(s)) return true;
    if (read.status === 200 && FAILED.has(s)) return false;
  }
  return false;
}

/** Waits out a transient state (preparing / stopping) without preparing. */
async function waitTransient() {
  for (let i = 0; i < 60; i++) {
    const read = await api("GET", wsPath(conv.workspaceId));
    const s = read.json?.runtimeState;
    if (read.status !== 200) return s;
    if (!TRANSIENT.has(s)) return s;
    setBannerBusy(s === "STOPPING" ? "停止しています…" : "準備中です。しばらくお待ちください。");
    await new Promise((r) => setTimeout(r, PREPARE_POLL_MS));
  }
  return null;
}

// --- send (transparent resume: stopped -> prepare -> wait -> retry) ---

async function sendFlow() {
  if (conv.sending || !conv.sessionId) return;
  const input = $("in-message");
  const content = input.value.trim();
  if (!content) return;
  conv.sending = true;
  setComposerEnabled(false);
  const note = $("send-state");
  note.textContent = "送信しています…";
  try {
    let read = await api("GET", wsPath(conv.workspaceId));
    let state = read.json?.runtimeState;
    if (TRANSIENT.has(state)) state = await waitTransient();
    if (state !== undefined && needsPrepare(state)) {
      const ok = await prepareAndWait(false);
      if (!ok) {
        const reread = await api("GET", wsPath(conv.workspaceId));
        renderWorkspace(reread.json ?? { runtimeState: state });
        note.textContent = "再開できませんでした。時間をおいてもう一度お試しください。";
        return;
      }
      const reread = await api("GET", wsPath(conv.workspaceId));
      if (reread.status === 200 && reread.json) renderWorkspace(reread.json);
    }
    const sent = await api("POST", `/v1/sessions/${encodeURIComponent(conv.sessionId)}/messages`, {
      content,
    });
    if (sent.status === 201) {
      input.value = "";
      note.textContent = "";
      return;
    }
    if (sent.status === 409) {
      // Our pre-send read was stale (stopped between read and send),
      // ownership lapsed while the state stayed usable (READY with nobody
      // holding it — the dev server has no agent-host keep-alive), or
      // someone else holds the single-writer role. Re-read once and branch:
      // POST "/open" re-lines-up ownership for this caller and is an
      // idempotent no-op otherwise, so one prepare + one retry recovers
      // both "stopped meanwhile" and "lapsed while usable" — unless the
      // role is taken or the state is still moving. The server answers
      // 409 before appending, so a 409ed send never wrote twice and a
      // single retry cannot double-send.
      const reread = await api("GET", wsPath(conv.workspaceId));
      const s = reread.json?.runtimeState;
      if (reread.status === 200 && reread.json) renderWorkspace(reread.json);
      const settled = s !== undefined && !TRANSIENT.has(s);
      if (settled && !(await refreshRole())) {
        const ok = await prepareAndWait(false);
        if (!ok) {
          note.textContent = "再開できませんでした。時間をおいてもう一度お試しください。";
          return;
        }
        const retry = await api(
          "POST",
          `/v1/sessions/${encodeURIComponent(conv.sessionId)}/messages`,
          { content },
        );
        if (retry.status === 201) {
          input.value = "";
          note.textContent = "";
          const fresh = await api("GET", wsPath(conv.workspaceId));
          if (fresh.status === 200 && fresh.json) renderWorkspace(fresh.json);
          return;
        }
      }
      const readonly = await refreshRole();
      note.textContent = readonly
        ? "他の人が使用中です。閲覧のみとなります。"
        : "送信できませんでした。時間をおいてもう一度お試しください。";
      return;
    }
    note.textContent = "送信できませんでした。時間をおいてもう一度お試しください。";
  } finally {
    conv.sending = false;
    await refreshRole();
  }
}

// --- stop (two taps, no dialog) ---

function wireStopButton() {
  const btn = $("btn-stop");
  let armed = false;
  let timer = null;
  const disarm = () => {
    armed = false;
    btn.textContent = "停止する";
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  btn.onclick = async () => {
    if (!armed) {
      armed = true;
      btn.textContent = "押すと停止します";
      timer = setTimeout(disarm, 5000);
      return;
    }
    disarm();
    btn.disabled = true;
    try {
      await api("POST", wsPath(conv.workspaceId, "/stop"), {});
      const read = await api("GET", wsPath(conv.workspaceId));
      if (read.status === 200 && read.json) renderWorkspace(read.json);
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Conversation rendering + stream
// ---------------------------------------------------------------------------

function askIdOf(data) {
  if (!data || typeof data !== "object") return null;
  for (const key of ["approvalId", "approval_id", "id"]) {
    if (typeof data[key] === "string" && data[key]) return data[key];
  }
  if (typeof data.callId === "string" && data.callId) return data.callId;
  return null;
}

function askSummaryOf(data) {
  if (!data || typeof data !== "object") return "作業の確認を求められています。";
  for (const key of ["title", "description", "reason", "prompt"]) {
    if (typeof data[key] === "string" && data[key]) return data[key].slice(0, 300);
  }
  if (typeof data.tool === "string" && data.tool) return `「${data.tool}」の実行確認を求められています。`;
  return "作業の確認を求められています。";
}

function scrollBottom() {
  const list = $("messages");
  list.scrollTop = list.scrollHeight;
}

function appendMessage(cls, text) {
  const li = el("li", cls, text);
  $("messages").append(li);
  scrollBottom();
  return li;
}

/**
 * Appends a text-delta fragment to the live assistant bubble, creating it
 * on the first fragment (issue #147: streaming display instead of one raw
 * JSON line per chunk). The closing `assistant/message` replaces this
 * approximation with the final text via finishStreamingAssistant().
 */
function appendStreamingAssistant(fragment) {
  if (!conv.streamingAssistant || !conv.streamingAssistant.isConnected) {
    conv.streamingAssistant = appendMessage("msg-assistant msg-streaming", "");
  }
  conv.streamingAssistant.textContent += fragment;
  scrollBottom();
}

/**
 * Settles the live bubble with the final `assistant/message` text (or
 * drops the empty bubble when the message had no readable body).
 */
function finishStreamingAssistant(text) {
  const live = conv.streamingAssistant;
  conv.streamingAssistant = null;
  if (live && live.isConnected) {
    if (text) {
      live.textContent = text;
      live.classList.remove("msg-streaming");
    } else live.remove();
  } else if (text) {
    appendMessage("msg-assistant", text);
  }
}

function renderEvent(ev) {
  // Issue #147: allow-list rendering via render.js. Anything describeEvent
  // does not explicitly surface (internal plumbing, unknown future types)
  // is hidden — raw JSON never reaches the conversation.
  const described = describeEvent(ev);
  const data = ev.data;
  switch (described.kind) {
    case "hidden":
      return;
    case "user":
      appendMessage("msg-user", described.text);
      return;
    case "assistant":
      // A tool-call-only assistant/message arrives with no text while a
      // previous text stream may still be live: keep the live bubble.
      if (conv.streamingAssistant && conv.streamingAssistant.isConnected && !described.text) return;
      finishStreamingAssistant(described.text);
      return;
    case "stream":
      appendStreamingAssistant(described.text);
      return;
    case "tool":
      appendMessage("msg-tool", described.text);
      return;
    case "cancel":
      appendMessage("msg-system", "中断しました");
      return;
    case "approval-asked":
      renderAskCard(data);
      return;
    case "approval": {
      const id = askIdOf(data);
      const decision = data?.decision === "rejected" ? "却下しました" : "承認しました";
      if (id) markAskDecided(id, decision);
      else appendMessage("msg-system", decision);
      return;
    }
    case "approval-decided": {
      const id = askIdOf(data);
      if (id && !conv.decidedAsks.has(id)) markAskDecided(id, "確定しました");
      return;
    }
    default:
      return;
  }
}

function renderAskCard(data) {
  const id = askIdOf(data);
  const li = el("li", "msg-approval");
  li.append(el("div", null, "確認が必要です"));
  li.append(el("div", null, askSummaryOf(data)));
  const row = el("div", "approval-buttons");
  if (!id) {
    row.append(el("span", null, "この確認には会話画面から答えられません。"));
    li.append(row);
    $("messages").append(li);
    scrollBottom();
    return;
  }
  if (conv.decidedAsks.has(id)) {
    li.classList.add("decided");
    row.append(el("span", null, conv.decidedAsks.get(id)));
    li.append(row);
    $("messages").append(li);
    scrollBottom();
    return;
  }
  li.dataset.askId = id;
  const approve = el("button", null, "承認する");
  approve.setAttribute("data-testid", "approve");
  const reject = el("button", null, "却下する");
  reject.setAttribute("data-testid", "reject");
  approve.onclick = () => void decideAsk(id, "approved", approve, reject, li);
  reject.onclick = () => void decideAsk(id, "rejected", approve, reject, li);
  row.append(approve, reject);
  li.append(row);
  $("messages").append(li);
  scrollBottom();
}

function markAskDecided(id, text) {
  conv.decidedAsks.set(id, text);
  const card = document.querySelector(`#messages .msg-approval[data-ask-id="${CSS.escape(id)}"]`);
  if (!card) {
    // No card on screen (e.g. the ask arrived before this page connected,
    // or the decision came first): still show the outcome as a line.
    appendMessage("msg-system", text);
    return;
  }
  card.classList.add("decided");
  const row = card.querySelector(".approval-buttons");
  if (row) {
    row.replaceChildren(el("span", null, text));
  }
}

async function decideAsk(id, decision, approveBtn, rejectBtn, card) {
  approveBtn.disabled = true;
  rejectBtn.disabled = true;
  const send = () =>
    api("POST", `/v1/sessions/${encodeURIComponent(conv.sessionId)}/approvals/${encodeURIComponent(id)}`, {
      decision,
    });
  let r = await send();
  if (r.status === 409 && !(await refreshRole())) {
    // Same lapsed-ownership recovery as sendFlow: one prepare (POST
    // "/open" re-lines-up ownership for this caller) + one retry. The
    // server answers 409 before appending, so the first attempt never
    // wrote twice. Skipped when someone else holds the role.
    if (await prepareAndWait(false)) r = await send();
  }
  if (r.status === 201) {
    markAskDecided(id, decision === "rejected" ? "却下しました" : "承認しました");
  } else {
    approveBtn.disabled = false;
    rejectBtn.disabled = false;
    card.append(el("div", null, "答えを送れませんでした。時間をおいてもう一度お試しください。"));
  }
}

function setStreamState(text) {
  $("stream-state").textContent = text;
}

async function streamLoop(sessionId, abortSignal) {
  const parser = createSseParser();
  const resumeFrom = conv.maxNum >= 0 ? conv.maxNum + 1 : null;
  parser.lastSeq = resumeFrom !== null ? resumeFrom - 1 : -1;
  const path =
    `/v1/sessions/${encodeURIComponent(sessionId)}/events` +
    (resumeFrom !== null ? `?seq=${resumeFrom}` : "");
  const res = await fetch(path, { signal: abortSignal });
  if (res.status !== 200 || !res.body) throw new Error(`stream ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  setStreamState("つながっています");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const out = parseSseChunks(parser, decoder.decode(value, { stream: true }));
      // Gaps stay internal: the next reconnect resumes from the cursor and
      // the server replays what was missed.
      for (const ev of out.events) {
        if (ev.seq !== null && ev.seq !== undefined && ev.seq > conv.maxNum) conv.maxNum = ev.seq;
        renderEvent(ev);
      }
      if (abortSignal.aborted) break;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

async function connectStream() {
  if (conv.stream || !conv.sessionId) return;
  const sessionId = conv.sessionId;
  const abort = new AbortController();
  conv.stream = { abort };
  setStreamState("つないでいます…");
  let attempts = 0;
  while (conv.stream && !abort.signal.aborted) {
    try {
      await streamLoop(sessionId, abort.signal);
      if (abort.signal.aborted) break;
      attempts += 1;
      setStreamState("つなぎ直しています…");
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      if (abort.signal.aborted) break;
      attempts += 1;
      if (attempts > 3) setStreamState("つなぎ直しています…");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  conv.stream = null;
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function boot() {
  const wsId = new URLSearchParams(location.search).get("ws");
  if (wsId) void showConversation(wsId);
  else showHome();
}

if (typeof document !== "undefined") boot();
