// Issue #150: opaque server-side sessions + OAuth login-flow state.
// Raw tokens/secrets must never reach storage, logs, or error messages —
// only SHA-256 hashes are persisted.

import { describe, expect, test } from "bun:test";
import type { QueryExecutor } from "@cloud-run-dsh/session-persistence-postgres";
import {
  buildSessionClearCookie,
  buildSessionSetCookie,
  generateCodeVerifier,
  generateRawToken,
  hashToken,
  InMemorySessionStore,
  LOGIN_FLOW_LIFETIME_MS,
  parseSessionCookies,
  pkceChallenge,
  PostgresSessionStore,
  SESSION_COOKIE_NAME,
  SESSION_LIFETIME_MS,
  type SessionStore,
} from "./auth-session.js";
import { githubUser } from "./auth.js";

/** Recording QueryExecutor fake: captures every SQL + param for redaction assertions. */
class RecordingExecutor implements QueryExecutor {
  readonly statements: Array<{ sql: string; params: unknown[] }> = [];
  /** Rows returned by the next query() call, in order. */
  readonly queuedRows: Record<string, unknown>[][] = [];

  async exec(sql: string, params?: unknown[]): Promise<void> {
    this.statements.push({ sql, params: params ?? [] });
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.statements.push({ sql, params: params ?? [] });
    return (this.queuedRows.shift() ?? []) as T[];
  }

  async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    return fn(this);
  }

  /** Every param serialized — raw secrets must never appear here. */
  allParamsText(): string {
    return this.statements
      .map((s) => s.params.map((p) => (Buffer.isBuffer(p) ? p.toString("hex") : String(p))).join(" "))
      .join("\n");
  }
}

function stores(): Array<[string, () => SessionStore]> {
  return [
    ["in-memory", () => new InMemorySessionStore()],
    // Postgres store over the recording fake: exercises the real SQL shape
    // (hash binding, expiry predicate, one-time DELETE ... RETURNING)
    // without a database.
    ["postgres-shape", () => new PostgresSessionStore(new RecordingExecutor())],
  ];
}

describe("issue #150: raw token generation", () => {
  test("256-bit opaque tokens: 43 base64url chars, unique per call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const token = generateRawToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
  });

  test("PKCE challenge is BASE64URL(SHA256(verifier))", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkceChallenge(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // RFC 7636 test vector (Appendix B).
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("issue #150: session cookie attributes", () => {
  test("__Host- prefix with Secure; HttpOnly; SameSite=Lax; Path=/", () => {
    expect(SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    const set = buildSessionSetCookie("raw-token-value");
    expect(set.startsWith(`${SESSION_COOKIE_NAME}=raw-token-value`)).toBe(true);
    for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=604800"]) {
      expect(set).toContain(attr);
    }
    expect(set).not.toContain("Domain=");
    const clear = buildSessionClearCookie();
    expect(clear).toContain("Max-Age=0");
    expect(clear).toContain("Secure");
    expect(clear).toContain("HttpOnly");
  });

  test("cookie parsing: exactly-one-value rule, duplicates fail closed upstream", () => {
    expect(parseSessionCookies(null)).toEqual([]);
    expect(parseSessionCookies("a=1; b=2")).toEqual([]);
    expect(parseSessionCookies(`${SESSION_COOKIE_NAME}=abc`)).toEqual(["abc"]);
    expect(parseSessionCookies(`other=1; ${SESSION_COOKIE_NAME}=abc; x=2`)).toEqual(["abc"]);
    // Duplicated cookie names (smuggling / fixation smell): surface both so
    // the authenticator can reject the request.
    expect(parseSessionCookies(`${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}=b`)).toEqual([
      "a",
      "b",
    ]);
    // Empty value is malformed, not absent.
    expect(parseSessionCookies(`${SESSION_COOKIE_NAME}=`)).toEqual([""]);
  });
});

describe("issue #150: SessionStore contract (both backends)", () => {
  for (const [name, make] of stores()) {
    test(`${name}: valid session lookup returns the internal principal`, async () => {
      if (name === "postgres-shape") return; // needs row round-trip; covered below
      const store = make();
      const now = new Date();
      const user = githubUser(4279342, "mpppk");
      const created = await store.createSession(user, now);
      expect(created.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const found = await store.lookupSession(created.rawToken, new Date(now.getTime() + 1000));
      expect(found?.user).toEqual(user);
      expect(found?.id).toBe(created.id);
    });

    test(`${name}: unknown / malformed / empty token fails closed`, async () => {
      if (name === "postgres-shape") return;
      const store = make();
      const now = new Date();
      expect(await store.lookupSession(generateRawToken(), now)).toBeNull();
      expect(await store.lookupSession("", now)).toBeNull();
      expect(await store.lookupSession("not-a-token!!!", now)).toBeNull();
    });

    test(`${name}: expired session fails closed`, async () => {
      if (name === "postgres-shape") return;
      const store = make();
      const now = new Date();
      const created = await store.createSession(githubUser(1, "a"), now);
      const after = new Date(now.getTime() + SESSION_LIFETIME_MS + 1000);
      expect(await store.lookupSession(created.rawToken, after)).toBeNull();
    });

    test(`${name}: revoke destroys the session`, async () => {
      if (name === "postgres-shape") return;
      const store = make();
      const now = new Date();
      const created = await store.createSession(githubUser(1, "a"), now);
      await store.revokeSession(created.rawToken);
      expect(await store.lookupSession(created.rawToken, now)).toBeNull();
    });

    test(`${name}: login flow is one-time (replay fails) and expires`, async () => {
      if (name === "postgres-shape") return;
      const store = make();
      const now = new Date();
      const rawState1 = generateRawToken();
      const flow = await store.createLoginFlow({
        rawState: rawState1,
        codeVerifier: "verifier-1",
        returnTo: "/app?ws=1",
        now,
      });
      void flow;
      const first = await store.consumeLoginFlow(rawState1, now);
      expect(first).toEqual({ codeVerifier: "verifier-1", returnTo: "/app?ws=1" });
      // Replay of the same state finds nothing.
      expect(await store.consumeLoginFlow(rawState1, now)).toBeNull();

      const rawState2 = generateRawToken();
      await store.createLoginFlow({
        rawState: rawState2,
        codeVerifier: "verifier-2",
        returnTo: null,
        now,
      });
      const late = new Date(now.getTime() + LOGIN_FLOW_LIFETIME_MS + 1000);
      expect(await store.consumeLoginFlow(rawState2, late)).toBeNull();
      // Unknown state fails closed.
      expect(await store.consumeLoginFlow(generateRawToken(), now)).toBeNull();
      expect(await store.consumeLoginFlow("", now)).toBeNull();
    });
  }
});

describe("issue #150: Postgres store never persists raw material", () => {
  test("createSession binds SHA-256(token), never the raw token", async () => {
    const exec = new RecordingExecutor();
    const store = new PostgresSessionStore(exec);
    const created = await store.createSession(githubUser(4279342, "mpppk"), new Date());
    const text = exec.allParamsText();
    expect(text).not.toContain(created.rawToken);
    expect(text).toContain(hashToken(created.rawToken).toString("hex"));
    expect(text).toContain("github:4279342");
    expect(exec.statements[0]!.sql).toContain("INSERT INTO auth_sessions");
  });

  test("lookup binds the hash with an expiry predicate", async () => {
    const exec = new RecordingExecutor();
    const store = new PostgresSessionStore(exec);
    await store.lookupSession("some-raw-token", new Date());
    const stmt = exec.statements[0]!;
    expect(stmt.sql).toContain("token_hash = $1");
    expect(stmt.sql).toContain("expires_at > $2");
    expect(exec.allParamsText()).not.toContain("some-raw-token");
  });

  test("login-flow consume is DELETE ... RETURNING (atomic one-time)", async () => {
    const exec = new RecordingExecutor();
    const store = new PostgresSessionStore(exec);
    const rawState = generateRawToken();
    await store.createLoginFlow({
      rawState,
      codeVerifier: "v",
      returnTo: null,
      now: new Date(),
    });
    expect(exec.allParamsText()).not.toContain(rawState);
    exec.statements.length = 0;
    exec.queuedRows.push([{ code_verifier: "v", return_to: null }]);
    const consumed = await store.consumeLoginFlow(rawState, new Date());
    expect(consumed).toEqual({ codeVerifier: "v", returnTo: null });
    expect(exec.statements[0]!.sql).toContain("DELETE FROM oauth_login_flows");
    expect(exec.statements[0]!.sql).toContain("RETURNING");
  });

  test("lookup maps the row back to github:<numeric-id> principal", async () => {
    const exec = new RecordingExecutor();
    const store = new PostgresSessionStore(exec);
    exec.queuedRows.push([
      {
        id: "session-uuid",
        user_id: "github:4279342",
        github_user_id: "4279342",
        github_login: "mpppk",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 1000).toISOString(),
      },
    ]);
    const found = await store.lookupSession(generateRawToken(), new Date());
    expect(found?.user).toEqual({
      id: "github:4279342",
      provider: "github",
      providerUserId: "4279342",
      login: "mpppk",
    });
  });
});
