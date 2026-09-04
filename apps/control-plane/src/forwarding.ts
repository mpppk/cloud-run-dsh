// Message forwarding: control-plane -> agent-host (issue #22).
//
// Design (coordinator-approved):
//   1. The control plane stays the SOLE writer of `user_message` events: it
//      appends to the shared DB first (the 201 contract), then forwards.
//   2. Immediately after the append it POSTs to the workspace Instance's
//      agent-host gateway
//      (`POST /workspaces/:id/sessions/:sid/messages`) with the appended
//      event's seq + content. The agent-host starts the turn from that
//      payload and MUST NOT append `user_message` again (single-writer
//      invariant; enforced by tests on both sides).
//   3. A stopped / never-opened Instance (no URL) is a typed 409, never a
//      blind wait: parking the request on a Cloud Run start would risk the
//      request timeout. The client opens the workspace first, then retries.
//   4. A failed forward after a successful append is a typed 502, never a
//      fake 201: the orphan event exists, the client must know the turn did
//      not start, and the log must show why.
//
// Authentication: Instances carry invoker IAM, so the forward needs an ID
// token whose audience is the Instance URL, minted at the metadata server
// (`.../identity?audience=<url>`). The caching/expiry shape mirrors the #27
// access-token provider (apps/agent-host/src/adapters.ts
// RefreshingGcsTokenProvider): cache until a refresh margin before expiry
// and share one in-flight refresh per audience. It is NOT shared code
// because the endpoints, response shapes (JWT text vs JSON) and lifetimes
// differ — sharing would couple two unrelated credential kinds.

import type { Logger } from "@cloud-run-dsh/observability";

// ---------------------------------------------------------------------------
// ID tokens (invoker IAM for the Instance)
// ---------------------------------------------------------------------------

/** Mints an ID token for one audience (normally the Instance base URL). */
export type IdTokenProvider = (audience: string) => Promise<string>;

/** Metadata-server endpoint for the attached service account's identity. */
export const ID_TOKEN_METADATA_BASE =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/** Refresh this far before expiry so skew never serves a dead token. */
export const ID_TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Assumed lifetime when the JWT carries no usable `exp` claim. */
export const ID_TOKEN_DEFAULT_EXPIRES_IN_S = 3600;

/**
 * Escape hatch for local runs / CI (unknown expiry, re-read on refresh).
 * Audience-bound in production, so a single static token only makes sense
 * off-GCP where no Instance is ever reached.
 */
export const ID_TOKEN_ENV_VAR = "GCP_ID_TOKEN";

/** Synthetic lifetime for env-var tokens, whose real expiry is unknown. */
export const ID_TOKEN_ENV_LIFETIME_S = 300;

export function buildIdTokenUrl(audience: string): string {
  return `${ID_TOKEN_METADATA_BASE}?audience=${encodeURIComponent(audience)}`;
}

/** Short machine-readable reason codes only — never response bodies or tokens. */
export class IdTokenSourceError extends Error {
  override readonly name = "IdTokenSourceError";
  constructor(readonly code: string) {
    super(`metadata-server: ${code}`);
  }
}

/** Reads the `exp` (seconds since epoch) claim of an unsigned-or-signed JWT. */
export function parseJwtExpSeconds(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    const exp = payload["exp"];
    return typeof exp === "number" && Number.isFinite(exp) ? Math.floor(exp) : null;
  } catch {
    return null;
  }
}

export interface RefreshingIdTokenProviderDeps {
  readonly clock?: { nowMs(): number };
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
  /** Abort a hanging metadata fetch so off-GCP hosts fall back fast. */
  readonly metadataTimeoutMs?: number;
}

interface SourcedIdToken {
  readonly token: string;
  /** Lifetime in seconds from acquisition. */
  readonly expiresInS: number;
  readonly source: "metadata-server" | "env";
}

/**
 * Caching ID-token provider (one cache entry per audience — every Instance
 * has its own URL and tokens are audience-bound).
 */
export class RefreshingIdTokenProvider {
  private readonly clock: { nowMs(): number };
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly metadataTimeoutMs: number;
  private readonly cache = new Map<string, { token: string; expiresAtMs: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    deps: RefreshingIdTokenProviderDeps = {},
  ) {
    this.clock = deps.clock ?? { nowMs: () => Date.now() };
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.metadataTimeoutMs = deps.metadataTimeoutMs ?? 2000;
  }

  async getToken(audience: string): Promise<string> {
    const aud = audience.trim();
    if (!aud) throw new Error("ID token audience must be a non-empty URL");
    const hit = this.cache.get(aud);
    if (hit && this.clock.nowMs() < hit.expiresAtMs - ID_TOKEN_REFRESH_MARGIN_MS) {
      return hit.token;
    }
    // Expiry stampede guard per audience: concurrent forwards share one mint.
    const ongoing = this.inflight.get(aud);
    if (ongoing) return ongoing;
    const pending = this.refresh(aud).then((sourced) => {
      this.cache.set(aud, {
        token: sourced.token,
        expiresAtMs: this.clock.nowMs() + sourced.expiresInS * 1000,
      });
      return sourced.token;
    });
    this.inflight.set(aud, pending);
    try {
      return await pending;
    } finally {
      this.inflight.delete(aud);
    }
  }

  private async refresh(audience: string): Promise<SourcedIdToken> {
    try {
      const sourced = await this.fetchFromMetadataServer(audience);
      this.logger?.info("control-plane.auth.id_token_source", { source: sourced.source });
      return sourced;
    } catch (err) {
      const code = err instanceof IdTokenSourceError ? err.code : "unreachable";
      this.logger?.info("control-plane.auth.id_token_source_skipped", {
        source: "metadata-server",
        reason: code,
      });
    }
    const envToken = this.env[ID_TOKEN_ENV_VAR]?.trim();
    if (envToken) {
      const sourced: SourcedIdToken = {
        token: envToken,
        expiresInS: ID_TOKEN_ENV_LIFETIME_S,
        source: "env",
      };
      this.logger?.info("control-plane.auth.id_token_source", { source: sourced.source });
      return sourced;
    }
    throw new Error(
      `no ID token source available (metadata-server unreachable and ${ID_TOKEN_ENV_VAR} is not set). ` +
        `On Cloud Run the metadata server must be reachable; locally set ${ID_TOKEN_ENV_VAR}.`,
    );
  }

  /** The identity endpoint answers with the raw JWT as text (not JSON). */
  private async fetchFromMetadataServer(audience: string): Promise<SourcedIdToken> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.metadataTimeoutMs);
    try {
      const res = await this.fetchImpl(buildIdTokenUrl(audience), {
        method: "GET",
        headers: { "Metadata-Flavor": "Google" },
        signal: controller.signal,
      });
      if (!res.ok) throw new IdTokenSourceError(`http-${res.status}`);
      const token = (await res.text()).trim();
      if (!token || !token.includes(".")) throw new IdTokenSourceError("bad-response");
      const nowSec = Math.floor(this.clock.nowMs() / 1000);
      const exp = parseJwtExpSeconds(token);
      const expiresInS =
        exp !== null && exp > nowSec ? exp - nowSec : ID_TOKEN_DEFAULT_EXPIRES_IN_S;
      return { token, expiresInS, source: "metadata-server" };
    } catch (err) {
      if (err instanceof IdTokenSourceError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new IdTokenSourceError("timeout");
      }
      throw new IdTokenSourceError("unreachable");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Production ID-token provider: metadata server, else GCP_ID_TOKEN. */
export function createIdTokenProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: RefreshingIdTokenProviderDeps = {},
): IdTokenProvider {
  const provider = new RefreshingIdTokenProvider(env, deps);
  return (audience: string) => provider.getToken(audience);
}

// ---------------------------------------------------------------------------
// Forwarding (control-plane -> agent-host gateway)
// ---------------------------------------------------------------------------

export interface ForwardIdentity {
  readonly id: string;
  readonly email: string;
}

export interface ForwardMessageArgs {
  /** Instance base URL (scheme + host, no trailing slash handling needed). */
  readonly instanceUrl: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  /** Seq of the just-appended `user_message` event (the shared reference). */
  readonly seq: number;
  readonly content: string;
  /** Caller identity, propagated so the host's gateway check can run. */
  readonly identity: ForwardIdentity;
}

export interface AgentHostForwardResult {
  readonly status: number;
  readonly turnStarted: boolean;
}

/**
 * Narrow seam the route handler depends on. Tests inject recording fakes;
 * production uses HttpAgentHostForwarder below.
 */
export interface MessageForwarder {
  forward(args: ForwardMessageArgs): Promise<AgentHostForwardResult>;
}

/** The agent-host refused the message for a caller-visible reason (maps to 409). */
export class AgentHostConflictError extends Error {
  override readonly name = "AgentHostConflictError";
  constructor(message: string) {
    super(message);
  }
}

/** The forward failed after the event was recorded (maps to 502, never 201). */
export class AgentHostForwardError extends Error {
  override readonly name = "AgentHostForwardError";
  constructor(message: string) {
    super(message);
  }
}

export type AgentHostFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpAgentHostForwarderOptions {
  readonly idTokenProvider: IdTokenProvider;
  readonly fetchFn?: AgentHostFetchFn;
  readonly logger?: Logger;
  /** Abort a hanging forward so postMessage never parks on a dead Instance. */
  readonly timeoutMs?: number;
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export class HttpAgentHostForwarder implements MessageForwarder {
  private readonly fetchFn: AgentHostFetchFn;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpAgentHostForwarderOptions) {
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async forward(args: ForwardMessageArgs): Promise<AgentHostForwardResult> {
    const base = args.instanceUrl.replace(/\/$/, "");
    // Audience is the Instance origin (scheme + host). The metadata server
    // signs `aud` exactly, so trailing slashes must not leak in.
    let idToken: string;
    try {
      idToken = await this.opts.idTokenProvider(base);
    } catch (e) {
      throw new AgentHostForwardError(
        `cannot mint ID token for the workspace instance: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const url =
      `${base}/workspaces/${encodeURIComponent(args.workspaceId)}` +
      `/sessions/${encodeURIComponent(args.sessionId)}/messages`;
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        res = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Invoker IAM at the platform edge.
            authorization: `Bearer ${idToken}`,
            // Caller identity for the host's gateway check. Trusted ONLY
            // because invoker IAM restricts callers to this service account.
            "x-goog-authenticated-user-email": args.identity.email,
            "x-goog-authenticated-user-id": `accounts.google.com:${args.identity.id}`,
          },
          body: JSON.stringify({
            workspaceId: args.workspaceId,
            sessionId: args.sessionId,
            seq: args.seq,
            content: args.content,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const reason =
        e instanceof Error && e.name === "AbortError"
          ? `timed out after ${this.timeoutMs}ms`
          : (e instanceof Error ? e.message : String(e));
      throw new AgentHostForwardError(
        `workspace instance unreachable at ${base} (${reason})`,
      );
    }
    if (res.status === 409 || res.status === 403) {
      // The host refused for a caller-actionable reason (lease, stale state):
      // propagate as conflict, not as a gateway failure.
      throw new AgentHostConflictError(
        `agent-host refused the message (status ${res.status}): ${truncate(await safeText(res))}`,
      );
    }
    if (!res.ok) {
      throw new AgentHostForwardError(
        `agent-host answered ${res.status}: ${truncate(await safeText(res))}`,
      );
    }
    // The gateway reports explicitly when the turn did NOT start
    // (turnStarted:false while the HTTP status stays 202). Trusting the
    // status alone would re-create the "looks delivered but nothing runs"
    // failure this forwarding exists to remove.
    let turnStarted = true;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      if (body !== null && typeof body === "object" && body["turnStarted"] === false) {
        turnStarted = false;
      }
    } catch {
      // Non-JSON 2xx: no turn flag to contradict delivery; treat as started.
    }
    if (!turnStarted) {
      throw new AgentHostForwardError(
        "agent-host accepted the request but reported turnStarted:false — the turn did not start",
      );
    }
    this.opts.logger?.info("control-plane.forward.delivered", {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      seq: args.seq,
      status: res.status,
    });
    return { status: res.status, turnStarted };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return "";
  }
}
