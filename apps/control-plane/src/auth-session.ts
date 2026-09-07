// Opaque server-side authentication sessions (issue #150).
//
// Design: the browser holds ONLY a high-entropy raw token in the
// `__Host-dsh_session` cookie. The database stores SHA-256(raw token) and
// never the raw token; logs and error messages must never carry it either.
// Lookup is `hash + expires_at > now()`, fail closed. Cleanup of expired
// rows is NOT a correctness premise (a follow-up may add periodic GC).
//
// OAuth login-flow state (issue #151) lives behind the same seam: the raw
// `state` is hashed before storage and consumed exactly once (atomic
// DELETE ... RETURNING, so a replayed callback finds nothing).

import { createHash, randomBytes } from "node:crypto";
import type { QueryExecutor } from "@cloud-run-dsh/session-persistence-postgres";
import { githubUser, type AuthenticatedUser } from "./auth.js";
import { unauthorized } from "./errors.js";

/** Session cookie name. The `__Host-` prefix forces Secure + Path=/ + no Domain. */
export const SESSION_COOKIE_NAME = "__Host-dsh_session";
/** Raw token size: 256 bits, base64url-encoded (~43 chars). */
export const SESSION_TOKEN_BYTES = 32;
/** Raw OAuth state size: 256 bits. */
export const LOGIN_STATE_BYTES = 32;
/** Session lifetime: 7 days fixed (issue #150 initial value). */
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** OAuth login-flow lifetime: 5 minutes (issue #150 initial value). */
export const LOGIN_FLOW_LIFETIME_MS = 5 * 60 * 1000;

/** Generates a 256-bit base64url raw token (session token or OAuth state). */
export function generateRawToken(bytes: number = SESSION_TOKEN_BYTES): string {
  return base64Url(randomBytes(bytes));
}

/** PKCE `code_verifier`: 32 random bytes, base64url (meets RFC 7636 length). */
export function generateCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

/** PKCE S256 `code_challenge = BASE64URL(SHA256(verifier))`. */
export function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier, "utf8").digest());
}

/** SHA-256(raw) as bytes for BYTEA storage/comparison. Raw material never leaves the caller. */
export function hashToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// ---------------------------------------------------------------------------
// Cookie rendering / parsing
// ---------------------------------------------------------------------------

const SESSION_COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax" as const;

/** `Set-Cookie` value issuing a session. Max-Age mirrors the 7-day lifetime. */
export function buildSessionSetCookie(rawToken: string): string {
  return `${SESSION_COOKIE_NAME}=${rawToken}; Max-Age=${SESSION_LIFETIME_MS / 1000}; ${SESSION_COOKIE_ATTRIBUTES}`;
}

/** `Set-Cookie` value clearing the session (logout). */
export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; ${SESSION_COOKIE_ATTRIBUTES}`;
}

/**
 * Extracts `__Host-dsh_session` values from a `Cookie` header.
 *
 * Returns ALL occurrences: callers MUST fail closed unless exactly one
 * non-empty value is present (duplicates are a smuggling / fixation smell).
 * An empty value counts as malformed (present but empty), not as absent.
 */
export function parseSessionCookies(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const found: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    found.push(part.slice(eq + 1).trim());
  }
  return found;
}

// ---------------------------------------------------------------------------
// SessionStore seam
// ---------------------------------------------------------------------------

export interface SessionRecord {
  readonly id: string;
  readonly user: AuthenticatedUser;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface CreatedSession {
  readonly id: string;
  /** Raw token — returned ONCE to be set as a cookie, never persisted. */
  readonly rawToken: string;
  readonly expiresAt: Date;
}

export interface CreatedLoginFlow {
  readonly expiresAt: Date;
}

export interface ConsumedLoginFlow {
  readonly codeVerifier: string;
  readonly returnTo: string | null;
}

export interface SessionStore {
  createSession(user: AuthenticatedUser, now: Date): Promise<CreatedSession>;
  /** Returns null for unknown / malformed / expired tokens (fail closed). */
  lookupSession(rawToken: string, now: Date): Promise<SessionRecord | null>;
  revokeSession(rawToken: string): Promise<void>;  createLoginFlow(input: {
    /** Caller-generated raw state (256-bit); only its hash is stored. */
    rawState: string;
    codeVerifier: string;
    returnTo: string | null;
    now: Date;
  }): Promise<CreatedLoginFlow>;
  /**
   * Atomically consumes a login flow exactly once. Returns null for
   * unknown / expired / already-consumed states (replay-safe).
   */
  consumeLoginFlow(rawState: string, now: Date): Promise<ConsumedLoginFlow | null>;
  revokeLoginFlow?(rawState: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (dev / tests)
// ---------------------------------------------------------------------------

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord & { tokenHashHex: string }>();
  private readonly flows = new Map<
    string,
    ConsumedLoginFlow & { expiresAtMs: number }
  >();

  async createSession(user: AuthenticatedUser, now: Date): Promise<CreatedSession> {
    const rawToken = generateRawToken();
    const id = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    this.sessions.set(hashToken(rawToken).toString("hex"), {
      id,
      user,
      createdAt: new Date(now),
      expiresAt,
      tokenHashHex: hashToken(rawToken).toString("hex"),
    });
    return { id, rawToken, expiresAt };
  }

  async lookupSession(rawToken: string, now: Date): Promise<SessionRecord | null> {
    if (!rawToken) return null;
    const record = this.sessions.get(hashToken(rawToken).toString("hex"));
    if (!record) return null;
    if (record.expiresAt.getTime() <= now.getTime()) return null;
    return { id: record.id, user: record.user, createdAt: record.createdAt, expiresAt: record.expiresAt };
  }

  async revokeSession(rawToken: string): Promise<void> {
    if (!rawToken) return;
    this.sessions.delete(hashToken(rawToken).toString("hex"));
  }

  async createLoginFlow(input: {
    rawState: string;
    codeVerifier: string;
    returnTo: string | null;
    now: Date;
  }): Promise<CreatedLoginFlow> {
    this.flows.set(hashToken(input.rawState).toString("hex"), {
      codeVerifier: input.codeVerifier,
      returnTo: input.returnTo,
      expiresAtMs: input.now.getTime() + LOGIN_FLOW_LIFETIME_MS,
    });
    return { expiresAt: new Date(input.now.getTime() + LOGIN_FLOW_LIFETIME_MS) };
  }

  async consumeLoginFlow(rawState: string, now: Date): Promise<ConsumedLoginFlow | null> {
    if (!rawState) return null;
    const key = hashToken(rawState).toString("hex");
    const flow = this.flows.get(key);
    // One-time by construction: delete first, then judge expiry.
    this.flows.delete(key);
    if (!flow) return null;
    if (flow.expiresAtMs <= now.getTime()) return null;
    return { codeVerifier: flow.codeVerifier, returnTo: flow.returnTo };
  }

  async revokeLoginFlow(rawState: string): Promise<void> {
    if (!rawState) return;
    this.flows.delete(hashToken(rawState).toString("hex"));
  }

  /** Test seam: how many live rows exist. */
  size(): { sessions: number; flows: number } {
    return { sessions: this.sessions.size, flows: this.flows.size };
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation (production; issue #150 schema)
// ---------------------------------------------------------------------------

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly executor: QueryExecutor) {}

  async createSession(user: AuthenticatedUser, now: Date): Promise<CreatedSession> {
    const rawToken = generateRawToken();
    const id = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    await this.executor.exec(
      `INSERT INTO auth_sessions(id, token_hash, user_id, github_user_id, github_login, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        hashToken(rawToken),
        user.id,
        Number(user.providerUserId),
        user.login,
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    return { id, rawToken, expiresAt };
  }

  async lookupSession(rawToken: string, now: Date): Promise<SessionRecord | null> {
    if (!rawToken) return null;
    const rows = await this.executor.query<Record<string, unknown>>(
      `SELECT id, user_id, github_user_id, github_login, created_at, expires_at
       FROM auth_sessions WHERE token_hash = $1 AND expires_at > $2`,
      [hashToken(rawToken), now.toISOString()],
    );
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      id: String(row["id"]),
      user: githubUser(String(row["github_user_id"]), String(row["github_login"])),
      createdAt: new Date(String(row["created_at"])),
      expiresAt: new Date(String(row["expires_at"])),
    };
  }

  async revokeSession(rawToken: string): Promise<void> {
    if (!rawToken) return;
    await this.executor.exec(`DELETE FROM auth_sessions WHERE token_hash = $1`, [
      hashToken(rawToken),
    ]);
  }

  async createLoginFlow(input: {
    rawState: string;
    codeVerifier: string;
    returnTo: string | null;
    now: Date;
  }): Promise<CreatedLoginFlow> {
    const expiresAt = new Date(input.now.getTime() + LOGIN_FLOW_LIFETIME_MS);
    await this.executor.exec(
      `INSERT INTO oauth_login_flows(state_hash, code_verifier, return_to, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        hashToken(input.rawState),
        input.codeVerifier,
        input.returnTo,
        input.now.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    return { expiresAt };
  }

  async consumeLoginFlow(rawState: string, now: Date): Promise<ConsumedLoginFlow | null> {
    if (!rawState) return null;
    // Atomic one-time consume: the row vanishes in the same statement that
    // checks expiry, so a replayed (or concurrent) callback finds nothing.
    const rows = await this.executor.query<Record<string, unknown>>(
      `DELETE FROM oauth_login_flows WHERE state_hash = $1 AND expires_at > $2
       RETURNING code_verifier, return_to`,
      [hashToken(rawState), now.toISOString()],
    );
    if (rows.length === 0) return null;
    const row = rows[0]!;
    const returnTo = row["return_to"];
    return {
      codeVerifier: String(row["code_verifier"]),
      returnTo: returnTo === null || returnTo === undefined ? null : String(returnTo),
    };
  }

  async revokeLoginFlow(rawState: string): Promise<void> {
    if (!rawState) return;
    await this.executor.exec(`DELETE FROM oauth_login_flows WHERE state_hash = $1`, [
      hashToken(rawState),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Request authentication (issue #152)
// ---------------------------------------------------------------------------

export interface SessionAuthDeps {
  readonly sessions: SessionStore;
  readonly clock: { now(): Date };
}

/**
 * Authenticates a request via the `__Host-dsh_session` cookie (issue #152).
 *
 * Exactly one non-empty cookie value must be present; the token resolves
 * through the server-side store with an expiry check. Anything else —
 * absent / duplicated / empty / unknown / expired — is a 401. IAP headers
 * are NEVER consulted here: sending them without a session authenticates
 * nothing. Membership/authorization is NOT checked — handlers verify
 * workspace membership separately.
 */
export async function authenticateSession(
  request: Request,
  deps: SessionAuthDeps,
): Promise<AuthenticatedUser> {
  const presented = parseSessionCookies(request.headers.get("cookie"));
  if (presented.length !== 1 || !presented[0]) {
    throw unauthorized("missing session cookie");
  }
  const record = await deps.sessions.lookupSession(presented[0]!, deps.clock.now());
  if (!record) {
    throw unauthorized("invalid or expired session");
  }
  return record.user;
}
