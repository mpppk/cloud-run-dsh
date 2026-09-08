// Authentication (仕様書 section 21, 実装手順書 section 25; issue #149).
//
// Identity model after #149: the application's internal user principal is
// provider-agnostic in shape but GitHub-backed in this milestone —
// `AuthenticatedUser.id` is ALWAYS `github:<numeric-id>` (immutable), never
// a mutable login and never an email. GitHub logins change; numeric ids do
// not. `login` is display / audit only and MUST NOT be used as an
// authorization key.
//
// TRANSITIONAL (#149 only): the external request edge still parses IAP
// headers (parseIapHeaders / resolveUser below) because GitHub OAuth lands
// in #151 and the session-cookie cutover in #152. The IAP-specific
// `IapIdentity` type lives ONLY at this external edge — it no longer flows
// into handlers, the forwarder, or the agent-host. #152 removes it entirely.

import { unauthorized } from "./errors.js";

/** External IdP artifact (IAP edge only). Never crosses the domain seam. */
export interface IapIdentity {
  /** e.g. "accounts.google.com:1234567890" from x-goog-authenticated-user-id */
  readonly subject: string;
  /** e.g. "alice@example.com" from x-goog-authenticated-user-email */
  readonly email: string;
}

/**
 * Internal application principal (issue #149).
 *
 * `id` is the stable membership / lease-ownership key (`github:<numeric-id>`).
 * `providerUserId` is the raw GitHub numeric user id; `login` is the current
 * GitHub login for display / audit / permission-lookup input only.
 */
export interface AuthenticatedUser {
  /** Stable internal user id used for membership and lease ownership. */
  readonly id: string;
  readonly provider: "github";
  /** GitHub numeric user id (immutable). */
  readonly providerUserId: string;
  /** GitHub login (mutable — display / audit only, never an authz key). */
  readonly login: string;
}

/**
 * Back-compat alias. Prefer `AuthenticatedUser` in new code; `InternalUser`
 * remains so existing imports keep compiling during the #149–#152 migration.
 */
export type InternalUser = AuthenticatedUser;

/** Builds the canonical internal id from a GitHub numeric user id. */
export function githubUserId(numericId: number | string): string {
  return `github:${numericId}`;
}

/** Constructs an `AuthenticatedUser` from GitHub profile attributes. */
export function githubUser(numericId: number | string, login: string): AuthenticatedUser {
  const providerUserId = String(numericId);
  return { id: githubUserId(providerUserId), provider: "github", providerUserId, login };
}

/** Parses the IAP headers injected by Identity-Aware Proxy. Returns null when absent/malformed. */
export function parseIapHeaders(headers: Headers): IapIdentity | null {
  const rawSubject = headers.get("x-goog-authenticated-user-id");
  const email = headers.get("x-goog-authenticated-user-email");
  if (!rawSubject || !email) return null;
  const separator = rawSubject.indexOf(":");
  const subject = separator >= 0 ? rawSubject.slice(separator + 1) : rawSubject;
  if (!subject) return null;
  return { subject, email };
}

export interface AuthDeps {
  /** Resolves an IAP identity to the internal user. Returns null when unknown. */
  readonly resolveUser: (identity: IapIdentity) => Promise<AuthenticatedUser | null>;
}

/**
 * Resolves the request identity from IAP headers. Throws 401 when headers are
 * missing or the identity cannot be resolved to an internal user.
 * Membership/authorization is NOT checked here — every handler must verify
 * workspace membership separately (実装手順書 section 25).
 *
 * TRANSITIONAL: replaced by session-cookie authentication in #152.
 */
export async function authenticate(
  headers: Headers,
  deps: AuthDeps,
): Promise<AuthenticatedUser> {
  const identity = parseIapHeaders(headers);
  if (!identity) {
    throw unauthorized("missing IAP identity headers");
  }
  const user = await deps.resolveUser(identity);
  if (!user) {
    throw unauthorized("unknown identity");
  }
  return user;
}
