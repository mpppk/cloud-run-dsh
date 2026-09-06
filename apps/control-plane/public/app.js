// Debug Web UI (issue #128). Plain ES module — no npm dependencies, no bundler.
//
// Everything is same-origin fetch against the control-plane that serves this
// file. Local and IAP-fronted production share one code path: auth headers
// are read from the header inputs and omitted when empty, so under IAP the
// proxy-injected headers pass through untouched.
//
// The event stream is read with fetch + ReadableStream (NOT the built-in
// browser SSE client, which cannot attach custom headers), parsing the SSE
// wire format below. Reconnect resumes from ?seq=<maxSeq+1>; the server
// replays seq >= cursor. seq <= maxSeq events are dropped as duplicates,
// and a jump (prev+1 !== seq) is shown as a gap warning.
//
// Idle-timer discipline (spec section 11): NOTHING here fires on its own
// except the event stream and one low-frequency workspace refresh while the
// stream is connected (the controller status piggybacks on that same timer,
// issue #133 — both reads skip recordActivity). open / stop / message /
// approval / cancel / checkpoint are only ever sent from button clicks.
// The 1s badge re-render reads the local clock only and never fetches.

import { createSseParser, parseSseChunks } from "./sse.js";

// ---------------------------------------------------------------------------
// Lease role (pure: no DOM, no fetch). Tested from bun test via static.test.ts.
// ---------------------------------------------------------------------------

/**
 * Decides the badge role from the SERVER's view of the caller's controller
 * relationship (issue #133: `GET /v1/workspaces/:id/controller` returns
 * `{ held, mine, expiresAt }`) plus the local clock only. Never fetches, so
 * re-rendering on a timer cannot extend the server idle timer (spec
 * section 11).
 *
 * Previously this took "did this browser acquire a controllerId", which
 * disagreed with the server gate (`requireController`: active lease's
 * `userId === caller`) whenever `open` had implicitly taken the lease —
 * the badge said observer while messages went through with 201.
 *
 * Boundary matches T6 `ControllerLeaseService` (`expiresAt <= now` counts
 * as expired): `expiresAt === nowMs` returns "expired", not "controller".
 * A held+mine status whose expiresAt is missing or unparseable is also
 * "expired" — failing toward the warning, never toward a false green
 * CONTROLLER. The server never returns held:true for an expired lease
 * (`getActive` filters it), so "expired" only appears for a stale local
 * status whose expiresAt has since passed (#130 display, kept here).
 */
export function leaseRole(status, nowMs) {
  if (!status || !status.held) return "observer";
  if (!status.mine) return "observer";
  const expiresMs = Date.parse(status.expiresAt);
  if (Number.isNaN(expiresMs)) return "expired";
  return expiresMs > nowMs ? "controller" : "expired";
}

// ---------------------------------------------------------------------------
// UI state + boot (DOM only below this line)
// ---------------------------------------------------------------------------

const LS = {
  userId: "dsh.ui.userId",
  userEmail: "dsh.ui.userEmail",
  workspaces: "dsh.ui.workspaces",
};

const state = {
  workspaceId: null,
  sessionId: null,
  leases: {}, // workspaceId -> { controllerId, expiresAt } (local acquire cache: the heartbeat/release capability)
  controller: {}, // workspaceId -> { held, mine, expiresAt } (server view from GET .../controller; drives the badge)
  sse: null, // { abort: AbortController, sessionId } while connected
  sseTimer: null, // low-frequency workspace refresh while streaming
  maxSeq: -1,
  sseAttempts: 0,
};

function $(id) {
  return document.getElementById(id);
}

function loadWorkspaces() {
  try {
    const v = JSON.parse(localStorage.getItem(LS.workspaces) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveWorkspaces(ids) {
  localStorage.setItem(LS.workspaces, JSON.stringify(ids));
}

function authHeaders() {
  const headers = {};
  const id = (localStorage.getItem(LS.userId) ?? "").trim();
  const email = (localStorage.getItem(LS.userEmail) ?? "").trim();
  // Empty means "let the IAP proxy inject" — never send a blank header.
  if (id) headers["x-goog-authenticated-user-id"] = id;
  if (email) headers["x-goog-authenticated-user-email"] = email;
  return headers;
}

function logRequest(method, path, status, bodyText) {
  const log = $("req-log");
  const li = document.createElement("li");
  let short = bodyText ?? "";
  if (short.length > 4000) short = short.slice(0, 4000) + "…(truncated)";
  let suffix = "";
  if (status === 409) {
    li.className = "conflict";
    try {
      const msg = JSON.parse(bodyText)?.error?.message;
      if (msg) suffix = ` — ${msg}`;
    } catch {
      // body was not JSON; status alone is still the signal
    }
  }
  li.textContent = `${method} ${path} → ${status}${suffix} ${short}`;
  log.prepend(li);
  while (log.children.length > 100) log.lastChild.remove();
}

async function apiFetch(method, path, body) {
  const init = { method, headers: { ...authHeaders() } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  logRequest(method, path, res.status, text);
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body (never expected from /v1/*, but do not crash the log)
  }
  return { status: res.status, text, json };
}

// --- workspaces ---

function renderWsList() {
  const ul = $("ws-list");
  ul.replaceChildren();
  for (const id of loadWorkspaces()) {
    const li = document.createElement("li");
    const short = document.createElement("code");
    short.textContent = id;
    if (id === state.workspaceId) short.className = "selected";
    const badge = document.createElement("span");
    badge.className = "badge badge-unknown";
    badge.dataset.wsId = id;
    badge.textContent = "state: ?";
    const sel = document.createElement("button");
    sel.textContent = "select";
    sel.onclick = () => selectWorkspace(id);
    li.append(short, " ", badge, " ", sel);
    ul.append(li);
  }
  renderWsDetail();
}

function setBadge(id, runtimeState) {
  const badge = document.querySelector(`#ws-list .badge[data-ws-id="${CSS.escape(id)}"]`);
  if (!badge) return;
  badge.textContent = `state: ${runtimeState}`;
  badge.className = `badge badge-${runtimeState.toLowerCase()}`;
}

async function refreshWorkspace(id) {
  const r = await apiFetch("GET", `/v1/workspaces/${encodeURIComponent(id)}`);
  if (r.status === 200 && r.json) {
    setBadge(id, r.json.runtimeState ?? "?");
    if (id === state.workspaceId) renderWsDetail(r.json);
  }
  return r;
}

/**
 * Issue #136: follows an async open to its conclusion. Polls GET every 2s
 * (bounded: 60 attempts ~= the stale-starting threshold's order) until the
 * row leaves STARTING/RESTORING, refreshing the badge each time. Stops early
 * if the user selects another workspace. Debug UI only — the product UI
 * (#138) owns the real polling UX.
 */
async function pollWorkspaceUntilSettled(id, initialState) {
  if (initialState !== "STARTING" && initialState !== "RESTORING") return;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (state.workspaceId !== id) return;
    const r = await refreshWorkspace(id);
    const s = r.json?.runtimeState;
    if (s !== "STARTING" && s !== "RESTORING") return;
  }
}

function selectWorkspace(id) {
  state.workspaceId = id;
  renderWsList();
  renderRole();
  void refreshController(id);
}

function renderWsDetail(ws) {
  const el = $("ws-detail");
  if (!state.workspaceId) {
    el.textContent = "workspace: -";
    return;
  }
  if (!ws) {
    el.textContent = `workspace: ${state.workspaceId} (press refresh)`;
    return;
  }
  el.textContent =
    `workspace: ${ws.id} owner=${ws.ownerId} ` +
    `${ws.repositoryOwner}/${ws.repositoryName}@${ws.baseBranch} state=${ws.runtimeState}`;
}

function renderRole() {
  const badge = $("role-badge");
  const status = state.workspaceId ? (state.controller[state.workspaceId] ?? null) : null;
  const role = leaseRole(status, Date.now());
  if (role === "controller") {
    badge.textContent = "role: CONTROLLER";
    badge.className = "role-controller";
  } else if (role === "expired") {
    badge.textContent = `role: CONTROLLER — lease EXPIRED at ${status.expiresAt} (press heartbeat)`;
    badge.className = "role-expired";
  } else if (status && status.held) {
    badge.textContent = "role: observer (別のメンバーが controller)";
    badge.className = "role-observer";
  } else {
    badge.textContent = "role: observer (controller 不在)";
    badge.className = "role-observer";
  }
  const detail = $("lease-detail");
  const serverView = status
    ? `held: ${status.held} mine: ${status.mine} / expiresAt: ${status.expiresAt}`
    : "held: - / mine: - / expiresAt: -";
  const lease = state.workspaceId ? state.leases[state.workspaceId] : null;
  detail.textContent = lease
    ? `${serverView} (local controllerId: ${lease.controllerId})`
    : serverView;
}

/**
 * Refreshes the server-view controller status for one workspace (issue
 * #133). Safe to call freely: `GET .../controller` never calls
 * recordActivity, so it cannot extend the server idle timer (spec
 * section 11). Called on workspace select, after open/stop/acquire/
 * heartbeat/release, and piggybacked on the 15s SSE workspace refresh —
 * never on the 1s re-render timer.
 */
async function refreshController(id) {
  const r = await apiFetch("GET", `/v1/workspaces/${encodeURIComponent(id)}/controller`);
  if (r.status === 200 && r.json) {
    state.controller[id] = { held: r.json.held, mine: r.json.mine, expiresAt: r.json.expiresAt };
    if (id === state.workspaceId) renderRole();
  }
  return r;
}

// --- sessions ---

function renderSessionList(sessions) {
  const ul = $("session-list");
  ul.replaceChildren();
  for (const s of sessions) {
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = s.id;
    if (s.id === state.sessionId) code.className = "selected";
    const btn = document.createElement("button");
    btn.textContent = "select";
    btn.onclick = () => {
      state.sessionId = s.id;
      state.maxSeq = -1;
      $("session-detail").textContent = `session: ${s.id}`;
      renderSessionList(sessions);
    };
    li.append(code, " ", btn);
    ul.append(li);
  }
}

// --- SSE ---

const EVENT_CLASS = {
  "assistant/message": "ev-assistant",
  "tool/call": "ev-tool-call",
  "tool/result": "ev-tool-result",
  "turn/start": "ev-turn",
  "approval/asked": "ev-approval-asked",
  user_message: "ev-user",
  approval: "ev-approval",
  cancel: "ev-cancel",
};

function maybeAutofillApprovalId(eventType, data) {
  if (eventType !== "approval/asked" || !data || typeof data !== "object") return;
  const id = data.approvalId ?? data.approval_id;
  if (typeof id === "string" && id) {
    const input = $("in-approval-id");
    if (!input.value) input.value = id;
  }
}

function renderSseEvent(ev) {
  const li = document.createElement("li");
  li.className = EVENT_CLASS[ev.eventType] ?? "ev-unknown";
  const seqLabel = ev.seq === null ? "seq:?" : `seq:${ev.seq}`;
  const typeLabel = ev.eventType ?? "(no event)";
  const payload = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
  li.textContent = `${seqLabel} [${typeLabel}] ${payload}`;
  $("sse-events").prepend(li);
  while ($("sse-events").children.length > 200) $("sse-events").lastChild.remove();
}

function renderGap(gap) {
  const banner = $("sse-gap");
  banner.className = "gap-warn";
  banner.textContent = `GAP: expected seq ${gap.expected}, got ${gap.got} — events were missed`;
  const li = document.createElement("li");
  li.className = "gap-warn";
  li.textContent = `--- gap: expected seq ${gap.expected}, got ${gap.got} ---`;
  $("sse-events").prepend(li);
}

function setSseState(text) {
  $("sse-state").textContent = text;
}

function startWorkspacePolling() {
  stopWorkspacePolling();
  // Low-frequency refresh of the state badge ONLY while streaming.
  // The controller status piggybacks on this same timer (issue #133) —
  // no new timer is added, and neither refresh calls recordActivity, so
  // this plus the stream itself remains the only automatic traffic this
  // page ever sends (spec section 11: opening the page must not extend idle).
  state.sseTimer = setInterval(() => {
    if (state.workspaceId) {
      void refreshWorkspace(state.workspaceId);
      void refreshController(state.workspaceId);
    }
  }, 15000);
}

function stopWorkspacePolling() {
  if (state.sseTimer) {
    clearInterval(state.sseTimer);
    state.sseTimer = null;
  }
}

async function sseLoop(sessionId, abortSignal) {
  const parser = createSseParser();
  // Resume from the highest seq seen; a fresh subscribe replays everything.
  const resumeFrom = state.maxSeq >= 0 ? state.maxSeq + 1 : null;
  parser.lastSeq = resumeFrom !== null ? resumeFrom - 1 : -1;
  const path =
    `/v1/sessions/${encodeURIComponent(sessionId)}/events` +
    (resumeFrom !== null ? `?seq=${resumeFrom}` : "");
  const res = await fetch(path, { headers: authHeaders(), signal: abortSignal });
  if (res.status !== 200 || !res.body) {
    // Rejects are small finite bodies — safe to read for the log.
    const text = await res.text().catch(() => "");
    logRequest("GET", path, res.status, text);
    throw new Error(`SSE connect failed: ${res.status}`);
  }
  // A live stream has no end, so its body is never logged — only the status.
  logRequest("GET", path, res.status, "(stream)");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  setSseState(`connected (${resumeFrom !== null ? `resumed from seq=${resumeFrom}` : "from start"})`);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const out = parseSseChunks(parser, decoder.decode(value, { stream: true }));
      for (const gap of out.gaps) renderGap(gap);
      for (const ev of out.events) {
        if (ev.seq !== null && ev.seq > state.maxSeq) state.maxSeq = ev.seq;
        maybeAutofillApprovalId(ev.eventType, ev.data);
        renderSseEvent(ev);
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

async function sseConnect() {
  if (state.sse) return;
  if (!state.sessionId) {
    setSseState("select a session first");
    return;
  }
  const sessionId = state.sessionId;
  const abort = new AbortController();
  state.sse = { abort, sessionId };
  state.sseAttempts = 0;
  startWorkspacePolling();
  // Reconnect loop: a dropped stream resumes from the last seen seq.
  // Manual disconnect (abort) is the only way out.
  while (state.sse && !abort.signal.aborted) {
    try {
      await sseLoop(sessionId, abort.signal);
      if (abort.signal.aborted) break;
      state.sseAttempts += 1;
      setSseState(`disconnected — reconnecting from seq=${state.maxSeq + 1} (attempt ${state.sseAttempts})…`);
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      if (abort.signal.aborted) break;
      state.sseAttempts += 1;
      setSseState(
        `error: ${e instanceof Error ? e.message : String(e)} — retrying from seq=${state.maxSeq + 1}…`,
      );
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  state.sse = null;
  stopWorkspacePolling();
  if (!abort.signal.aborted) setSseState("disconnected");
}

function sseDisconnect() {
  stopWorkspacePolling();
  if (state.sse) {
    state.sse.abort.abort();
    state.sse = null;
    setSseState("disconnected (manual)");
  } else {
    setSseState("disconnected");
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function boot() {
  // headers
  $("in-user-id").value = localStorage.getItem(LS.userId) ?? "";
  $("in-user-email").value = localStorage.getItem(LS.userEmail) ?? "";
  $("btn-save-headers").onclick = () => {
    localStorage.setItem(LS.userId, $("in-user-id").value.trim());
    localStorage.setItem(LS.userEmail, $("in-user-email").value.trim());
    $("headers-state").textContent = "saved";
  };

  // workspaces
  renderWsList();
  $("btn-create-ws").onclick = async () => {
    const r = await apiFetch("POST", "/v1/workspaces", {
      repositoryOwner: $("in-repo-owner").value.trim(),
      repositoryName: $("in-repo-name").value.trim(),
      baseBranch: $("in-base-branch").value.trim() || "main",
    });
    if (r.status === 201 && r.json?.id) {
      const ids = loadWorkspaces();
      if (!ids.includes(r.json.id)) saveWorkspaces([...ids, r.json.id]);
      state.workspaceId = r.json.id;
      renderWsList();
      renderRole();
      await refreshWorkspace(r.json.id);
      await refreshController(r.json.id);
    }
  };
  $("btn-add-ws").onclick = async () => {
    const id = $("in-add-ws").value.trim();
    if (!id) return;
    const ids = loadWorkspaces();
    if (!ids.includes(id)) saveWorkspaces([...ids, id]);
    state.workspaceId = id;
    renderWsList();
    renderRole();
    $("in-add-ws").value = "";
    await refreshWorkspace(id);
    await refreshController(id);
  };
  $("btn-refresh-ws").onclick = () => {
    if (state.workspaceId) void refreshWorkspace(state.workspaceId);
  };
  $("btn-open-ws").onclick = () => {
    if (state.workspaceId) {
      const id = state.workspaceId;
      // Issue #136: open is async — 202 STARTING now, READY later via the
      // agent-host. Refresh the badge/role, then poll GET until the row
      // settles so the debug UI shows the whole STARTING -> READY arc
      // without further clicks. Raw state names are fine here (debug UI).
      void apiFetch("POST", `/v1/workspaces/${encodeURIComponent(id)}/open`, {}).then((r) =>
        Promise.all([refreshWorkspace(id), refreshController(id)]).then(() =>
          pollWorkspaceUntilSettled(id, r.json?.state),
        ),
      );
    }
  };
  $("btn-stop-ws").onclick = () => {
    if (state.workspaceId) {
      const id = state.workspaceId;
      void apiFetch("POST", `/v1/workspaces/${encodeURIComponent(id)}/stop`, {}).then(() =>
        Promise.all([refreshWorkspace(id), refreshController(id)]),
      );
    }
  };
  $("btn-delete-ws").onclick = async () => {
    if (!state.workspaceId) return;
    if (!window.confirm(`Delete workspace ${state.workspaceId}?`)) return;
    const id = state.workspaceId;
    const r = await apiFetch("DELETE", `/v1/workspaces/${encodeURIComponent(id)}`);
    if (r.status === 200) {
      saveWorkspaces(loadWorkspaces().filter((x) => x !== id));
      delete state.leases[id];
      delete state.controller[id];
      if (state.workspaceId === id) state.workspaceId = null;
      renderWsList();
      renderRole();
    }
  };
  $("btn-checkpoint").onclick = async () => {
    if (!state.workspaceId) return;
    const r = await apiFetch(
      "POST",
      `/v1/workspaces/${encodeURIComponent(state.workspaceId)}/checkpoints`,
      {},
    );
    $("checkpoint-result").textContent =
      r.status === 200 && r.json ? `checkpointed: ${r.json.checkpointed} skipped: ${r.json.skipped}` : `failed: ${r.status}`;
  };

  // lease
  renderRole();
  // Issue #130: re-render the badge from the local clock once a second so
  // a held lease visibly flips to EXPIRED when its expiresAt passes.
  // renderRole touches only the DOM — no fetch — so merely having the page
  // open cannot extend the server idle timer (spec section 11).
  setInterval(renderRole, 1000);
  $("btn-acquire").onclick = async () => {
    if (!state.workspaceId) return;
    const id = state.workspaceId;
    const r = await apiFetch(
      "POST",
      `/v1/workspaces/${encodeURIComponent(id)}/controller/acquire`,
      {},
    );
    if (r.status === 200 && r.json) {
      state.leases[id] = {
        controllerId: r.json.controllerId,
        expiresAt: r.json.expiresAt,
      };
    }
    await refreshController(id);
  };
  $("btn-heartbeat").onclick = async () => {
    if (!state.workspaceId) return;
    const id = state.workspaceId;
    const lease = state.leases[id];
    if (!lease) {
      $("lease-detail").textContent = "no controllerId held — acquire first";
      return;
    }
    const r = await apiFetch(
      "POST",
      `/v1/workspaces/${encodeURIComponent(id)}/controller/heartbeat`,
      { controllerId: lease.controllerId },
    );
    if (r.status === 200 && r.json) {
      state.leases[id] = {
        controllerId: r.json.controllerId,
        expiresAt: r.json.expiresAt,
      };
    }
    await refreshController(id);
  };
  $("btn-release").onclick = async () => {
    if (!state.workspaceId) return;
    const id = state.workspaceId;
    const lease = state.leases[id];
    if (!lease) return;
    const r = await apiFetch(
      "POST",
      `/v1/workspaces/${encodeURIComponent(id)}/controller/release`,
      { controllerId: lease.controllerId },
    );
    if (r.status === 200) delete state.leases[id];
    await refreshController(id);
  };

  // sessions
  $("btn-create-session").onclick = async () => {
    if (!state.workspaceId) return;
    const r = await apiFetch(
      "POST",
      `/v1/workspaces/${encodeURIComponent(state.workspaceId)}/sessions`,
      {},
    );
    if ((r.status === 200 || r.status === 201) && r.json?.id) {
      state.sessionId = r.json.id;
      state.maxSeq = -1;
      $("session-detail").textContent = `session: ${r.json.id}`;
      renderSessionList([r.json]);
    }
  };
  $("btn-list-sessions").onclick = async () => {
    if (!state.workspaceId) return;
    const r = await apiFetch(
      "GET",
      `/v1/workspaces/${encodeURIComponent(state.workspaceId)}/sessions`,
    );
    if (r.status === 200 && Array.isArray(r.json?.sessions)) renderSessionList(r.json.sessions);
  };

  // turn
  $("btn-send-message").onclick = () => {
    if (!state.sessionId) return;
    const content = $("in-message").value;
    void apiFetch("POST", `/v1/sessions/${encodeURIComponent(state.sessionId)}/messages`, {
      content,
    });
  };
  const decide = (decision) => {
    if (!state.sessionId) return;
    const approvalId = $("in-approval-id").value.trim();
    if (!approvalId) return;
    void apiFetch(
      "POST",
      `/v1/sessions/${encodeURIComponent(state.sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision },
    );
  };
  $("btn-approve").onclick = () => decide("approved");
  $("btn-reject").onclick = () => decide("rejected");
  $("btn-cancel").onclick = () => {
    if (!state.sessionId) return;
    void apiFetch("POST", `/v1/sessions/${encodeURIComponent(state.sessionId)}/cancel`, {});
  };

  // SSE
  $("btn-sse-connect").onclick = () => void sseConnect();
  $("btn-sse-disconnect").onclick = () => sseDisconnect();
}

if (typeof document !== "undefined") boot();
