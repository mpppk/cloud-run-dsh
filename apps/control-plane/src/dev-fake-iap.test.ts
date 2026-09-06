// Tests for the dev-only fake IAP (issue #138, fact 5).
//
// The product UI (/app) has no auth-header input box, so the dev server
// injects a default development identity when the request carries neither
// IAP header. Production (main.ts) must never see this path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createDevControlPlaneDeps,
  isDevFakeIapEnabled,
  startDevControlPlane,
  type RunningControlPlane,
} from "./dev.js";
import type { ControlPlaneDeps } from "./index.js";

describe("dev fake IAP (issue #138)", () => {
  let deps: ControlPlaneDeps;
  let server: RunningControlPlane;
  let base: string;
  const savedEnv = process.env["DSH_DEV_FAKE_IAP"];

  beforeAll(() => {
    delete process.env["DSH_DEV_FAKE_IAP"];
    deps = createDevControlPlaneDeps();
    server = startDevControlPlane(deps, 0);
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    if (savedEnv === undefined) delete process.env["DSH_DEV_FAKE_IAP"];
    else process.env["DSH_DEV_FAKE_IAP"] = savedEnv;
    server.stop();
  });

  function iap(user: string): Record<string, string> {
    return {
      "x-goog-authenticated-user-id": `accounts.google.com:${user}`,
      "x-goog-authenticated-user-email": `${user}@example.com`,
    };
  }

  test("headerless API requests run as the default dev identity (no 401)", async () => {
    const list = await fetch(`${base}/v1/workspaces`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ workspaces: [] });

    const created = await fetch(`${base}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()) as { ownerId: string }).toMatchObject({ ownerId: "dev" });
  });

  test("explicit headers win: another user sees none of the dev identity's workspaces", async () => {
    const alice = await fetch(`${base}/v1/workspaces`, { headers: iap("alice") });
    expect(alice.status).toBe(200);
    expect(await alice.json()).toEqual({ workspaces: [] });
  });

  test("a single explicit header disables injection for that request (still 401)", async () => {
    // Only the user-id header: parseIapHeaders needs both, and the fake
    // must not paper over a half-specified identity with a hybrid.
    const res = await fetch(`${base}/v1/workspaces`, {
      headers: { "x-goog-authenticated-user-id": "accounts.google.com:alice" },
    });
    expect(res.status).toBe(401);
  });

  test("DSH_DEV_FAKE_IAP=0 restores the 401 for headerless requests", async () => {
    process.env["DSH_DEV_FAKE_IAP"] = "0";
    try {
      const res = await fetch(`${base}/v1/workspaces`);
      expect(res.status).toBe(401);
      // Explicit headers still authenticate while disabled.
      const authed = await fetch(`${base}/v1/workspaces`, { headers: iap("alice") });
      expect(authed.status).toBe(200);
    } finally {
      delete process.env["DSH_DEV_FAKE_IAP"];
    }
  });

  test("isDevFakeIapEnabled parses the kill switch", () => {
    expect(isDevFakeIapEnabled({})).toBe(true);
    expect(isDevFakeIapEnabled({ DSH_DEV_FAKE_IAP: "0" })).toBe(false);
    expect(isDevFakeIapEnabled({ DSH_DEV_FAKE_IAP: "false" })).toBe(false);
    expect(isDevFakeIapEnabled({ DSH_DEV_FAKE_IAP: "no" })).toBe(false);
    expect(isDevFakeIapEnabled({ DSH_DEV_FAKE_IAP: "1" })).toBe(true);
  });

  test("production entrypoint never imports the dev module", async () => {
    const main = await Bun.file(join(import.meta.dir, "main.ts")).text();
    expect(main).not.toContain("./dev.js");
    expect(main).not.toContain("FakeIap");
    expect(main).not.toContain("FAKE_IAP");
  });
});
