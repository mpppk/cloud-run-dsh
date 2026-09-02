// GitHub App credential broker — short-lived tokens
// Spec: sections 18, 26 items 3-5. Implementation guide section 18.
// Private key is read on HOST only from injected secret provider — never written to filesystem,
// never passed to a sandbox.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Repository {
  readonly owner: string;
  readonly name: string;
}

export interface TemporaryToken {
  readonly token: string;
  readonly expiresAt: string; // ISO 8601 from GitHub
}

export interface GitHubCredentialBroker {
  getInstallationToken(repository: Repository): Promise<TemporaryToken>;
}

// ---------------------------------------------------------------------------
// Safety constants
// ---------------------------------------------------------------------------

/**
 * How much earlier the cache entry expires compared to the real GitHub token expiry.
 * GitHub installation tokens live ~60 min; discarding 5 min early avoids use-after-expiry.
 */
export const TOKEN_CACHE_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * JWT lifetime for GitHub App authentication (max 10 min per GitHub docs).
 */
export const GITHUB_APP_JWT_LIFETIME_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Injected dependencies (host-only, no filesystem / no sandbox)
// ---------------------------------------------------------------------------

export interface GitHubAppSecrets {
  readonly appId: string;
  readonly privateKeyPem: string; // PKCS#1 or PKCS#8 PEM, held in memory only
}

export type SecretProvider = () => Promise<GitHubAppSecrets>;

export interface Clock {
  nowMs(): number;
  nowDate(): Date;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowDate: () => new Date(),
};

// Minimal HTTP transport — injectable for tests, no external fetch required.
export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string; // JSON string
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly token: TemporaryToken;
  /** Effective expiry for cache purposes (expiresAt - safety margin) */
  readonly cachedUntilMs: number;
}

export class InMemoryTokenCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly safetyMarginMs: number = TOKEN_CACHE_SAFETY_MARGIN_MS,
  ) {}

  private key(repo: Repository): string {
    return `${repo.owner}/${repo.name}`;
  }

  get(repo: Repository): TemporaryToken | undefined {
    const entry = this.store.get(this.key(repo));
    if (!entry) return undefined;
    if (this.clock.nowMs() >= entry.cachedUntilMs) {
      this.store.delete(this.key(repo));
      return undefined;
    }
    return entry.token;
  }

  set(repo: Repository, token: TemporaryToken): void {
    const expiresAtMs = Date.parse(token.expiresAt);
    const cachedUntilMs = expiresAtMs - this.safetyMarginMs;
    this.store.set(this.key(repo), { token, cachedUntilMs });
  }

  clear(repo: Repository): void {
    this.store.delete(this.key(repo));
  }

  clearAll(): void {
    this.store.clear();
  }

  /** For tests: number of cached entries */
  size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// JWT helpers (RS256). No filesystem access. Uses Web Crypto via Node's crypto.
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let b64 = Buffer.from(bytes).toString("base64");
  b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return b64;
}

function base64UrlEncodeString(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

/**
 * Create a GitHub App JWT (RS256) from the private key. The key is used only in memory.
 * Never writes to filesystem and never returns the key material.
 */
export async function createGitHubAppJwt(
  secrets: GitHubAppSecrets,
  clock: Clock = systemClock,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const nowSec = Math.floor(clock.nowDate().getTime() / 1000);
  // GitHub requires iat not too far in past/future and exp max 10 min after iat.
  const payload = {
    iat: nowSec - 60, // 60s clock skew tolerance
    exp: nowSec + Math.floor(GITHUB_APP_JWT_LIFETIME_MS / 1000) - 30,
    iss: secrets.appId,
  };
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Use Node crypto for RS256 signing. Import PEM without writing to disk.
  const { createSign } = await import("node:crypto");
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(secrets.privateKeyPem);
  const sigB64 = base64UrlEncode(new Uint8Array(signature));
  return `${signingInput}.${sigB64}`;
}

// ---------------------------------------------------------------------------
// Broker implementation
// ---------------------------------------------------------------------------

export interface GitHubCredentialBrokerOptions {
  readonly secretProvider: SecretProvider;
  readonly transport: HttpTransport;
  readonly clock?: Clock;
  readonly cache?: InMemoryTokenCache;
  /** GitHub API base URL (default https://api.github.com) */
  readonly apiBaseUrl?: string;
}

export function createGitHubCredentialBroker(
  options: GitHubCredentialBrokerOptions,
): GitHubCredentialBroker & {
  readonly cache: InMemoryTokenCache;
  /** Scoped helper: hands token to exactly one operation and discards it */
  withInstallationToken<T>(
    repository: Repository,
    fn: (token: string) => Promise<T>,
  ): Promise<T>;
  /** Returns git `-c http.extraheader` args for the token — does NOT embed in URL */
  gitAuthArgs(token: string): readonly string[];
  /** Returns an env map containing the token via a non-persisted header approach */
  gitAuthEnv(token: string): Readonly<Record<string, string>>;
} {
  const clock = options.clock ?? systemClock;
  const cache = options.cache ?? new InMemoryTokenCache(clock);
  const apiBase = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");

  async function fetchInstallationId(
    repo: Repository,
    jwt: string,
  ): Promise<number> {
    const res = await options.transport({
      method: "GET",
      url: `${apiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/installation`,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status !== 200) {
      throw new Error(`Failed to resolve installation for ${repo.owner}/${repo.name}: ${res.status} ${res.body}`);
    }
    const data = JSON.parse(res.body) as { id: number };
    if (typeof data.id !== "number") throw new Error("Invalid installation response: missing id");
    return data.id;
  }

  async function createInstallationToken(
    installationId: number,
    jwt: string,
  ): Promise<TemporaryToken> {
    const res = await options.transport({
      method: "POST",
      url: `${apiBase}/app/installations/${installationId}/access_tokens`,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`Failed to create installation token: ${res.status} ${res.body}`);
    }
    const data = JSON.parse(res.body) as { token: string; expires_at: string };
    if (!data.token || !data.expires_at) throw new Error("Invalid token response");
    return { token: data.token, expiresAt: data.expires_at };
  }

  async function getInstallationToken(repo: Repository): Promise<TemporaryToken> {
    const cached = cache.get(repo);
    if (cached) return cached;

    const secrets = await options.secretProvider();
    const jwt = await createGitHubAppJwt(secrets, clock);
    const installationId = await fetchInstallationId(repo, jwt);
    const token = await createInstallationToken(installationId, jwt);
    cache.set(repo, token);
    return token;
  }

  /**
   * Scoped injection helper: obtains a token, hands it to exactly one operation,
   * then discards the local reference. The token is never embedded in a persisted
   * git remote URL — callers should use `gitAuthArgs(token)` or `gitAuthEnv(token)`.
   */
  async function withInstallationToken<T>(
    repo: Repository,
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    const tok = await getInstallationToken(repo);
    try {
      return await fn(tok.token);
    } finally {
      // Discard local reference; cache retains token until TTL but scoped usage ends here.
      // No persistent storage of token occurs in this helper.
    }
  }

  function gitAuthArgs(token: string): readonly string[] {
    // Use http.extraheader so the token never appears in a remote URL.
    // Caller should pass these as `git -c http.extraHeader=... clone ...`
    return [
      "-c",
      `http.https://github.com/.extraheader=Authorization: Bearer ${token}`,
    ] as const;
  }

  function gitAuthEnv(_token: string): Readonly<Record<string, string>> {
    // No env var is persisted; this is intentionally empty to avoid accidental leakage.
    // Tokens should be passed via gitAuthArgs header, not env.
    return {};
  }

  return {
    getInstallationToken,
    withInstallationToken,
    gitAuthArgs,
    gitAuthEnv,
    cache,
  };
}

// ---------------------------------------------------------------------------
// URL safety: helpers that MUST NOT embed tokens
// ---------------------------------------------------------------------------

/**
 * Build a safe git remote URL that never contains a token.
 * This is the only supported way to construct remote URLs; embedding a token
 * into the URL is not provided and must not be used.
 */
export function buildSafeRemoteUrl(repo: Repository): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

/**
 * Assert that a URL or persisted value does not contain a token-like secret.
 * Used in tests and can be used as a runtime guard before persisting git config.
 */
export function assertNoTokenInValue(value: string, token?: string): void {
  if (token && value.includes(token)) {
    throw new Error("Token detected in persisted value — this is forbidden");
  }
  // Heuristic: GitHub tokens start with ghs_ or github_pat_
  if (/ghs_[A-Za-z0-9_]+/.test(value) || /github_pat_[A-Za-z0-9_]+/.test(value)) {
    throw new Error("Token-like pattern detected in persisted value");
  }
  // Bearer token pattern in URL
  if (value.includes("x-access-token:") || /https:\/\/[^@]+@github\.com/.test(value)) {
    throw new Error("Token-embedded remote URL detected — use http.extraheader instead");
  }
}

// ---------------------------------------------------------------------------
// Placeholder (kept for backward compat / smoke test)
// ---------------------------------------------------------------------------

export interface GitHubCredentialBrokerPlaceholder {
  readonly kind: "github-credential-broker";
}

export const PLACEHOLDER_KIND = "github-credential-broker" as const;

export function createPlaceholder(): GitHubCredentialBrokerPlaceholder {
  return { kind: PLACEHOLDER_KIND };
}
