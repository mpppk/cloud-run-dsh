// Authentication (仕様書 section 21, 実装手順書 section 25)
//
// The identity comes from IAP headers set in front of the Cloud Run service.
// The application resolves the authenticated identity to an internal user id
// and then ALWAYS verifies workspace membership before authorizing
// (仕様書 section 26 item 7). A valid IAP identity alone is never sufficient.

import { unauthorized } from "./errors.js";

export interface IapIdentity {
  /** e.g. "accounts.google.com:1234567890" from x-goog-authenticated-user-id */
  readonly subject: string;
  /** e.g. "alice@example.com" from x-goog-authenticated-user-email */
  readonly email: string;
}

export interface InternalUser {
  /** Internal user id used for membership and lease ownership. */
  readonly id: string;
  readonly email: string;
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
  readonly resolveUser: (identity: IapIdentity) => Promise<InternalUser | null>;
}

/**
 * Resolves the request identity from IAP headers. Throws 401 when headers are
 * missing or the identity cannot be resolved to an internal user.
 * Membership/authorization is NOT checked here — every handler must verify
 * workspace membership separately (実装手順書 section 25).
 */
export async function authenticate(headers: Headers, deps: AuthDeps): Promise<InternalUser> {
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
