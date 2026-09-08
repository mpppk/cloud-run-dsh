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
    // NOTE: git-over-HTTPS rejects `Authorization: Bearer <installation-token>`
    // (REST API accepts Bearer, git transport does not — issue #62). GitHub
    // requires Basic with the fixed username "x-access-token".
    // The base64 blob decodes to "x-access-token:<token>", so it IS the secret
    // itself (base64 is not encryption): it lives in argv (unavoidable for git),
    // but must never be persisted in a remote URL nor emitted to logs/errors.
    const credentials = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    return [
      "-c",
      `http.https://github.com/.extraheader=Authorization: Basic ${credentials}`,
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
// Repository authorization (issue #154) — "may this GitHub user read this repo?"
//
// GitHub user access tokens are NEVER persisted, so authorization reuses the
// App's installation token (short-lived, memory-only, handed to exactly one
// operation via withInstallationToken) to ask GitHub what permission the
// logged-in user holds on the repository:
//
//   GET /repos/{owner}/{repo}/collaborators/{username}/permission
//     -> { permission: "admin" | "maintain" | "write" | "triage" | "read" }
//
// Read or above authorizes. Anything else — 404 (repo unknown, App not
// installed, or user without access: deliberately ONE bucket so the answer
// never oracles private-repo existence), permission "none" — denies.
//
// Endpoint semantics re-verified against the GitHub REST docs while writing
// this (2026-09): the collaborator-permission endpoint answers 200 with the
// permission for users WITH access and 404 otherwise; it accepts an
// installation access token when the App has Contents: read (this App
// already clones, so it does). Transient transport/5xx failures throw
// RepositoryAuthorizerTransientError (the caller maps to 502/503, distinct
// from a deny); malformed coordinates throw RepositoryInputError (400).
// ---------------------------------------------------------------------------

/** Failure to reach GitHub or an unexpected GitHub answer: retryable, NOT a deny. */
export class RepositoryAuthorizerTransientError extends Error {
  override readonly name = "RepositoryAuthorizerTransientError";
  constructor(message: string) {
    super(message);
  }
}

/** Malformed repository coordinates: caller error, never sent to GitHub. */
export class RepositoryInputError extends Error {
  override readonly name = "RepositoryInputError";
  constructor(message: string) {
    super(message);
  }
}

export interface RepositoryPermissionInput {
  readonly owner: string;
  readonly repo: string;
  /** Stable identity: GitHub numeric user id (authorization key). */
  readonly githubUserId: string;
  /**
   * Current GitHub login. Required as API INPUT by the
   * collaborators/permission endpoint; it is a profile attribute, never the
   * authorization key.
   */
  readonly githubLogin: string;
}

export interface RepositoryAuthorizer {
  /**
   * Resolves true when the user holds read-or-above permission AND the App
   * installation can see the repository. False for every deny shape
   * (unknown repo / App not installed / permission below read) — callers
   * must map all falses to ONE response so existence never leaks.
   */
  canReadRepository(input: RepositoryPermissionInput): Promise<boolean>;
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Validates repository coordinates BEFORE any network call. Throws
 * RepositoryInputError (caller maps to 400). The patterns mirror GitHub's
 * own naming rules (owner ≤ 39 chars, repo ≤ 100) and reject path
 * trickery (.., /, %, whitespace) by construction.
 */
export function validateRepositoryCoordinates(owner: string, repo: string): void {
  if (!OWNER_PATTERN.test(owner)) {
    throw new RepositoryInputError(
      `invalid repository owner (want 1-39 chars of [A-Za-z0-9-], not leading/trailing '-')`,
    );
  }
  if (!REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    throw new RepositoryInputError(
      `invalid repository name (want 1-100 chars of [A-Za-z0-9_.-])`,
    );
  }
}

/** Permission levels at or above read (GitHub may add more; unknown levels deny). */
const SUFFICIENT_PERMISSIONS: ReadonlySet<string> = new Set([
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
]);

export interface RepositoryAuthorizerOptions {
  /** Token source: signing + installation-token issuance are reused, never duplicated. */
  readonly broker: {
    withInstallationToken<T>(repository: Repository, fn: (token: string) => Promise<T>): Promise<T>;
  };
  readonly transport: HttpTransport;
  /** GitHub API base URL (default https://api.github.com) */
  readonly apiBaseUrl?: string;
  /** Per-call timeout in ms (default 10000). A hanging GitHub must not hang workspace creation. */
  readonly timeoutMs?: number;
}

export function createRepositoryAuthorizer(options: RepositoryAuthorizerOptions): RepositoryAuthorizer {
  const apiBase = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function permissionLevel(
    token: string,
    url: string,
  ): Promise<{ status: number; permission?: string }> {
    let res: HttpResponse;
    try {
      res = await Promise.race([
        options.transport({
          method: "GET",
          url,
          headers: {
            // The live installation token. Transports MUST NOT log headers
            // or echo them into errors — the token lives only in this
            // request and is dropped with the withInstallationToken scope.
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new RepositoryAuthorizerTransientError(
                  `GitHub permission lookup timed out after ${timeoutMs}ms`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } catch (e) {
      if (e instanceof RepositoryAuthorizerTransientError) throw e;
      throw new RepositoryAuthorizerTransientError(
        `GitHub permission lookup failed: ${e instanceof Error ? e.message.slice(0, 120) : "unreachable"}`,
      );
    }
    // Drain-or-discard discipline: the body is NEVER stored, logged, or
    // echoed — only the status and (on 200) the parsed permission level
    // leave this function.
    if (res.status !== 200) {
      return { status: res.status };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body) as unknown;
    } catch {
      throw new RepositoryAuthorizerTransientError("GitHub permission lookup answered non-JSON");
    }
    const permission =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["permission"]
        : undefined;
    return typeof permission === "string" ? { status: 200, permission } : { status: 200 };
  }

  return {
    async canReadRepository(input: RepositoryPermissionInput): Promise<boolean> {
      validateRepositoryCoordinates(input.owner, input.repo);
      if (!input.githubLogin || !input.githubUserId) {
        throw new RepositoryInputError("github user identity is required");
      }
      const url =
        `${apiBase}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}` +
        `/collaborators/${encodeURIComponent(input.githubLogin)}/permission`;
      // The installation token lives only inside this callback (scoped
      // injection — see withInstallationToken): it authenticates ONE GitHub
      // call and is then dropped. It is never written to the database,
      // never logged, never embedded in an error. The permission lookup
      // itself runs over the injected options.transport (same seam the
      // broker uses for issuance), race-guarded by timeoutMs.
      let outcome: { status: number; permission?: string };
      try {
        outcome = await options.broker.withInstallationToken(
          { owner: input.owner, name: input.repo },
          async (token) => permissionLevel(token, url),
        );
      } catch (e) {
        if (e instanceof RepositoryAuthorizerTransientError) throw e;
        if (e instanceof RepositoryInputError) throw e;
        // Token issuance failures (App not installed, JWT rejected, GitHub
        // 5xx on the token endpoints): issuance and lookup share the "GitHub
        // is not answering normally" bucket. EXCEPTION: a clean
        // installation-resolution 404 means "App has no access" — a DENY,
        // not a transient. The broker reports it as
        // "Failed to resolve installation ...: 404 ...".
        if (e instanceof Error && /:\s*404(\s|$)/.test(e.message)) {
          return false;
        }
        throw new RepositoryAuthorizerTransientError(
          `GitHub authorization check failed: ${e instanceof Error ? e.message.slice(0, 120) : "unreachable"}`,
        );
      }
      if (outcome.status === 404) return false;
      if (outcome.status !== 200) {
        throw new RepositoryAuthorizerTransientError(
          `GitHub permission lookup answered ${outcome.status}`,
        );
      }
      return (
        typeof outcome.permission === "string" && SUFFICIENT_PERMISSIONS.has(outcome.permission)
      );
    },
  };
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
