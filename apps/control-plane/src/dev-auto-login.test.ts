// Tests for the dev-only auto-login (issue #152).
//
// The product UI (/app) has no login screen in this milestone and the dev
// server has no GitHub OAuth credentials, so the dev server issues a real
// server-side session for a fixed dev principal when the request carries no
// valid session cookie. Production (main.ts) must never see this path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDevControlPlaneDeps,
  DEV_USER,
  isDevAutoLoginEnabled,
  startDevControlPlane,
  type RunningControlPlane,
} from "./dev.js";
import { SESSION_COOKIE_NAME } from "./index.js";
import type { ControlPlaneDeps } from "./index.js";

describe("dev auto-login (issue #152)", () => {
  let deps: ControlPlaneDeps;
  let server: RunningControlPlane;
  let base: string;
  const savedAutoLogin = process.env["DSH_DEV_AUTO_LOGIN"];

  beforeAll(() => {
    delete process.env["DSH_DEV_AUTO_LOGIN"];
    deps = createDevControlPlaneDeps();
    server = startDevControlPlane(deps, 0);
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    if (savedAutoLogin === undefined) delete process.env["DSH_DEV_AUTO_LOGIN"];
    else process.env["DSH_DEV_AUTO_LOGIN"] = savedAutoLogin;
    server.stop();
  });

  test("isDevAutoLoginEnabled defaults on and honors off values", () => {
    expect(isDevAutoLoginEnabled({})).toBe(true);
    expect(isDevAutoLoginEnabled({ DSH_DEV_AUTO_LOGIN: "0" })).toBe(false);
    expect(isDevAutoLoginEnabled({ DSH_DEV_AUTO_LOGIN: "false" })).toBe(false);
    expect(isDevAutoLoginEnabled({ DSH_DEV_AUTO_LOGIN: "1" })).toBe(true);
  });

  test("headerless API requests run as the dev identity with a Set-Cookie (no 401)", async () => {
    const list = await fetch(`${base}/v1/workspaces`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ workspaces: [] });
    const setCookie = list.headers.get("set-cookie");
    expect(setCookie).toContain(SESSION_COOKIE_NAME);

    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()) as { ownerId: string }).toMatchObject({
      ownerId: DEV_USER.id,
    });
    expect(DEV_USER).toMatchObject({ id: "github:1", login: "dev" });
  });

  test("an explicit valid session wins over auto-login", async () => {
    // A second principal's cookie sees none of the dev identity's workspaces.
    const other = await deps.sessions.createSession(
      { id: "github:2", provider: "github", providerUserId: "2", login: "bob" },
      new Date(),
    );
    const res = await fetch(`${base}/v1/workspaces`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${other.rawToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaces: [] });
    // ... and no fresh Set-Cookie is issued for an already-valid session.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("legacy proxy identity headers alone authenticate nothing on the dev server", async () => {
    // Only the session cookie authenticates: arbitrary caller-supplied
    // identity headers are ignored. Auto-login is enabled here, so the
    // request still succeeds — but as the DEV identity, never as the
    // header's "alice".
    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-legacy-proxy-user-id": "accounts.example.com:alice",
        "x-legacy-proxy-user-email": "alice@example.com",
      },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo2" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()) as { ownerId: string }).toMatchObject({
      ownerId: DEV_USER.id,
    });
  });

  test("DSH_DEV_AUTO_LOGIN=0 restores the 401 for cookie-less requests", async () => {
    process.env["DSH_DEV_AUTO_LOGIN"] = "0";
    try {
      const res = await fetch(`${base}/v1/workspaces`);
      expect(res.status).toBe(401);
      // An explicit valid session still authenticates while disabled.
      const other = await deps.sessions.createSession(
        { id: "github:3", provider: "github", providerUserId: "3", login: "carol" },
        new Date(),
      );
      const authed = await fetch(`${base}/v1/workspaces`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${other.rawToken}` },
      });
      expect(authed.status).toBe(200);
    } finally {
      delete process.env["DSH_DEV_AUTO_LOGIN"];
    }
  });

  test("A5: expired cookie recovers to a fresh dev session (no 401, no duplicate)", async () => {
    // A session minted at epoch is long expired; auto-login must replace it
    // with exactly one fresh value instead of appending a second one.
    const stale = await deps.sessions.createSession(
      { id: "github:1", provider: "github", providerUserId: "1", login: "dev" },
      new Date(0),
    );
    const res = await fetch(`${base}/v1/workspaces`, {
      headers: { cookie: `other=1; ${SESSION_COOKIE_NAME}=${stale.rawToken}` },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(SESSION_COOKIE_NAME);
    const freshRaw = setCookie.split(";")[0]!.split("=")[1]!;
    expect(freshRaw).not.toBe(stale.rawToken);
    expect(await deps.sessions.lookupSession(freshRaw, new Date())).not.toBeNull();
  });

  test("A5: garbage / duplicated session cookies recover to one fresh session", async () => {
    for (const cookie of [
      `${SESSION_COOKIE_NAME}=garbage-value`,
      `${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}=b`,
      `${SESSION_COOKIE_NAME}=`,
    ]) {
      const res = await fetch(`${base}/v1/workspaces`, { headers: { cookie } });
      expect(res.status, cookie).toBe(200);
      // The response carries exactly one session Set-Cookie (replace, not stack).
      const issued = res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      expect(issued).toHaveLength(1);
    }
  });
});
