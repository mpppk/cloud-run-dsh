// Tests for the product UI (issue #138, /app).
//
// Same granularity as the debug-UI static tests (static.test.ts), plus the
// product-specific guarantees:
// - /app serves without auth; dynamic /app/<id> pathnames are NOT served
//   (screen switching uses ?ws=<id>, so the pathname stays /app).
// - the served files never show startup / single-writer internals and never
//   call the acquire / heartbeat / release / checkpoint routes.
// - every route the product UI polls (workspace, controller, list, sessions
//   read, SSE stream) stays recordActivity-free, so an open screen never
//   extends the idle timer (spec section 11).
// - the exact API sequence behind the one-action start and the transparent
//   resume works against the dev server.
//
// Boots the dev composition with the dev fetch handler (fake IAP), i.e. the
// same path `bun run dev:control-plane` serves.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ActivityKind } from "@cloud-run-dsh/workspace-runtime";
import {
  createDevControlPlaneDeps,
  DEV_OPEN_READY_DELAY_MS,
  startDevControlPlane,
  type RunningControlPlane,
} from "./dev.js";
import type { ControlPlaneDeps, WorkspaceRuntimeHandle } from "./index.js";

let deps: ControlPlaneDeps;
let server: RunningControlPlane;
let base: string;

function iap(user: string): Record<string, string> {
  return {
    "x-goog-authenticated-user-id": `accounts.google.com:${user}`,
    "x-goog-authenticated-user-email": `${user}@example.com`,
  };
}

/** Polls GET until runtimeState matches (or the deadline passes). */
async function waitForState(workspaceId: string, want: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  for (;;) {
    const read = await fetch(`${base}/v1/workspaces/${workspaceId}`);
    expect(read.status).toBe(200);
    seen = ((await read.json()) as { runtimeState: string }).runtimeState;
    if (seen === want || Date.now() > deadline) return seen;
    await Bun.sleep(200);
  }
}

beforeAll(() => {
  deps = createDevControlPlaneDeps();
  server = startDevControlPlane(deps, 0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

/** Spy handle: records every recordActivity call for the idle-timer test. */
class ActivitySpy implements WorkspaceRuntimeHandle {
  readonly activities: ActivityKind[] = [];
  async open(): Promise<string> {
    return "READY";
  }
  async stop(): Promise<string> {
    return "STOPPED";
  }
  getState(): string {
    return "READY";
  }
  recordActivity(kind: ActivityKind): void {
    this.activities.push(kind);
  }
  async assertAgentInputAllowed(): Promise<void> {}
  async runManualCheckpoint(): Promise<{ skipped: boolean }> {
    this.recordActivity("checkpoint");
    return { skipped: false };
  }
  async deleteInstance(): Promise<void> {}
  async getInstanceUrl(): Promise<string | null> {
    return null;
  }
}

describe("product UI static delivery (/app, issue #138)", () => {
  test("GET /app and /app/ with no auth headers -> 200 text/html", async () => {
    for (const path of ["/app", "/app/"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const body = await res.text();
      expect(body).toContain("/app/app.js");
      expect(body).toContain("/app/app.css");
    }
  });

  test("GET /app/app.js and /app/app.css -> 200 with JS/CSS types", async () => {
    const js = await fetch(`${base}/app/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toContain("parseSseChunks");
    const css = await fetch(`${base}/app/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  test("GET /app/sse.js serves the same shared parser as /ui/sse.js", async () => {
    const viaApp = await fetch(`${base}/app/sse.js`);
    expect(viaApp.status).toBe(200);
    const viaUi = await fetch(`${base}/ui/sse.js`);
    expect(viaUi.status).toBe(200);
    expect(await viaApp.text()).toBe(await viaUi.text());
  });

  test("product app.js shares the parser instead of copying it", async () => {
    const js = await Bun.file(join(import.meta.dir, "..", "public", "app", "app.js")).text();
    expect(js).toContain('from "./sse.js"');
    expect(js).not.toContain("function parseSseChunks");
  });

  test("HEAD /app -> 200 with an empty body", async () => {
    const res = await fetch(`${base}/app`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("");
  });

  test("static is GET/HEAD only: POST /app and DELETE /app/app.js -> 404", async () => {
    const post = await fetch(`${base}/app`, { method: "POST", headers: iap("alice") });
    expect(post.status).toBe(404);
    const del = await fetch(`${base}/app/app.js`, { method: "DELETE", headers: iap("alice") });
    expect(del.status).toBe(404);
  });

  test("dynamic /app/<id> pathnames are NOT served (screen uses ?ws=<id>)", async () => {
    // Falls through to routing, never the product HTML. (This file boots
    // the dev handler, so the headerless request runs as the fake-IAP dev
    // identity and answers 404 instead of 401 — either way, never HTML.)
    const anon = await fetch(`${base}/app/some-workspace-id`);
    expect(anon.status).toBe(404);
    expect(anon.headers.get("content-type")).toContain("application/json");
    // Authenticated: unknown route, JSON 404 — never the product HTML.
    const authed = await fetch(`${base}/app/some-workspace-id`, { headers: iap("alice") });
    expect(authed.status).toBe(404);
    expect(authed.headers.get("content-type")).toContain("application/json");
  });

  test("public/app ships all three files", async () => {
    for (const file of ["index.html", "app.js", "app.css"]) {
      const f = Bun.file(join(import.meta.dir, "..", "public", "app", file));
      expect(await f.exists()).toBe(true);
    }
  });

  test("product UI never uses the built-in browser SSE client or dialogs", async () => {
    const html = await Bun.file(join(import.meta.dir, "..", "public", "app", "index.html")).text();
    expect(html).not.toContain("EventSource");
    const js = await Bun.file(join(import.meta.dir, "..", "public", "app", "app.js")).text();
    expect(js).not.toContain("EventSource");
    expect(js).not.toContain("window.confirm");
    expect(js).not.toContain("window.alert");
  });

  test("serving product files never calls recordActivity (idle timer untouched)", async () => {
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo", baseBranch: "main" }),
    });
    const ws = (await created.json()) as { id: string };
    const spy = new ActivitySpy();
    deps.runtimes.set(ws.id, spy);

    for (const path of ["/app", "/app/", "/app/app.js", "/app/app.css", "/app/sse.js"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(200);
    }
    expect((await fetch(`${base}/app`, { method: "HEAD" })).status).toBe(200);
    expect(spy.activities).toEqual([]);
  });
});

describe("product UI vocabulary (issue #138 acceptance)", () => {
  test("served HTML shows no startup / single-writer internals", async () => {
    // The document prose is exactly what the user reads: no "open" / "lease"
    // words, no capability ids, no raw server state names.
    const html = await (await fetch(`${base}/app`)).text();
    expect(html).not.toMatch(/\bopen\b/i);
    expect(html).not.toMatch(/\blease\b/i);
    for (const word of [
      "controllerId",
      "approvalId",
      "seq",
      "STARTING",
      "RESTORING",
      "RESTORE_FAILED",
      "CHECKPOINT",
      "checkpoint",
    ]) {
      expect(html).not.toContain(word);
    }
  });

  test("served JS keeps startup / single-writer words out of its prose", async () => {
    // The JS necessarily names the wire format (the `/open` endpoint, the
    // `approvalId` event field, the state constants it translates): those
    // are code identifiers, never screen text. What the acceptance rule can
    // pin in source is that the "open" / "lease" WORDS appear nowhere but
    // the endpoint string — every user-facing word is Japanese.
    const js = await (await fetch(`${base}/app/app.js`)).text();
    const jsWithoutEndpoint = js.replaceAll('"/open"', "");
    expect(jsWithoutEndpoint).not.toMatch(/\bopen\b/i);
    expect(jsWithoutEndpoint).not.toMatch(/\blease\b/i);
    for (const word of ["使えます", "準備中です", "停止しています", "再開しています", "承認する", "却下する"]) {
      expect(js).toContain(word);
    }
  });

  test("product JS never touches the acquire / heartbeat / release / checkpoint routes", async () => {
    const js = await (await fetch(`${base}/app/app.js`)).text();
    expect(js).not.toContain("controller/acquire");
    expect(js).not.toContain("controller/heartbeat");
    expect(js).not.toContain("controller/release");
    expect(js).not.toContain("checkpoints");
  });

  test("product JS only reads the recordActivity-free routes on its own", async () => {
    // Every path the page fetches without a button press must be a read the
    // server deliberately keeps recordActivity-free (handlers + sse confirm
    // each of these; the sends stay user-initiated). The single-writer
    // status read is GET-only; message / approval sends come from clicks.
    const js = await (await fetch(`${base}/app/app.js`)).text();
    expect(js).toContain("/v1/workspaces");
    expect(js).toContain("/controller");
    expect(js).toContain("/events");
    expect(js).toContain("/sessions");
  });

  test("product JS retries a 409 send with one prepare + one retry (no double-send)", async () => {
    // Static pin for the sendFlow 409 branch: the API-level recovery test
    // below proves the server answers 409 before appending and that a
    // re-open recovers at seq 0, but nothing executes this JS — deleting the
    // branch would keep every API test green while the screen dead-ends on
    // a lapsed lease again. So pin the shape: inside sendFlow a 409
    // re-prepares via prepareAndWait and posts the same message once more,
    // documented as append-free (hence retry-safe).
    const js = await (await fetch(`${base}/app/app.js`)).text();
    expect(js.indexOf("async function sendFlow")).toBeGreaterThan(-1);
    const sendFlow = js.slice(js.indexOf("async function sendFlow"));
    expect(sendFlow.indexOf("sent.status === 409")).toBeGreaterThan(-1);
    const branch = sendFlow.slice(sendFlow.indexOf("sent.status === 409"));
    const prepareAt = branch.indexOf("prepareAndWait(false)");
    expect(prepareAt).toBeGreaterThan(-1);
    expect(branch.slice(prepareAt)).toContain("/messages");
    expect(branch).toContain("409 before appending");
  });
});

describe("product UI polling never extends the idle timer", () => {
  test("workspace + controller + list + sessions + SSE stay recordActivity-free", async () => {
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo", baseBranch: "main" }),
    });
    const ws = (await created.json()) as { id: string };
    const spy = new ActivitySpy();
    deps.runtimes.set(ws.id, spy);

    // Everything the product UI fires on its own (timers + stream + the
    // one-shot reads behind a screen render).
    expect((await fetch(`${base}/v1/workspaces`, { headers: iap("alice") })).status).toBe(200);
    expect((await fetch(`${base}/v1/workspaces/${ws.id}`, { headers: iap("alice") })).status).toBe(
      200,
    );
    expect(
      (await fetch(`${base}/v1/workspaces/${ws.id}/controller`, { headers: iap("alice") })).status,
    ).toBe(200);
    expect(
      (await fetch(`${base}/v1/workspaces/${ws.id}/sessions`, { headers: iap("alice") })).status,
    ).toBe(200);

    // The SSE stream: connect, read the opening bytes, then disconnect.
    const sessionRes = await fetch(`${base}/v1/workspaces/${ws.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({}),
    });
    const session = (await sessionRes.json()) as { id: string };
    const abort = new AbortController();
    const stream = await fetch(`${base}/v1/sessions/${session.id}/events?seq=0`, {
      headers: iap("alice"),
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    await reader.read();
    abort.abort();

    expect(spy.activities).toEqual([]);
  });

  test("sanity: a user-sent message DOES record activity (the spy is wired)", async () => {
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo", baseBranch: "main" }),
    });
    const ws = (await created.json()) as { id: string };
    const spy = new ActivitySpy();
    deps.runtimes.set(ws.id, spy);
    // Prepare establishes the single-writer role for the opener; the dev
    // stand-in answers 202 and flips to READY on its timer.
    const opened = await fetch(`${base}/v1/workspaces/${ws.id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({}),
    });
    expect([200, 202]).toContain(opened.status);
    const sessionRes = await fetch(`${base}/v1/workspaces/${ws.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({}),
    });
    const session = (await sessionRes.json()) as { id: string };
    const sent = await fetch(`${base}/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(sent.status).toBe(201);
    expect(spy.activities).toEqual(["user_message"]);
  });
});

describe("one-action start + transparent resume (API shape the UI drives)", () => {
  test("create -> prepare (202) -> poll to READY -> session -> message -> stop -> prepare again -> message", async () => {
    // 1 action on the home screen: create + prepare + session.
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo", baseBranch: "main" }),
    });
    expect(created.status).toBe(201);
    const ws = (await created.json()) as { id: string };

    const opened = await fetch(`${base}/v1/workspaces/${ws.id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(opened.status).toBe(202);
    expect((await opened.json()) as { state: string }).toMatchObject({ state: "STARTING" });
    expect(await waitForState(ws.id, "READY", DEV_OPEN_READY_DELAY_MS + 10_000)).toBe("READY");

    // Existing latest session is reused; a fresh workspace has none.
    const listed = await fetch(`${base}/v1/workspaces/${ws.id}/sessions`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { sessions: unknown[] }).sessions).toEqual([]);
    const made = await fetch(`${base}/v1/workspaces/${ws.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(made.status).toBe(201);
    const session = (await made.json()) as { id: string };

    const sent = await fetch(`${base}/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "first" }),
    });
    expect(sent.status).toBe(201);

    // Stop, then send again after re-preparing: the conversation continues
    // on the SAME session (transparent resume at the API layer).
    const stopped = await fetch(`${base}/v1/workspaces/${ws.id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(stopped.status).toBe(200);
    const reopened = await fetch(`${base}/v1/workspaces/${ws.id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(reopened.status).toBe(202);
    expect(await waitForState(ws.id, "READY", DEV_OPEN_READY_DELAY_MS + 10_000)).toBe("READY");

    const relisted = await fetch(`${base}/v1/workspaces/${ws.id}/sessions`);
    const sessions = ((await relisted.json()) as { sessions: { id: string }[] }).sessions;
    expect(sessions.map((s) => s.id)).toContain(session.id);

    const resent = await fetch(`${base}/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "second" }),
    });
    expect(resent.status).toBe(201);
    expect(((await resent.json()) as { seq: number }).seq).toBe(1);
  }, 30_000);

  test("READY with only the lease lost -> 409, then re-open recovers the same send at seq 0", async () => {
    // Pins the product UI's recovery procedure at the API layer: when the
    // workspace is READY but the controller lease alone has lapsed (the
    // permanent-409 dead end behind the UI's retry), a re-open re-establishes
    // the lease and the very same send succeeds — exactly once.
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo", baseBranch: "main" }),
    });
    expect(created.status).toBe(201);
    const ws = (await created.json()) as { id: string };

    const opened = await fetch(`${base}/v1/workspaces/${ws.id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(opened.status).toBe(202);
    expect(await waitForState(ws.id, "READY", DEV_OPEN_READY_DELAY_MS + 10_000)).toBe("READY");

    const made = await fetch(`${base}/v1/workspaces/${ws.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(made.status).toBe(201);
    const session = (await made.json()) as { id: string };

    const held = (await (await fetch(`${base}/v1/workspaces/${ws.id}/controller`)).json()) as {
      held: boolean;
    };
    expect(held.held).toBe(true);

    // Lose ONLY the lease: the row stays READY while getActive goes null —
    // the same API shape a 45s-lapsed lease has (release deletes the row,
    // expiry filters it out of getActive; both read identically here).
    const lease = await deps.leases.get(ws.id);
    expect(lease).not.toBeNull();
    await deps.leases.release(ws.id, lease!.controllerId);

    const read = await fetch(`${base}/v1/workspaces/${ws.id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { runtimeState: string }).runtimeState).toBe("READY");
    const lost = (await (await fetch(`${base}/v1/workspaces/${ws.id}/controller`)).json()) as {
      held: boolean;
    };
    expect(lost.held).toBe(false);

    // The dead end the UI retries against: 409 before anything is appended.
    const refused = await fetch(`${base}/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello after lease loss" }),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
      "no active controller",
    );

    // The UI's recovery (re-open, then send once more) succeeds on the same
    // session — and at seq 0, proving the 409 appended nothing: no double
    // send from the single retry.
    const reopened = await fetch(`${base}/v1/workspaces/${ws.id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(reopened.status).toBe(200);
    expect(((await reopened.json()) as { state: string }).state).toBe("READY");
    const regained = (await (await fetch(`${base}/v1/workspaces/${ws.id}/controller`)).json()) as {
      held: boolean;
    };
    expect(regained.held).toBe(true);

    const resent = await fetch(`${base}/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello after lease loss" }),
    });
    expect(resent.status).toBe(201);
    expect(((await resent.json()) as { seq: number }).seq).toBe(0);
  }, 30_000);
});
