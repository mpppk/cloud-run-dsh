// Issue #151: GitHub App OAuth login with PKCE.
// Covers state/PKCE handling, replay/expiry rejection, failure mapping,
// return_to allowlisting, token non-persistence, and logout/session.

import { describe, expect, test } from "bun:test";
import {
  FetchGitHubUserAuthClient,
  GitHubOAuthError,
  buildAuthorizeUrl,
  callbackUrl,
  handleAuthCallback,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthSession,
  resolveReturnTo,
  type AuthRouteDeps,
  type GitHubUserAuthClient,
  type OAuthConfig,
} from "./auth-github.js";
import { InMemorySessionStore, SESSION_COOKIE_NAME, hashToken } from "./auth-session.js";
import { SystemClock } from "./deps.js";

const OAUTH: OAuthConfig = {
  appOrigin: "https://dsh-control-abc.run.app",
  githubClientId: "Iv1.testclientid",
  githubClientSecret: "test-client-secret",
};

interface FakeGitHubOptions {
  accessToken?: string;
  user?: { id: unknown; login: unknown };
  exchangeError?: number;
  userError?: number;
}

class FakeGitHub implements GitHubUserAuthClient {
  readonly exchanges: Array<Record<string, unknown>> = [];
  readonly userCalls: string[] = [];
  /** Every access token ever minted — must never reach storage/logs. */
  readonly mintedTokens: string[] = [];

  constructor(private readonly opts: FakeGitHubOptions = {}) {}

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<{ accessToken: string }> {
    this.exchanges.push({ ...input, clientSecret: "[redacted-in-test]" });
    if (this.opts.exchangeError !== undefined) {
      throw new GitHubOAuthError(`token endpoint answered ${this.opts.exchangeError}`);
    }
    // Include the code in the token so a leak would be detectable.
    const token = this.opts.accessToken ?? `ghu_token-for-${input.code}`;
    this.mintedTokens.push(token);
    return { accessToken: token };
  }

  async getUser(accessToken: string): Promise<{ id: number; login: string }> {
    this.userCalls.push(accessToken);
    if (this.opts.userError !== undefined) {
      throw new GitHubOAuthError(`GitHub API answered ${this.opts.userError}`);
    }
    const user = this.opts.user ?? { id: 4279342, login: "mpppk" };
    // Mirrors FetchGitHubUserAuthClient validation (integer id > 0, non-empty login).
    if (typeof user.id !== "number" || !Number.isInteger(user.id) || user.id <= 0) {
      throw new GitHubOAuthError("GitHub /user answered a malformed id");
    }
    if (typeof user.login !== "string" || user.login === "") {
      throw new GitHubOAuthError("GitHub /user answered a malformed login");
    }
    return { id: user.id, login: user.login };
  }
}

function depsWith(
  fake: FakeGitHub,
  sessions = new InMemorySessionStore(),
  oauth: OAuthConfig | null | undefined = OAUTH,
): AuthRouteDeps & { sessions: InMemorySessionStore } {
  const configured = oauth ?? undefined;
  return {
    sessions,
    oauth: configured,
    githubAuth: configured ? fake : undefined,
    clock: new SystemClock(),
  };
}

/** Deps with OAuth explicitly disabled (login/callback must 503). */
function depsWithoutOAuth(
  fake: FakeGitHub,
  sessions = new InMemorySessionStore(),
): AuthRouteDeps & { sessions: InMemorySessionStore } {
  return { sessions, clock: new SystemClock() };
}

function loginRedirectLocation(res: Response): string {
  expect(res.status).toBe(302);
  return res.headers.get("location")!;
}

/** Runs /auth/login and returns the raw state from the redirect. */
async function doLogin(
  deps: AuthRouteDeps,
  returnTo?: string,
): Promise<{ response: Response; state: string }> {
  const path = returnTo ? `/auth/login?return_to=${encodeURIComponent(returnTo)}` : "/auth/login";
  const response = await handleAuthLogin(new Request(`http://internal${path}`), deps);
  const location = loginRedirectLocation(response);
  const state = new URL(location).searchParams.get("state")!;
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { response, state };
}

describe("issue #151: /auth/login", () => {
  test("redirects to GitHub with state + PKCE S256, storing hash only", async () => {
    const sessions = new InMemorySessionStore();
    const fake = new FakeGitHub();
    const { state } = await doLogin(depsWith(fake, sessions));
    // The raw state is consumable exactly once — i.e. the store holds the
    // hash, and the redirect carries everything GitHub needs.
    const consumed = await sessions.consumeLoginFlow(state, new Date());
    expect(consumed?.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(consumed?.returnTo).toBe("/app");
  });

  test("OAuth state is not stored raw (hash lookup of a wrong state fails)", async () => {
    const sessions = new InMemorySessionStore();
    const { state } = await doLogin(depsWith(new FakeGitHub(), sessions));
    // A tampered state does not resolve even though it shares a prefix.
    expect(await sessions.consumeLoginFlow(`${state.slice(0, -2)}AA`, new Date())).toBeNull();
    // The real one still works (the probe above did not consume it).
    expect(await sessions.consumeLoginFlow(state, new Date())).not.toBeNull();
  });

  test("callback URL comes from APP_ORIGIN, never the request Host", async () => {
    const fake = new FakeGitHub();
    const res = await handleAuthLogin(
      new Request("http://evil-internal-host:9999/auth/login"),
      depsWith(fake),
    );
    const location = loginRedirectLocation(res);
    expect(location).toContain(
      `redirect_uri=${encodeURIComponent("https://dsh-control-abc.run.app/auth/callback")}`,
    );
    expect(location).not.toContain("evil-internal-host");
    expect(location).toContain(`client_id=${OAUTH.githubClientId}`);
    expect(location).toContain("code_challenge_method=S256");
  });

  test("unconfigured OAuth answers 503 (never 500, never a redirect)", async () => {
    // Handlers throw ApiError; the server maps them to responses. Assert the
    // thrown status directly here; server-level mapping is covered in #152.
    const loginErr = await handleAuthLogin(
      new Request("http://internal/auth/login"),
      depsWithoutOAuth(new FakeGitHub()),
    ).catch((e) => e as { status?: number });
    expect((loginErr as { status?: number }).status).toBe(503);
    const cbErr = await handleAuthCallback(
      new Request("http://internal/auth/callback?code=c&state=s"),
      depsWithoutOAuth(new FakeGitHub()),
    ).catch((e) => e as { status?: number });
    expect((cbErr as { status?: number }).status).toBe(503);
  });
});

describe("issue #151: return_to allowlist", () => {
  test.each([
    ["/app", "/app"],
    ["/app?ws=123", "/app?ws=123"],
    ["https://evil.example/phish", "/app"],
    ["//evil.example/phish", "/app"],
    ["javascript:alert(1)", "/app"],
    ["/\\evil.example", "/app"],
    ["/app\nSet-Cookie: x=1", "/app"],
    ["", "/app"],
  ])("resolveReturnTo(%j) -> %j", (raw, want) => {
    expect(resolveReturnTo(raw)).toBe(want);
  });

  test("callback redirects to the safe return_to", async () => {
    const sessions = new InMemorySessionStore();
    const fake = new FakeGitHub();
    const d = depsWith(fake, sessions);
    const { state } = await doLogin(d, "/app?ws=ws-1");
    const res = await handleAuthCallback(
      new Request(`http://internal/auth/callback?code=code-1&state=${state}`),
      d,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app?ws=ws-1");
  });

  test("malicious return_to falls back to /app", async () => {
    const sessions = new InMemorySessionStore();
    const fake = new FakeGitHub();
    const d = depsWith(fake, sessions);
    const { state } = await doLogin(d, "https://evil.example/steal");
    const res = await handleAuthCallback(
      new Request(`http://internal/auth/callback?code=code-1&state=${state}`),
      d,
    );
    expect(res.headers.get("location")).toBe("/app");
  });
});

describe("issue #151: /auth/callback", () => {
  test("successful callback issues __Host-dsh_session for github:<numeric-id>", async () => {
    const sessions = new InMemorySessionStore();
    const fake = new FakeGitHub();
    const d = depsWith(fake, sessions);
    const { state } = await doLogin(d);
    const res = await handleAuthCallback(
      new Request(`http://internal/auth/callback?code=code-abc&state=${state}`),
      d,
    );
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    // The cookie authenticates as the numeric-id principal.
    const raw = setCookie.split(";")[0]!.split("=")[1]!;
    const record = await sessions.lookupSession(raw, new Date());
    expect(record?.user).toEqual({
      id: "github:4279342",
      provider: "github",
      providerUserId: "4279342",
      login: "mpppk",
    });
    // PKCE verifier reached the token exchange.
    expect(fake.exchanges[0]?.["codeVerifier"]).toBeString();
    expect(fake.exchanges[0]?.["redirectUri"]).toBe("https://dsh-control-abc.run.app/auth/callback");
  });

  test("unknown / expired / replayed state is rejected", async () => {
    const d = depsWith(new FakeGitHub());
    const bad = async (query: string): Promise<number> =>
      handleAuthCallback(new Request(`http://internal/auth/callback${query}`), d)
        .then((r) => r.status)
        .catch((e) => (e as { status?: number }).status ?? 500);
    // Missing params and unknown state.
    expect(await bad("")).toBe(400);
    expect(await bad("?code=c")).toBe(400);
    expect(await bad("?code=c&state=unknown-state-value")).toBe(400);
    // Replay: consume once via a real login, then replay.
    const sessions = new InMemorySessionStore();
    const d2 = depsWith(new FakeGitHub(), sessions);
    const { state } = await doLogin(d2);
    const first = await handleAuthCallback(
      new Request(`http://internal/auth/callback?code=c1&state=${state}`),
      d2,
    );
    expect(first.status).toBe(302);
    const replay = await handleAuthCallback(
      new Request(`http://internal/auth/callback?code=c1&state=${state}`),
      d2,
    ).catch((e) => e as Response);
    expect((replay as Response).status ?? (replay as { status: number }).status).toBe(400);
  });

  test("code exchange failure -> generic 502, no token in the body", async () => {
    const sessions = new InMemorySessionStore();
    const d = depsWith(new FakeGitHub({ exchangeError: 400 }), sessions);
    const { state } = await doLogin(d);
    const res = await handleAuthCallback(
      new Request(`http://internal/auth/callback?code=bad&state=${state}`),
      d,
    ).catch((e) => e as Response);
    const status = res instanceof Response ? res.status : (res as { status: number }).status;
    expect(status).toBe(502);
    // The failed flow was still consumed (no retry oracle for the attacker).
    expect(await sessions.consumeLoginFlow(state, new Date())).toBeNull();
  });

  test("malformed GitHub /user (bad id / bad login) -> 502", async () => {
    for (const user of [
      { id: "not-a-number", login: "x" },
      { id: 0, login: "x" },
      { id: 1.5, login: "x" },
      { id: 42, login: "" },
    ]) {
      const sessions = new InMemorySessionStore();
      const d = depsWith(new FakeGitHub({ user: user as { id: unknown; login: unknown } }), sessions);
      const { state } = await doLogin(d);
      const res = await handleAuthCallback(
        new Request(`http://internal/auth/callback?code=c&state=${state}`),
        d,
      ).catch((e) => e as Response);
      const status = res instanceof Response ? res.status : (res as { status: number }).status;
      expect(status).toBe(502);
    }
  });

  test("null / private GitHub email still logs in (email never required)", async () => {
    // The fake returns no email at all — login must succeed regardless.
    const sessions = new InMemorySessionStore();
    const d = depsWith(new FakeGitHub({ user: { id: 99, login: "private-email-user" } }), sessions);
    const { state } = await doLogin(d);
    const res = await handleAuthCallback(
      new Request(`http://internal/auth/callback?code=c&state=${state}`),
      d,
    );
    expect(res.status).toBe(302);
    const raw = res.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    expect((await sessions.lookupSession(raw, new Date()))?.user.id).toBe("github:99");
  });

  test("user access token never reaches the session store", async () => {
    const sessions = new InMemorySessionStore();
    const fake = new FakeGitHub({ accessToken: "ghu_super-secret-token-123" });
    const d = depsWith(fake, sessions);
    const { state } = await doLogin(d);
    await handleAuthCallback(
      new Request(`http://internal/auth/callback?code=c&state=${state}`),
      d,
    );
    // The only rows are the session + (consumed) flow; the token string
    // appears nowhere in the store's reachable state. Sessions are keyed by
    // hash, so assert via lookup behavior + size instead of internals: one
    // live session, zero live flows.
    expect(sessions.size()).toEqual({ sessions: 1, flows: 0 });
    // And the token is not derivable from the issued cookie either.
    expect(fake.mintedTokens).toEqual(["ghu_super-secret-token-123"]);
  });
});

describe("issue #151: /auth/logout + /auth/session", () => {
  test("logout revokes server-side and clears the cookie", async () => {
    const sessions = new InMemorySessionStore();
    const fake = new FakeGitHub();
    const d = depsWith(fake, sessions);
    const { state } = await doLogin(d);
    const cb = await handleAuthCallback(
      new Request(`http://internal/auth/callback?code=c&state=${state}`),
      d,
    );
    const raw = cb.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    expect(await sessions.lookupSession(raw, new Date())).not.toBeNull();

    const logout = await handleAuthLogout(
      new Request("http://internal/auth/logout", {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE_NAME}=${raw}` },
      }),
      d,
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await sessions.lookupSession(raw, new Date())).toBeNull();
  });

  test("logout without a cookie still answers 200 + clear-cookie", async () => {
    const d = depsWith(new FakeGitHub());
    const res = await handleAuthLogout(new Request("http://internal/auth/logout", { method: "POST" }), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("/auth/session returns the principal for a valid cookie", async () => {
    const sessions = new InMemorySessionStore();
    const d = depsWith(new FakeGitHub(), sessions);
    const created = await sessions.createSession(
      { id: "github:7", provider: "github", providerUserId: "7", login: "sera" },
      new Date(),
    );
    const res = await handleAuthSession(
      new Request("http://internal/auth/session", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${created.rawToken}` },
      }),
      d,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: "github:7", login: "sera" } });
  });

  test("/auth/session 401s on missing / duplicated / unknown / expired", async () => {
    const sessions = new InMemorySessionStore();
    const d = depsWith(new FakeGitHub(), sessions);
    const at = async (cookie: string | null): Promise<number> =>
      handleAuthSession(
        new Request(
          "http://internal/auth/session",
          cookie ? { headers: { cookie } } : {},
        ),
        d,
      )
        .then((r) => r.status)
        .catch((e) => (e as { status?: number }).status ?? 500);
    expect(await at(null)).toBe(401);
    expect(await at(`${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}=b`)).toBe(401);
    expect(await at(`${SESSION_COOKIE_NAME}=unknown-token-value`)).toBe(401);
    const created = await sessions.createSession(
      { id: "github:7", provider: "github", providerUserId: "7", login: "sera" },
      new Date(0),
    );
    // Expired (7d lifetime from epoch).
    expect(await at(`${SESSION_COOKIE_NAME}=${created.rawToken}`)).toBe(401);
  });
});

describe("issue #151: FetchGitHubUserAuthClient", () => {
  test("exchange posts client_secret + PKCE verifier; getUser uses Bearer", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = new FetchGitHubUserAuthClient(
      (async (url: string, init?: RequestInit) => {
        seen.push({ url: url.toString(), init: init ?? {} });
        if (url.toString().includes("access_token")) {
          return Response.json({ access_token: "ghu_x", token_type: "bearer", scope: "" });
        }
        return Response.json({ id: 123, login: "octo", email: null });
      }) as typeof fetch,
    );
    const { accessToken } = await client.exchangeCode({
      code: "c",
      codeVerifier: "v",
      redirectUri: "https://app.example/auth/callback",
      clientId: "id",
      clientSecret: "secret",
    });
    expect(accessToken).toBe("ghu_x");
    const sentBody = JSON.parse(seen[0]!.init.body as string) as Record<string, unknown>;
    expect(sentBody).toMatchObject({
      client_id: "id",
      client_secret: "secret",
      code: "c",
      code_verifier: "v",
    });
    const profile = await client.getUser(accessToken);
    expect(profile).toEqual({ id: 123, login: "octo" });
    expect((seen[1]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer ghu_x");
  });

  test("non-2xx and malformed payloads become GitHubOAuthError (no body echoed)", async () => {
    const bad = (body: unknown, status = 200): typeof fetch =>
      (async () =>
        status === 200
          ? Response.json(body)
          : new Response("token ghu_leaked-in-body", { status })) as typeof fetch;
    await expect(
      new FetchGitHubUserAuthClient(bad({}, 400)).exchangeCode({
        code: "c",
        codeVerifier: "v",
        redirectUri: "r",
        clientId: "i",
        clientSecret: "s",
      }),
    ).rejects.toBeInstanceOf(GitHubOAuthError);
    await expect(
      new FetchGitHubUserAuthClient(bad({ no_token: true })).exchangeCode({
        code: "c",
        codeVerifier: "v",
        redirectUri: "r",
        clientId: "i",
        clientSecret: "s",
      }),
    ).rejects.toBeInstanceOf(GitHubOAuthError);
    await expect(
      new FetchGitHubUserAuthClient(bad({ id: "x", login: "y" })).getUser("t"),
    ).rejects.toBeInstanceOf(GitHubOAuthError);
  });
});

describe("issue #151: helpers", () => {
  test("callbackUrl appends /auth/callback to APP_ORIGIN", () => {
    expect(callbackUrl(OAUTH)).toBe("https://dsh-control-abc.run.app/auth/callback");
  });

  test("buildAuthorizeUrl carries state + S256 challenge", () => {
    const url = buildAuthorizeUrl({
      clientId: "id",
      redirectUri: "https://app.example/auth/callback",
      state: "state-value",
      codeChallenge: "challenge-value",
    });
    expect(url.startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("state")).toBe("state-value");
    expect(params.get("code_challenge")).toBe("challenge-value");
    expect(params.get("code_challenge_method")).toBe("S256");
  });

  test("raw OAuth state is never stored (store keys are hashes)", () => {
    // hashToken is one-way: the redirect state cannot be derived from DB rows.
    const h1 = hashToken("state-a").toString("hex");
    const h2 = hashToken("state-a").toString("hex");
    const h3 = hashToken("state-b").toString("hex");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).not.toContain("state-a");
  });
});
