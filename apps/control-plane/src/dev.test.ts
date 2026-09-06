// Tests for the local dev composition (src/dev.ts).
// Boots the real dev server on an ephemeral port (port 0) and exercises the
// auth / membership / open / controller surface end to end — no fixed ports,
// no real GCP or DB. Server is stopped cleanly in afterAll.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDevControlPlaneDeps, DEV_OPEN_READY_DELAY_MS } from "./dev.js";
import { startControlPlane, type RunningControlPlane } from "./server.js";
import type { ControlPlaneDeps } from "./index.js";

describe("dev composition (src/dev.ts)", () => {
  let deps: ControlPlaneDeps;
  let server: RunningControlPlane;
  let base: string;

  beforeAll(() => {
    deps = createDevControlPlaneDeps();
    // Port 0 = ephemeral; Bun reports the actually bound port on server.port.
    server = startControlPlane(deps, 0);
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop();
  });

  function iap(user: string): Record<string, string> {
    return {
      "x-goog-authenticated-user-id": `accounts.google.com:${user}`,
      "x-goog-authenticated-user-email": `${user}@example.com`,
    };
  }

  /** Polls GET until runtimeState matches (or the deadline passes). Returns the last seen state. */
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

  test("binds an ephemeral port, not a fixed one", () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(8787);
  });

  test("401 without IAP headers", async () => {
    const res = await fetch(`${base}/v1/workspaces`, { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
  });

  test("create + open workspace succeeds for the owner (issue #136: 202 STARTING, then READY)", async () => {
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo", baseBranch: "main" }),
    });
    expect(created.status).toBe(201);
    const ws = (await created.json()) as { id: string; ownerId: string };
    expect(ws.ownerId).toBe("alice");

    const opened = await fetch(`${base}/v1/workspaces/${ws.id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({}),
    });
    expect(opened.status).toBe(202);
    const body = await opened.json();
    expect(body.state).toBe("STARTING");
    // The dev stand-in for the agent-host flips the row to READY shortly after.
    expect(await waitForState(ws.id, "READY", DEV_OPEN_READY_DELAY_MS + 10_000)).toBe("READY");
  });

  test("403 for a non-member", async () => {
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("bob") },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo" }),
    });
    expect(created.status).toBe(201);
    const ws = (await created.json()) as { id: string };

    // carol is a known identity (dev resolves any IAP identity) but not a member.
    const res = await fetch(`${base}/v1/workspaces/${ws.id}`, {
      method: "GET",
      headers: iap("carol"),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("forbidden");
  });

  test("409 for an observer (member without the controller lease) posting a message", async () => {
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo" }),
    });
    const ws = (await created.json()) as { id: string };

    const sessionRes = await fetch(`${base}/v1/workspaces/${ws.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({}),
    });
    expect(sessionRes.status).toBe(201);
    const session = (await sessionRes.json()) as { id: string };

    // alice acquires the controller...
    const acquired = await fetch(`${base}/v1/workspaces/${ws.id}/controller/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({}),
    });
    expect(acquired.status).toBe(200);

    // ...and bob, a mere member-observer, is refused with 409.
    await deps.membership.addMember(ws.id, "bob");
    const res = await fetch(`${base}/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("bob") },
      body: JSON.stringify({ content: "hello from an observer" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("conflict");
  });

  test("open walks STARTING -> READY: GET and repo.getWorkspace agree (issues #131/#136)", async () => {
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo" }),
    });
    expect(created.status).toBe(201);
    const ws = (await created.json()) as { id: string };

    const opened = await fetch(`${base}/v1/workspaces/${ws.id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({}),
    });
    expect(opened.status).toBe(202);
    expect((await opened.json()).state).toBe("STARTING");

    const read = await fetch(`${base}/v1/workspaces/${ws.id}`, { headers: iap("alice") });
    expect(read.status).toBe(200);
    expect((await read.json()).runtimeState).toBe("STARTING");

    expect(await waitForState(ws.id, "READY", DEV_OPEN_READY_DELAY_MS + 10_000)).toBe("READY");
    expect((await deps.repo.getWorkspace(ws.id))?.runtimeState).toBe("READY");
  });

  test("stop persists STOPPED: GET and repo.getWorkspace agree (issue #131)", async () => {
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo" }),
    });
    expect(created.status).toBe(201);
    const ws = (await created.json()) as { id: string };

    const opened = await fetch(`${base}/v1/workspaces/${ws.id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({}),
    });
    expect(opened.status).toBe(202);

    const stopped = await fetch(`${base}/v1/workspaces/${ws.id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", ...iap("alice") },
      body: JSON.stringify({}),
    });
    expect(stopped.status).toBe(200);
    expect((await stopped.json()).state).toBe("STOPPED");

    const read = await fetch(`${base}/v1/workspaces/${ws.id}`, { headers: iap("alice") });
    expect(read.status).toBe(200);
    expect((await read.json()).runtimeState).toBe("STOPPED");
    expect((await deps.repo.getWorkspace(ws.id))?.runtimeState).toBe("STOPPED");
    // The pending READY timer was cancelled by the stop: even after its
    // delay passes, the row must stay STOPPED (never flip behind our back).
    await Bun.sleep(DEV_OPEN_READY_DELAY_MS + 500);
    expect((await deps.repo.getWorkspace(ws.id))?.runtimeState).toBe("STOPPED");
  });
});
