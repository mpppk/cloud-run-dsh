// Request-shape contract for scripts/verify-issue155-e2e.ts (issue #155, F1).
//
// The verifier must pass against a correct public plane, so the exact
// request shapes it relies on are pinned here against the production fetch
// handler with OAuth configured: auth (401) and CSRF (403) boundaries stay
// distinct because checkMutationGuards runs BEFORE authenticateSession.
// If middleware order ever changes, these fail first — not the E2E run.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import { InMemoryLeaseStore } from "@cloud-run-dsh/controller-lease/testing";
import { PostgresSessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import {
  createControlPlaneDeps,
  createFetchHandler,
  InMemoryMembershipStore,
  RuntimeRegistry,
  SESSION_COOKIE_NAME,
  SystemClock,
  type ControlPlaneDeps,
} from "./index.js";

const APP_ORIGIN = "https://dsh-control-abc.run.app";

describe("issue #155 verifier request shapes (F1)", () => {
  let deps: ControlPlaneDeps;
  let server: { stop(closeActiveConnections?: boolean): void; url: URL };
  let sessionCookie: string;

  beforeAll(async () => {
    const clock = new SystemClock();
    deps = createControlPlaneDeps({
      repo: new PostgresSessionPersistenceRepository(new InMemoryFakeExecutor()),
      leases: new ControllerLeaseService({ store: new InMemoryLeaseStore(), clock }),
      membership: new InMemoryMembershipStore(),
      runtimes: new RuntimeRegistry(() => {
        throw new Error("no runtime needed");
      }),
      clock,
      oauth: {
        appOrigin: APP_ORIGIN,
        githubClientId: "Iv1.test",
        githubClientSecret: "secret",
      },
    });
    server = Bun.serve({ port: 0, fetch: createFetchHandler(deps) });
    const created = await deps.sessions.createSession(
      { id: "github:1", provider: "github", providerUserId: "1", login: "alice" },
      new Date(),
    );
    sessionCookie = `${SESSION_COOKIE_NAME}=${created.rawToken}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  const call = (
    method: string,
    path: string,
    init: { body?: unknown; origin?: string | null; cookie?: string | null } = {},
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.origin !== undefined && init.origin !== null) headers["origin"] = init.origin;
    if (init.cookie !== undefined && init.cookie !== null) headers["cookie"] = init.cookie;
    return fetch(`${server.url.origin}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  };

  const workspaceBody = { repositoryOwner: "mpppk", repositoryName: "demo" };

  test("anonymous GET /v1/* -> 401 (auth boundary, no Origin involved)", async () => {
    expect((await call("GET", "/v1/workspaces")).status).toBe(401);
  });

  test("anonymous same-origin POST -> 401 (reaches the session gate past the Origin guard)", async () => {
    // scripts/verify-issue155-e2e.ts anonymous-post-401 relies on this.
    expect((await call("POST", "/v1/workspaces", { body: workspaceBody, origin: APP_ORIGIN })).status).toBe(
      401,
    );
  });

  test("anonymous POST without Origin -> 403 (guard precedes auth on an OAuth-configured plane)", async () => {
    // scripts/verify-issue155-e2e.ts anonymous-post-no-origin-403 relies on this.
    expect((await call("POST", "/v1/workspaces", { body: workspaceBody })).status).toBe(403);
  });

  test("authenticated foreign-origin POST -> 403 (CSRF boundary)", async () => {
    expect(
      (
        await call("POST", "/v1/workspaces", {
          body: workspaceBody,
          origin: "https://evil.example",
          cookie: sessionCookie,
        })
      ).status,
    ).toBe(403);
  });

  test("authenticated same-origin POST -> 201 (the happy path the verifier walks)", async () => {
    expect(
      (
        await call("POST", "/v1/workspaces", {
          body: workspaceBody,
          origin: APP_ORIGIN,
          cookie: sessionCookie,
        })
      ).status,
    ).toBe(201);
  });
});
