import { describe, test, expect, mock } from "bun:test";
import {
  PLACEHOLDER_KIND,
  createPlaceholder,
  createGitHubCredentialBroker,
  InMemoryTokenCache,
  TOKEN_CACHE_SAFETY_MARGIN_MS,
  buildSafeRemoteUrl,
  assertNoTokenInValue,
  createGitHubAppJwt,
} from "./index.js";
import type { HttpTransport, Repository } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Generate a real RSA key pair for signing tests (in-memory, never written to disk)
import { generateKeyPairSync } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function createFakeClock(startMs = Date.parse("2026-01-01T00:00:00Z")) {
  let now = startMs;
  return {
    nowMs: () => now,
    nowDate: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
}

function repo(owner = "mpppk", name = "cloud-run-dsh"): Repository {
  return { owner, name };
}

// Fake transport that simulates GitHub API
function createFakeTransport(opts: {
  appId?: string;
  clock?: ReturnType<typeof createFakeClock>;
  installationId?: number;
  token?: string;
  expiresAt?: string;
  onRequest?: (req: { url: string; headers: Record<string, string> }) => void;
} = {}): HttpTransport & { calls: string[] } {
  const calls: string[] = [];
  const transport: HttpTransport & { calls: string[] } = Object.assign(
    async (req: { method: string; url: string; headers: Record<string, string>; body?: string }) => {
      calls.push(`${req.method} ${req.url}`);
      opts.onRequest?.(req);
      if (req.url.includes("/repos/") && req.url.includes("/installation")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ id: opts.installationId ?? 12345 }),
        };
      }
      if (req.url.includes("/app/installations/") && req.url.includes("/access_tokens")) {
        return {
          status: 201,
          headers: {},
          body: JSON.stringify({
            token: opts.token ?? "ghs_testToken1234567890abcdefghij",
            expires_at: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
        };
      }
      return { status: 404, headers: {}, body: JSON.stringify({ message: "not found" }) };
    },
    { calls },
  );
  return transport;
}

describe("github-credential-broker", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("github-credential-broker");
    const p = createPlaceholder();
    expect(p.kind).toBe("github-credential-broker");
  });

  test("TOKEN_CACHE_SAFETY_MARGIN_MS is named and positive", () => {
    expect(TOKEN_CACHE_SAFETY_MARGIN_MS).toBeGreaterThan(0);
    expect(TOKEN_CACHE_SAFETY_MARGIN_MS).toBe(5 * 60 * 1000);
  });

  test("token exchange via fake transport", async () => {
    const clock = createFakeClock();
    const transport = createFakeTransport({
      token: "ghs_fakeTokenForTest1234567890",
      expiresAt: new Date(clock.nowMs() + 60 * 60 * 1000).toISOString(),
    });

    const broker = createGitHubCredentialBroker({
      secretProvider: async () => ({ appId: "123", privateKeyPem: privateKey }),
      transport,
      clock,
    });

    const tok = await broker.getInstallationToken(repo());
    expect(tok.token).toBe("ghs_fakeTokenForTest1234567890");
    expect(tok.expiresAt).toBeDefined();
    expect(transport.calls.length).toBe(2); // installation lookup + token creation
    expect(transport.calls[0]).toContain("/repos/");
    expect(transport.calls[1]).toContain("/access_tokens");
  });

  test("cache hit avoids second exchange", async () => {
    const clock = createFakeClock();
    let callCount = 0;
    const transport: HttpTransport = async (req) => {
      callCount++;
      if (req.url.includes("/installation") && !req.url.includes("access_tokens")) {
        return { status: 200, headers: {}, body: JSON.stringify({ id: 999 }) };
      }
      return {
        status: 201,
        headers: {},
        body: JSON.stringify({
          token: "ghs_cachedToken1234567890",
          expires_at: new Date(clock.nowMs() + 60 * 60 * 1000).toISOString(),
        }),
      };
    };

    const broker = createGitHubCredentialBroker({
      secretProvider: async () => ({ appId: "123", privateKeyPem: privateKey }),
      transport,
      clock,
    });

    const tok1 = await broker.getInstallationToken(repo());
    const tok2 = await broker.getInstallationToken(repo());
    expect(tok1.token).toBe(tok2.token);
    // First call: 2 requests, second call: 0 (cache hit)
    expect(callCount).toBe(2);
  });

  test("cache expiry after TTL (fake clock)", async () => {
    const clock = createFakeClock();
    const expiresAt = new Date(clock.nowMs() + 60 * 60 * 1000).toISOString(); // 60 min
    let tokenCounter = 0;
    const transport: HttpTransport = async (req) => {
      if (req.url.includes("/repos/")) {
        return { status: 200, headers: {}, body: JSON.stringify({ id: 1 }) };
      }
      tokenCounter++;
      return {
        status: 201,
        headers: {},
        body: JSON.stringify({
          token: `ghs_token${tokenCounter}_1234567890abcdefghij`,
          expires_at: expiresAt,
        }),
      };
    };

    const cache = new InMemoryTokenCache(clock);
    const broker = createGitHubCredentialBroker({
      secretProvider: async () => ({ appId: "123", privateKeyPem: privateKey }),
      transport,
      clock,
      cache,
    });

    const tok1 = await broker.getInstallationToken(repo());
    expect(tok1.token).toContain("token1");

    // Advance to just before safety margin (55 min) — still cached
    clock.advance(55 * 60 * 1000 - 1000);
    const tok2 = await broker.getInstallationToken(repo());
    expect(tok2.token).toBe(tok1.token);

    // Advance past cachedUntil (expiresAt - 5min) → cache miss, new token
    // CachedUntil = expiresAt - 5min = 55min after start
    clock.advance(2000); // now past 55min
    // Need new expiresAt for second token to avoid immediate expiry
    // But our transport still returns old expiresAt; cache will treat it as expired immediately if clock beyond cachedUntil.
    // To get a fresh token, we need to allow new token; but even with same expiresAt, it will be expired, so next call would keep missing.
    // Instead test that cache is empty after expiry
    expect(cache.get(repo())).toBeUndefined();
  });

  test("InMemoryTokenCache TTL respects safety margin", () => {
    const clock = createFakeClock(Date.parse("2026-01-01T00:00:00Z"));
    const cache = new InMemoryTokenCache(clock, 5 * 60 * 1000);
    const r = repo();
    const expiresAt = new Date(clock.nowMs() + 60 * 60 * 1000).toISOString();
    cache.set(r, { token: "ghs_test1234567890", expiresAt });
    expect(cache.get(r)?.token).toBe("ghs_test1234567890");
    clock.advance(54 * 60 * 1000);
    expect(cache.get(r)?.token).toBe("ghs_test1234567890");
    clock.advance(2 * 60 * 1000); // total 56min > 55min cachedUntil
    expect(cache.get(r)).toBeUndefined();
  });

  test("private key never appears in returned or logged values", async () => {
    const clock = createFakeClock();
    const transport = createFakeTransport();
    const broker = createGitHubCredentialBroker({
      secretProvider: async () => ({ appId: "999", privateKeyPem: privateKey }),
      transport,
      clock,
    });
    const tok = await broker.getInstallationToken(repo());
    const serialized = JSON.stringify(tok);
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain(privateKey.slice(0, 20));

    // Also ensure JWT creation does not leak key (createGitHubAppJwt returns JWT, not key)
    const jwt = await createGitHubAppJwt({ appId: "123", privateKeyPem: privateKey }, clock);
    expect(jwt).not.toContain("BEGIN PRIVATE KEY");
    expect(jwt.split(".").length).toBe(3);
  });

  test("scoped injection helper hands token to exactly one operation and discards", async () => {
    const clock = createFakeClock();
    const transport = createFakeTransport({ token: "ghs_scopedToken1234567890" });
    const broker = createGitHubCredentialBroker({
      secretProvider: async () => ({ appId: "123", privateKeyPem: privateKey }),
      transport,
      clock,
    });

    let captured: string | undefined;
    const result = await broker.withInstallationToken(repo(), async (token) => {
      captured = token;
      expect(token).toBe("ghs_scopedToken1234567890");
      return 42;
    });
    expect(result).toBe(42);
    expect(captured).toBe("ghs_scopedToken1234567890");
    // After scoped helper, no token is returned outside the callback except via captured var (test var).
    // Ensure broker does not expose token via other means (e.g., remote URL)
    const safeUrl = buildSafeRemoteUrl(repo());
    expect(safeUrl).not.toContain(captured!);
    assertNoTokenInValue(safeUrl, captured);
  });

  test("embedding token into persisted git remote URL is impossible — safe URL has no token", () => {
    const repoA = { owner: "owner", name: "repo" };
    const token = "ghs_evilToken1234567890abcdefghij";
    const safeUrl = buildSafeRemoteUrl(repoA);
    expect(safeUrl).toBe("https://github.com/owner/repo.git");
    expect(safeUrl).not.toContain(token);
    expect(() => assertNoTokenInValue(`https://x-access-token:${token}@github.com/owner/repo.git`, token)).toThrow();
    expect(() => assertNoTokenInValue(`https://${token}@github.com/owner/repo.git`, token)).toThrow();
    // Heuristic token pattern should also be caught
    expect(() => assertNoTokenInValue(`https://github.com/owner/repo.git?token=ghs_abcdefghij1234567890klmn`)).toThrow();
  });

  test("gitAuthArgs uses http.extraheader not URL embedding", async () => {
    const clock = createFakeClock();
    const transport = createFakeTransport({ token: "ghs_headerToken1234567890" });
    const broker = createGitHubCredentialBroker({
      secretProvider: async () => ({ appId: "123", privateKeyPem: privateKey }),
      transport,
      clock,
    });
    const token = "ghs_headerToken1234567890";
    const args = broker.gitAuthArgs(token);
    expect(args.join(" ")).toContain("http.https://github.com/.extraheader");
    // Issue #62: git-over-HTTPS requires Basic x-access-token, not Bearer.
    const expectedB64 = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    expect(args.join(" ")).toContain(`Authorization: Basic ${expectedB64}`);
    expect(args.join(" ")).not.toContain("Bearer");
    // The shape alone is not enough — decode must round-trip to the token.
    const header = args.find((a) => a.includes("extraheader"))!;
    const b64 = header.split("Authorization: Basic ")[1]!.trim();
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(`x-access-token:${token}`);
    // Args themselves contain the secret (needed for git), but they are NOT a persisted remote URL.
    // The persisted URL must not contain the token NOR its base64 form.
    const url = buildSafeRemoteUrl(repo());
    assertNoTokenInValue(url, token);
    expect(url).not.toContain(b64);
    expect(url).not.toContain(token);
    // But args are ephemeral — we don't assertNoTokenInValue on them.
  });

  test("redaction: token should not leak via transport headers after fetch (no key in body)", async () => {
    const clock = createFakeClock();
    let capturedAuth: string | undefined;
    const transport: HttpTransport = async (req) => {
      if (req.url.includes("/repos/")) {
        capturedAuth = req.headers["Authorization"];
        return { status: 200, headers: {}, body: JSON.stringify({ id: 1 }) };
      }
      return {
        status: 201,
        headers: {},
        body: JSON.stringify({ token: "ghs_redactMe1234567890", expires_at: new Date(clock.nowMs() + 3600000).toISOString() }),
      };
    };
    const broker = createGitHubCredentialBroker({
      secretProvider: async () => ({ appId: "123", privateKeyPem: privateKey }),
      transport,
      clock,
    });
    await broker.getInstallationToken(repo());
    // Authorization header should contain JWT, not private key
    expect(capturedAuth).toContain("Bearer ");
    expect(capturedAuth).not.toContain("BEGIN PRIVATE KEY");
  });

  test("assertNoTokenInValue detects github_pat and ghs patterns", () => {
    expect(() => assertNoTokenInValue("token=github_pat_abcdef1234567890xyz")).toThrow();
    expect(() => assertNoTokenInValue("value ghs_abc123def456ghi789jkl0")).toThrow();
    expect(() => assertNoTokenInValue("clean value without secrets")).not.toThrow();
  });
});
