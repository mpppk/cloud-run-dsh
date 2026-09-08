// Authentication (仕様書 section 21, 実装手順書 section 25; issues #149, #156).
//
// Identity model: the application's internal user principal is
// provider-agnostic in shape but GitHub-backed in this milestone —
// `AuthenticatedUser.id` is ALWAYS `github:<numeric-id>` (immutable), never
// a mutable login and never an email. GitHub logins change; numeric ids do
// not. `login` is display / audit only and MUST NOT be used as an
// authorization key.
//
// Request authentication is the `__Host-dsh_session` cookie (issue #152,
// `authenticateSession` in auth-session.ts). Header-based external
// authentication was removed in #156 together with the proxy infrastructure:
// no request header authenticates, only the server-side session counts.

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
 * Back-compat alias. Prefer `AuthenticatedUser` in new code.
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
