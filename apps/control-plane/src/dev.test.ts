// Tests for the local dev composition (src/dev.ts).
// Boots the real dev server on an ephemeral port (port 0) and exercises the
// auth / membership / open / controller surface end to end — no fixed ports,
// no real GCP or DB. Server is stopped cleanly in afterAll.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDevControlPlaneDeps } from "./dev.js";
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

  test("create + open workspace succeeds for the owner", async () => {
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
    expect(opened.status).toBe(200);
    const body = await opened.json();
    expect(body.state).toBe("READY");
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
});
