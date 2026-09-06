// Tests for the debug Web UI delivery (issue #128) and its SSE parser.
//
// The static allowlist (src/static.ts) must serve the UI without auth while
// leaving every existing route's behavior untouched — in particular unknown
// paths must still 401 before auth, never HTML. The SSE parser in
// public/app.js is imported directly (the file only touches `document`
// inside a guarded boot(), so it loads cleanly under bun test).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ActivityKind } from "@cloud-run-dsh/workspace-runtime";
import { createDevControlPlaneDeps } from "./dev.js";
import { startControlPlane, type RunningControlPlane } from "./server.js";
import type { ControlPlaneDeps, WorkspaceRuntimeHandle } from "./index.js";
import { createSseParser, leaseRole, parseSseChunks } from "../public/app.js";

let deps: ControlPlaneDeps;
let server: RunningControlPlane;
let base: string;

function iap(user: string): Record<string, string> {
  return {
    "x-goog-authenticated-user-id": `accounts.google.com:${user}`,
    "x-goog-authenticated-user-email": `${user}@example.com`,
  };
}

beforeAll(() => {
  deps = createDevControlPlaneDeps();
  server = startControlPlane(deps, 0);
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

describe("static UI delivery (issue #128)", () => {
  test("GET / with no auth headers -> 200 text/html", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("/ui/app.js");
    expect(body).toContain("/ui/app.css");
  });

  test("GET /ui and /ui/ serve the same HTML without auth", async () => {
    for (const path of ["/ui", "/ui/"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    }
  });

  test("GET /ui/app.js -> 200 text/javascript", async () => {
    const res = await fetch(`${base}/ui/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await res.text()).toContain("parseSseChunks");
  });

  test("GET /ui/app.css -> 200 text/css", async () => {
    const res = await fetch(`${base}/ui/app.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  test("HEAD / -> 200 with an empty body", async () => {
    const res = await fetch(`${base}/`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("");
  });

  test("static is GET/HEAD only: POST / and DELETE /ui/app.js -> 404", async () => {
    const post = await fetch(`${base}/`, { method: "POST", headers: iap("alice") });
    expect(post.status).toBe(404);
    const del = await fetch(`${base}/ui/app.js`, { method: "DELETE", headers: iap("alice") });
    expect(del.status).toBe(404);
  });

  test("existing routing is intact: /livez and /readyz answer 200 without auth", async () => {
    expect((await fetch(`${base}/livez`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  test("auth still runs before route existence: unauthenticated GET /nope -> 401", async () => {
    // The allowlist must NOT become a catch-all: /nope is not a UI path, so
    // it falls through to authenticate() exactly as before.
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(401);
  });

  test("authenticated GET /healthz -> 404 (issue #68: never served)", async () => {
    const res = await fetch(`${base}/healthz`, { headers: iap("alice") });
    expect(res.status).toBe(404);
  });

  test("authenticated unknown route -> 404 JSON, never HTML", async () => {
    const res = await fetch(`${base}/v1/definitely-not-a-route`, { headers: iap("alice") });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  test("existing /v1/* routes still work through the same server", async () => {
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo", baseBranch: "main" }),
    });
    expect(created.status).toBe(201);
    const ws = (await created.json()) as { id: string };
    const read = await fetch(`${base}/v1/workspaces/${ws.id}`, { headers: iap("alice") });
    expect(read.status).toBe(200);
  });

  test("public/ ships all three files", async () => {
    for (const file of ["index.html", "app.js", "app.css"]) {
      const f = Bun.file(join(import.meta.dir, "..", "public", file));
      expect(await f.exists()).toBe(true);
    }
  });

  test("index.html never uses the built-in browser SSE client (custom headers need fetch)", async () => {
    const html = await Bun.file(join(import.meta.dir, "..", "public", "index.html")).text();
    expect(html).not.toContain("EventSource");
    const js = await Bun.file(join(import.meta.dir, "..", "public", "app.js")).text();
    expect(js).not.toContain("EventSource");
  });

  test("serving static files never calls recordActivity (idle timer untouched)", async () => {
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo", baseBranch: "main" }),
    });
    const ws = (await created.json()) as { id: string };
    const spy = new ActivitySpy();
    deps.runtimes.set(ws.id, spy);

    for (const path of ["/", "/ui", "/ui/", "/ui/app.js", "/ui/app.css"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(200);
    }
    expect((await fetch(`${base}/`, { method: "HEAD" })).status).toBe(200);
    // A control-plane read for contrast goes through the same server.
    expect((await fetch(`${base}/v1/workspaces/${ws.id}`, { headers: iap("alice") })).status).toBe(
      200,
    );
    expect(spy.activities).toEqual([]);
  });
});

describe("leaseRole in public/app.js (issue #130)", () => {
  const NOW = Date.parse("2026-09-06T02:19:24.939Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  test("no held lease -> observer", () => {
    expect(leaseRole(null, NOW)).toBe("observer");
    expect(leaseRole(undefined, NOW)).toBe("observer");
  });

  test("expiresAt in the future -> controller", () => {
    const lease = { controllerId: "ctrl-1", expiresAt: iso(NOW + 10_000) };
    expect(leaseRole(lease, NOW)).toBe("controller");
  });

  test("expiresAt === now -> expired (matches T6 <= boundary)", () => {
    const lease = { controllerId: "ctrl-1", expiresAt: iso(NOW) };
    expect(leaseRole(lease, NOW)).toBe("expired");
  });

  test("expiresAt in the past -> expired", () => {
    const lease = { controllerId: "ctrl-1", expiresAt: iso(NOW - 35_000) };
    expect(leaseRole(lease, NOW)).toBe("expired");
  });

  test("unparseable expiresAt -> expired (never a false green)", () => {
    const lease = { controllerId: "ctrl-1", expiresAt: "not-a-date" };
    expect(leaseRole(lease, NOW)).toBe("expired");
  });

  test("re-rendering never fetches: app.js only polls the workspace list on the 15s stream timer", async () => {
    const js = await Bun.file(join(import.meta.dir, "..", "public", "app.js")).text();
    // The only setInterval in the page is the 1s role-badge re-render
    // (pure DOM) plus the 15s workspace refresh while streaming.
    const intervals = js.match(/setInterval\(/g) ?? [];
    expect(intervals.length).toBe(2);
    expect(js).toContain("setInterval(renderRole, 1000)");
  });
});

describe("SSE parser in public/app.js", () => {
  test("several events in one chunk", () => {
    const parser = createSseParser();
    const out = parseSseChunks(
      parser,
      'id: 0\nevent: user_message\ndata: {"content":"hi"}\n\n' +
        "id: 1\nevent: turn/start\ndata: {}\n\n",
    );
    expect(out.gaps).toEqual([]);
    expect(out.duplicates).toBe(0);
    expect(out.events).toHaveLength(2);
    expect(out.events[0]).toMatchObject({ seq: 0, eventType: "user_message" });
    expect(out.events[0]!.data).toEqual({ content: "hi" });
    expect(out.events[1]).toMatchObject({ seq: 1, eventType: "turn/start" });
  });

  test("one event split across chunks", () => {
    const parser = createSseParser();
    const first = parseSseChunks(parser, 'id: 7\nevent: tool/ca');
    expect(first.events).toEqual([]);
    const second = parseSseChunks(parser, 'll\ndata: {"tool":"bas');
    expect(second.events).toEqual([]);
    const third = parseSseChunks(parser, 'h"}\n\n');
    expect(third.events).toHaveLength(1);
    expect(third.events[0]).toMatchObject({ seq: 7, eventType: "tool/call" });
    expect(third.events[0]!.data).toEqual({ tool: "bash" });
  });

  test("colon comments (heartbeats) are ignored", () => {
    const parser = createSseParser();
    const out = parseSseChunks(
      parser,
      ": stream open\n\n: ping\n\nid: 0\nevent: user_message\ndata: {}\n\n",
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ seq: 0, eventType: "user_message" });
  });

  test("duplicate seq is dropped", () => {
    const parser = createSseParser();
    parseSseChunks(parser, "id: 0\nevent: a\ndata: {}\n\nid: 1\nevent: b\ndata: {}\n\n");
    const replay = parseSseChunks(parser, "id: 1\nevent: b\ndata: {}\n\n");
    expect(replay.duplicates).toBe(1);
    expect(replay.events).toEqual([]);
    expect(replay.gaps).toEqual([]);
  });

  test("a skipped seq is reported as a gap", () => {
    const parser = createSseParser();
    parseSseChunks(parser, "id: 0\nevent: a\ndata: {}\n\n");
    const out = parseSseChunks(parser, "id: 2\nevent: c\ndata: {}\n\n");
    expect(out.events).toHaveLength(1);
    expect(out.gaps).toEqual([{ expected: 1, got: 2 }]);
  });

  test("resumed parsers seeded with (resumeFrom - 1) see no false gap", () => {
    const parser = createSseParser();
    parser.lastSeq = 4; // reconnecting with ?seq=5
    const out = parseSseChunks(parser, "id: 5\nevent: b\ndata: {}\n\n");
    expect(out.gaps).toEqual([]);
    expect(out.events).toHaveLength(1);
  });

  test("events without id pass through with seq null; multi-line data joins", () => {
    const parser = createSseParser();
    const out = parseSseChunks(parser, "event: ping\ndata: line1\ndata: line2\n\n");
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ seq: null, eventType: "ping" });
    expect(out.events[0]!.data).toBe("line1\nline2");
  });
});
