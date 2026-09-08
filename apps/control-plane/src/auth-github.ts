// GitHub App OAuth login (issue #151).
//
// Web application flow + PKCE (S256). The GitHub user access token exists
// only inside the callback: it is exchanged, used for ONE `GET /user`
// identity read, then dropped — never persisted, never logged.
//
// Endpoints (wired in server.ts):
//   GET  /auth/login    -> 302 to GitHub authorize (stores state hash + PKCE verifier)
//   GET  /auth/callback -> validates state (one-time), exchanges code, issues session, 302
//   POST /auth/logout   -> server-side revoke + cookie clear
//   GET  /auth/session  -> current principal (or 401)
//
// `return_to` accepts relative paths only; the callback URL is built from
// configured APP_ORIGIN, never from the request Host header.

import { badGateway, badRequest, unauthorized, unavailable } from "./errors.js";
import {
  bindingMatches,
  buildOAuthBindingClearCookie,
  buildOAuthBindingSetCookie,
  buildSessionClearCookie,
  buildSessionSetCookie,
  generateCodeVerifier,
  generateRawToken,
  hashToken,
  parseOAuthBindingCookies,
  parseSessionCookies,
  pkceChallenge,
  LOGIN_STATE_BYTES,
  OAUTH_BINDING_BYTES,
  type SessionStore,
} from "./auth-session.js";
import { githubUser } from "./auth.js";

// ---------------------------------------------------------------------------
// GitHub API seam
// ---------------------------------------------------------------------------

export interface CodeExchangeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface GitHubUserProfile {
  readonly id: number;
  readonly login: string;
}

export interface GitHubUserAuthClient {
  exchangeCode(input: CodeExchangeInput): Promise<{ accessToken: string }>;
  getUser(accessToken: string): Promise<GitHubUserProfile>;
}

/**
 * Production GitHub OAuth / API client over fetch.
 *
 * Secret posture: client_secret travels only in the token-exchange POST
 * body. Failures log status codes, never response bodies (an error body
 * must be assumed to be able to carry reflected material).
 *
 * Every call races an AbortController timeout (A2, default 10s): a hung
 * GitHub must fail the callback fast instead of parking it until the
 * platform request timeout. The timer is always cleared on settle.
 */
export class FetchGitHubUserAuthClient implements GitHubUserAuthClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly apiBaseUrl: string = "https://api.github.com",
    private readonly oauthBaseUrl: string = "https://github.com",
    opts: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /**
   * Runs `fn` with an abort signal that fires at `timeoutMs`, raced against
   * a timer rejection: real fetches are aborted via the signal, while a
   * signal-ignoring transport still loses the race. The timer is always
   * cleared on settle.
   */
  private async withTimeout<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new GitHubOAuthError(`${label} timed out after ${this.timeoutMs}ms`));
          }, this.timeoutMs);
        }),
      ]);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new GitHubOAuthError(`${label} timed out after ${this.timeoutMs}ms`);
      }
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async exchangeCode(input: CodeExchangeInput): Promise<{ accessToken: string }> {
    let res: Response;
    try {
      res = await this.withTimeout("token endpoint", (signal) =>
        this.fetchFn(`${this.oauthBaseUrl}/login/oauth/access_token`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            code: input.code,
            redirect_uri: input.redirectUri,
            code_verifier: input.codeVerifier,
          }),
          signal,
        }),
      );
    } catch (e) {
      if (e instanceof GitHubOAuthError) throw e;
      throw new GitHubOAuthError(`token endpoint unreachable: ${shortError(e)}`);
    }
    if (!res.ok) {
      throw new GitHubOAuthError(`token endpoint answered ${res.status}`);
    }
    let parsed: unknown;
    try {
      parsed = (await res.json()) as unknown;
    } catch {
      throw new GitHubOAuthError("token endpoint answered non-JSON");
    }
    const token =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["access_token"]
        : undefined;
    if (typeof token !== "string" || token === "") {
      throw new GitHubOAuthError("token endpoint returned no access token");
    }
    return { accessToken: token };
  }

  async getUser(accessToken: string): Promise<GitHubUserProfile> {
    let res: Response;
    try {
      res = await this.withTimeout("GitHub API", (signal) =>
        this.fetchFn(`${this.apiBaseUrl}/user`, {
          method: "GET",
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal,
        }),
      );
    } catch (e) {
      if (e instanceof GitHubOAuthError) throw e;
      throw new GitHubOAuthError(`GitHub API unreachable: ${shortError(e)}`);
    }
    if (!res.ok) {
      throw new GitHubOAuthError(`GitHub API answered ${res.status}`);
    }
    let parsed: unknown;
    try {
      parsed = (await res.json()) as unknown;
    } catch {
      throw new GitHubOAuthError("GitHub API answered non-JSON");
    }
    const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
      string,
      unknown
    >;
    const id = record["id"];
    const login = record["login"];
    // Email is deliberately NOT required: private / null emails log in fine.
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      throw new GitHubOAuthError("GitHub /user answered a malformed id");
    }
    if (typeof login !== "string" || login === "") {
      throw new GitHubOAuthError("GitHub /user answered a malformed login");
    }
    return { id, login };
  }
}

/** Typed exchange/API failure. Message carries status-class info only — never bodies or tokens. */
export class GitHubOAuthError extends Error {
  override readonly name = "GitHubOAuthError";
  constructor(message: string) {
    super(message);
  }
}

function shortError(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
}

// ---------------------------------------------------------------------------
// OAuth flow helpers
// ---------------------------------------------------------------------------

export interface OAuthConfig {
  /** Public origin, e.g. https://dsh-control-abc.run.app (never request Host). */
  readonly appOrigin: string;
  readonly githubClientId: string;
  readonly githubClientSecret: string;
}

export function callbackUrl(config: OAuthConfig): string {
  return `${config.appOrigin.replace(/\/$/, "")}/auth/callback`;
}

/** Builds the GitHub authorize URL for the login redirect. */
export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * `return_to` allowlist: same-origin relative paths only.
 * Rejects absolute URLs, scheme-relative (`//evil`), backslashes, CR/LF,
 * and anything that does not start with `/`.
 */
export function resolveReturnTo(raw: string | null, fallback = "/app"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return fallback;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return fallback;
  return raw;
}

// ---------------------------------------------------------------------------
// Route handlers (wired in server.ts BEFORE session authentication)
// ---------------------------------------------------------------------------

export interface AuthRouteDeps {
  readonly sessions: SessionStore;
  readonly oauth?: OAuthConfig;
  readonly githubAuth?: GitHubUserAuthClient;
  readonly clock: { now(): Date };
}

function requireOAuth(deps: AuthRouteDeps): { config: OAuthConfig; client: GitHubUserAuthClient } {
  if (!deps.oauth || !deps.githubAuth) {
    throw unavailable("GitHub OAuth login is not configured");
  }
  return { config: deps.oauth, client: deps.githubAuth };
}

function redirect(to: string, setCookies: string[] = []): Response {
  const headers = new Headers({ location: to });
  for (const value of setCookies) headers.append("set-cookie", value);
  return new Response(null, { status: 302, headers });
}

/** GET /auth/login: stores state hash + PKCE verifier, redirects to GitHub. */
export async function handleAuthLogin(request: Request, deps: AuthRouteDeps): Promise<Response> {
  const { config } = requireOAuth(deps);
  const url = new URL(request.url);
  const returnTo = resolveReturnTo(url.searchParams.get("return_to"));
  // The raw state + verifier are generated here and kept in scope: the store
  // persists ONLY hashes/verifier material server-side, while the redirect
  // carries the raw state (to be hashed on callback) and the S256 challenge.
  //
  // A6 browser binding: a second 256-bit nonce is issued as an HttpOnly
  // `__Host-dsh_oauth` cookie; only its hash joins the flow row. The
  // callback must present the same browser's nonce, which closes
  // session-planting via crafted callback URLs (the attacker knows `state`
  // but never the victim's HttpOnly cookie).
  const rawState = generateRawToken(LOGIN_STATE_BYTES);
  const codeVerifier = generateCodeVerifier();
  const rawNonce = generateRawToken(OAUTH_BINDING_BYTES);
  await deps.sessions.createLoginFlow({
    rawState,
    codeVerifier,
    returnTo,
    bindingHash: hashToken(rawNonce).toString("hex"),
    now: deps.clock.now(),
  });
  return redirect(
    buildAuthorizeUrl({
      clientId: config.githubClientId,
      redirectUri: callbackUrl(config),
      state: rawState,
      codeChallenge: pkceChallenge(codeVerifier),
    }),
    [buildOAuthBindingSetCookie(rawNonce)],
  );
}

/** GET /auth/callback: validates state one-time, exchanges code, issues session. */
export async function handleAuthCallback(request: Request, deps: AuthRouteDeps): Promise<Response> {
  const { config, client } = requireOAuth(deps);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw badRequest("missing code or state");
  }
  const flow = await deps.sessions.consumeLoginFlow(state, deps.clock.now());
  if (!flow) {
    // Unknown / expired / already-consumed state (replay) — one bucket, no oracle.
    throw badRequest("invalid or expired OAuth state");
  }
  // A6: the callback must come from the browser that started the flow.
  // Exactly one non-empty binding nonce, constant-time compared against the
  // consumed flow's hash. Missing / duplicated / mismatched bindings fail
  // closed here — the flow is already consumed, so there is no retry oracle.
  const bindings = parseOAuthBindingCookies(request.headers.get("cookie"));
  if (bindings.length !== 1 || !bindings[0] || !bindingMatches(bindings[0]!, flow.bindingHash)) {
    throw badRequest("invalid OAuth browser binding");
  }
  let profile: GitHubUserProfile;
  try {
    const { accessToken } = await client.exchangeCode({
      code,
      codeVerifier: flow.codeVerifier,
      redirectUri: callbackUrl(config),
      clientId: config.githubClientId,
      clientSecret: config.githubClientSecret,
    });
    try {
      profile = await client.getUser(accessToken);
    } finally {
      // The user access token is dropped immediately after the identity
      // read — it is never stored, never logged, never placed in the session.
    }
  } catch (e) {
    if (e instanceof GitHubOAuthError) {
      throw badGateway("GitHub login failed — please retry");
    }
    throw e;
  }
  const created = await deps.sessions.createSession(
    githubUser(profile.id, profile.login),
    deps.clock.now(),
  );
  // Issue the session and retire the binding nonce in the same redirect.
  return redirect(resolveReturnTo(flow.returnTo), [
    buildSessionSetCookie(created.rawToken),
    buildOAuthBindingClearCookie(),
  ]);
}

/** POST /auth/logout: revokes presented session(s), clears the cookie. Always 200. */
export async function handleAuthLogout(request: Request, deps: AuthRouteDeps): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  for (const raw of parseSessionCookies(cookieHeader)) {
    if (raw) await deps.sessions.revokeSession(raw);
  }
  return new Response(JSON.stringify({ loggedOut: true }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": buildSessionClearCookie(),
    },
  });
}

/** GET /auth/session: returns the current principal, or 401 without a valid session. */
export async function handleAuthSession(request: Request, deps: AuthRouteDeps): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const presented = parseSessionCookies(cookieHeader);
  if (presented.length !== 1 || !presented[0]) {
    throw unauthorized("no session");
  }
  const record = await deps.sessions.lookupSession(presented[0]!, deps.clock.now());
  if (!record) {
    throw unauthorized("invalid or expired session");
  }
  return new Response(
    JSON.stringify({ user: { id: record.user.id, login: record.user.login } }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}
