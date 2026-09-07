// Recorded-turn replay on the dev server (issue #147).
//
// The dev server has no agent-host, so without a replay a local message
// send appends only `user_message` — the events behind the #147 raw-JSON
// conversation never flow locally. These tests pin:
// - a dev message send appends the recorded production turn (the browser
//   then renders an agent-equivalent conversation through the same
//   describeEvent rules conversation-render.test.ts pins);
// - `DSH_DEV_SSE_REPLAY=0` disables the replay;
// - the production handler never replays (the replay lives in dev.ts only).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  clearCachedRecordedTurn,
  createDevControlPlaneDeps,
  isDevSseReplayEnabled,
  parseRecordedSse,
  startDevControlPlane,
  type RunningControlPlane,
} from "./dev.js";
import { createFetchHandler, type ControlPlaneDeps } from "./index.js";

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
    const read = await fetch(`${base}/v1/workspaces/${workspaceId}`, { headers: iap("alice") });
    expect(read.status).toBe(200);
    seen = ((await read.json()) as { runtimeState: string }).runtimeState;
    if (seen === want || Date.now() > deadline) return seen;
    await Bun.sleep(200);
  }
}

async function openWorkspace(): Promise<{ workspaceId: string; sessionId: string }> {
  const created = await fetch(`${base}/v1/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json", ...iap("alice") },
    body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo", baseBranch: "main" }),
  });
  expect(created.status).toBe(201);
  const ws = (await created.json()) as { id: string };
  const opened = await fetch(`${base}/v1/workspaces/${ws.id}/open`, {
    method: "POST",
    headers: { "content-type": "application/json", ...iap("alice") },
    body: JSON.stringify({}),
  });
  expect([200, 202]).toContain(opened.status);
  expect(await waitForState(ws.id, "READY", 15_000)).toBe("READY");
  const made = await fetch(`${base}/v1/workspaces/${ws.id}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...iap("alice") },
    body: JSON.stringify({}),
  });
  expect(made.status).toBe(201);
  return { workspaceId: ws.id, sessionId: ((await made.json()) as { id: string }).id };
}

beforeAll(() => {
  deps = createDevControlPlaneDeps();
  server = startDevControlPlane(deps, 0);
  base = `http://127.0.0.1:${server.port}`;
  clearCachedRecordedTurn();
});

afterAll(() => {
  server.stop();
  delete process.env["DSH_DEV_SSE_REPLAY"];
});

describe("dev recorded-turn replay (issue #147)", () => {
  test("isDevSseReplayEnabled defaults on, 0/false/no disables", () => {
    expect(isDevSseReplayEnabled({})).toBe(true);
    expect(isDevSseReplayEnabled({ DSH_DEV_SSE_REPLAY: "0" })).toBe(false);
    expect(isDevSseReplayEnabled({ DSH_DEV_SSE_REPLAY: "false" })).toBe(false);
    expect(isDevSseReplayEnabled({ DSH_DEV_SSE_REPLAY: "no" })).toBe(false);
    expect(isDevSseReplayEnabled({ DSH_DEV_SSE_REPLAY: "1" })).toBe(true);
  });

  test("a dev message send replays the recorded production turn", async () => {
    delete process.env["DSH_DEV_SSE_REPLAY"];
    const { sessionId } = await openWorkspace();
    const sent = await fetch(`${base}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({ content: "devからの送信テスト" }),
    });
    expect(sent.status).toBe(201);

    // The dev wrapper awaits the replay before answering 201, so the full
    // turn is already persisted here: 1 live user_message + 70 replayed
    // (the recording's own user_message is skipped, not doubled).
    const events = await deps.repo.readEvents(sessionId, 0);
    expect(events.length).toBe(71);
    expect(events[0]!.eventType).toBe("user_message");
    expect(events[0]!.data).toMatchObject({ content: "devからの送信テスト" });
    const types = events.map((e) => e.eventType);
    for (const want of [
      "request/header",
      "turn/start",
      "step/start",
      "assistant/chunk",
      "assistant/message",
      "tool/call",
      "tool/result",
      "step/end",
      "turn/end",
    ]) {
      expect(types).toContain(want);
    }
    // The agent's reply body from the recording flows to the local stream.
    const assistantTexts = events
      .filter((e) => e.eventType === "assistant/message")
      .map((e) => JSON.stringify(e.data));
    expect(assistantTexts.join("\n")).toContain("追加しました");
  }, 30_000);

  test("DSH_DEV_SSE_REPLAY=0 leaves only the live user_message", async () => {
    process.env["DSH_DEV_SSE_REPLAY"] = "0";
    try {
      const { sessionId } = await openWorkspace();
      const sent = await fetch(`${base}/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", ...iap("alice") },
        body: JSON.stringify({ content: "replay off" }),
      });
      expect(sent.status).toBe(201);
      const events = await deps.repo.readEvents(sessionId, 0);
      expect(events.length).toBe(1);
      expect(events[0]!.eventType).toBe("user_message");
    } finally {
      delete process.env["DSH_DEV_SSE_REPLAY"];
    }
  }, 30_000);
});

describe("replay never leaks into the production path (issue #147)", () => {
  test("production sources never reference the replay", async () => {
    // dev.ts + tests own the replay; main.ts composes createFetchHandler
    // directly and must stay free of it.
    const prodSources = [
      "main.ts",
      "index.ts",
      "server.ts",
      "handlers.ts",
      "sse.ts",
      "static.ts",
      "prod-adapters.ts",
      "forwarding.ts",
      "runtime-factory.ts",
      "config.ts",
      "deps.ts",
    ];
    for (const file of prodSources) {
      const src = await Bun.file(join(import.meta.dir, file)).text();
      for (const marker of [
        "DSH_DEV_SSE_REPLAY",
        "g2-sse",
        "testdata",
        "parseRecordedSse",
        "maybeReplay",
        "RecordedTurn",
      ]) {
        expect(src).not.toContain(marker);
      }
    }
    const dev = await Bun.file(join(import.meta.dir, "dev.ts")).text();
    expect(dev).toContain("DSH_DEV_SSE_REPLAY");
  });

  test("a message through the production handler appends exactly one event", async () => {
    const prodDeps = createDevControlPlaneDeps();
    const prodFetch = createFetchHandler(prodDeps);
    const call = async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: unknown }> => {
      const res = await prodFetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: { "content-type": "application/json", ...iap("bob") },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      return { status: res.status, json: res.status === 200 || res.status === 201 ? await res.json() : null };
    };
    const created = await call("POST", "/v1/workspaces", {
      repositoryOwner: "mpppk",
      repositoryName: "demo",
      baseBranch: "main",
    });
    expect(created.status).toBe(201);
    const wsId = (created.json as { id: string }).id;
    // Ready the row directly: the production handler has no dev stand-in
    // timer, and the lease heartbeat is a dev-only stand-in too — acquire
    // the controller role straight from the lease service instead.
    await prodDeps.repo.updateWorkspace(wsId, { runtimeState: "READY" });
    const made = await call("POST", `/v1/workspaces/${wsId}/sessions`, {});
    expect(made.status).toBe(201);
    const sessionId = (made.json as { id: string }).id;
    // Controller gate: hold the lease as the sender (resolveUser maps the
    // IAP header to the bare name, same as the dev-server open() path).
    const acquired = await prodDeps.leases.acquire(wsId, "ctrl-bob", "bob");
    expect(acquired.userId).toBe("bob");
    const sent = await call("POST", `/v1/sessions/${sessionId}/messages`, { content: "prod path" });
    expect(sent.status).toBe(201);
    const events = await prodDeps.repo.readEvents(sessionId, 0);
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("user_message");
  });
});

describe("parseRecordedSse", () => {
  test("parses the wire format and skips : comments", () => {
    const events = parseRecordedSse(
      'id: 0\nevent: user_message\ndata: {"content":"hi"}\n\n: stream open\n\nid: 1\nevent: turn/start\ndata: {"turn":1}\n\n',
    );
    expect(events).toEqual([
      { eventType: "user_message", data: { content: "hi" } },
      { eventType: "turn/start", data: { turn: 1 } },
    ]);
  });
});
