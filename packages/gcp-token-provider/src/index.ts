// Shared GCP OAuth2 access-token provider.
//
// Origin: issue #27 (agent-host side, PR #33). Issue #76 moved it here so the
// control plane uses the SAME chain instead of a second copy: app-to-app
// imports are banned, so shared auth code lives in packages/.
//
// The minted token carries the Cloud Platform scope, so both apps use it for
// every GCP REST call (agent-host: GCS JSON API; control-plane: Instances API
// + GCS JSON API).
//
// Fallback order (explicit — local dev and CI must keep working):
//   1. metadata-server — Cloud Run / GCE / GKE metadata server, using the
//      attached service account. Production path; no secret is configured.
//      Measured token lifetime on real GCP is ~1799s, so every callminting a
//      fresh token would hit the metadata server for no reason — hence the
//      cache below.
//   2. adc — Application Default Credentials from GOOGLE_APPLICATION_CREDENTIALS
//      or the gcloud well-known file, refreshed/minted over HTTPS. Local-dev
//      path after `gcloud auth application-default login` (there is no
//      metadata server off GCP).
//   3. env — GCP_ACCESS_TOKEN (unknown expiry). Escape hatch for CI / local
//      scripts; preserved from the original implementation.
//
// Every successful acquisition logs WHICH source was used (never the token).
// Acquired tokens are cached until 60s before expiry and concurrent callers
// share a single in-flight refresh so expiry stampedes hit the source once.

import { promises as nodeFs } from "node:fs";
import { createSign } from "node:crypto";
import type { Clock } from "@cloud-run-dsh/workspace-checkpoint";
import { SystemClock } from "@cloud-run-dsh/workspace-checkpoint";
import type { Logger } from "@cloud-run-dsh/observability";

/** Provides a GCP OAuth2 access token for REST calls. */
export type GcsTokenProvider = () => Promise<string>;

/**
 * Minimal fetch shape the token chain needs (a subset of `typeof fetch`).
 * Deliberately narrow so both the global fetch and minimal test stubs
 * ( `{ ok, status, json() }` ) satisfy it without casts.
 */
export interface GcpTokenFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface GcpTokenFetchFn {
  (url: string, init?: RequestInit): Promise<GcpTokenFetchResponse>;
}

/** Metadata server endpoint for the attached service account's token. */
export const GCS_METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** Refresh this far before expiry so clock skew / slow fetches never serve a dead token. */
export const GCS_TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Assumed lifetime when a source omits expires_in. */
export const GCS_TOKEN_DEFAULT_EXPIRES_IN_S = 3600;

/**
 * Synthetic lifetime for env-var tokens, whose real expiry is unknown.
 * Re-reading every few minutes lets rotations propagate.
 */
export const GCS_ENV_TOKEN_LIFETIME_S = 300;

/** OAuth scope requested when minting tokens from ADC service-account keys. */
export const GCS_ADC_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const GCS_ADC_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GCS_ADC_WELL_KNOWN_SUFFIX = ".config/gcloud/application_default_credentials.json";

export type GcsAuthSource =
  | "metadata-server"
  | "adc-authorized-user"
  | "adc-service-account"
  | "env";

export interface ChainedGcsTokenProviderDeps {
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly fetchImpl?: GcpTokenFetchFn;
  readonly readFile?: (path: string) => Promise<string>;
  /** Override the metadata URL (tests). */
  readonly metadataUrl?: string;
  /** Override the ADC credential file path (tests). */
  readonly adcCredentialsPath?: string;
  /** Abort a hanging metadata fetch so off-GCP hosts fall back fast. */
  readonly metadataTimeoutMs?: number;
}

interface SourcedToken {
  readonly token: string;
  /** Lifetime in seconds from acquisition. */
  readonly expiresInS: number;
  readonly source: GcsAuthSource;
}

/** Short machine-readable reason codes only — never response bodies or tokens. */
class GcsSourceError extends Error {
  override readonly name = "GcsSourceError";
  constructor(
    readonly source: string,
    readonly code: string,
  ) {
    super(`${source}: ${code}`);
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseTokenResponse(body: unknown, source: string): { token: string; expiresInS: number } {
  if (typeof body !== "object" || body === null) {
    throw new GcsSourceError(source, "bad-response");
  }
  const record = body as Record<string, unknown>;
  const token = record["access_token"];
  if (typeof token !== "string" || token === "") {
    throw new GcsSourceError(source, "bad-response");
  }
  const rawExpiresIn = record["expires_in"];
  const expiresInS =
    typeof rawExpiresIn === "number" && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
      ? Math.floor(rawExpiresIn)
      : GCS_TOKEN_DEFAULT_EXPIRES_IN_S;
  return { token, expiresInS };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export class RefreshingGcsTokenProvider {
  private readonly clock: Clock;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: GcpTokenFetchFn;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly metadataUrl: string;
  private readonly adcCredentialsPath: string | undefined;
  private readonly metadataTimeoutMs: number;
  private cached: { token: string; expiresAtMs: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    deps: ChainedGcsTokenProviderDeps = {},
  ) {
    this.clock = deps.clock ?? new SystemClock();
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.readFile = deps.readFile ?? ((path) => nodeFs.readFile(path, "utf8"));
    this.metadataUrl = deps.metadataUrl ?? GCS_METADATA_TOKEN_URL;
    this.adcCredentialsPath = deps.adcCredentialsPath;
    this.metadataTimeoutMs = deps.metadataTimeoutMs ?? 3000;
  }

  /** GcsTokenProvider: cached while valid, otherwise refreshed through the chain. */
  async getToken(): Promise<string> {
    const hit = this.cached;
    if (hit && this.clock.nowMs() < hit.expiresAtMs - GCS_TOKEN_REFRESH_MARGIN_MS) {
      return hit.token;
    }
    // Expiry stampede guard: concurrent callers share one refresh.
    if (this.inflight) return this.inflight;
    const pending = this.refresh().then((sourced) => {
      this.cached = {
        token: sourced.token,
        expiresAtMs: this.clock.nowMs() + sourced.expiresInS * 1000,
      };
      return sourced.token;
    });
    this.inflight = pending;
    try {
      return await pending;
    } finally {
      this.inflight = null;
    }
  }

  private async refresh(): Promise<SourcedToken> {
    const attempts: string[] = [];

    try {
      const sourced = await this.fetchFromMetadataServer();
      this.logSource(sourced);
      return sourced;
    } catch (err) {
      const code = err instanceof GcsSourceError ? err.code : "unreachable";
      attempts.push(`metadata-server:${code}`);
      this.logger?.info("gcs.auth.source_skipped", { source: "metadata-server", reason: code });
    }

    try {
      const sourced = await this.fetchFromAdc();
      if (sourced) {
        this.logSource(sourced);
        return sourced;
      }
      attempts.push("adc:unavailable");
    } catch (err) {
      const code = err instanceof GcsSourceError ? err.code : "unreachable";
      attempts.push(`adc:${code}`);
      this.logger?.info("gcs.auth.source_skipped", { source: "adc", reason: code });
    }

    const envToken = this.env["GCP_ACCESS_TOKEN"]?.trim();
    if (envToken) {
      const sourced: SourcedToken = {
        token: envToken,
        expiresInS: GCS_ENV_TOKEN_LIFETIME_S,
        source: "env",
      };
      this.logSource(sourced);
      return sourced;
    }
    attempts.push("env:missing");

    this.logger?.error("gcs.auth.no_credential_source", { attempts: attempts.join(",") });
    throw new Error(
      `no GCS credential source available (${attempts.join(", ")}). ` +
        `On Cloud Run the metadata server must be reachable; locally run ` +
        `'gcloud auth application-default login' or set GCP_ACCESS_TOKEN.`,
    );
  }

  /** Records which source minted the token — the token itself is never logged. */
  private logSource(sourced: SourcedToken): void {
    this.logger?.info("gcs.auth.token_source", {
      source: sourced.source,
      expires_in_s: sourced.expiresInS,
    });
  }

  private async fetchFromMetadataServer(): Promise<SourcedToken> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.metadataTimeoutMs);
    try {
      const res = await this.fetchImpl(this.metadataUrl, {
        method: "GET",
        headers: { "Metadata-Flavor": "Google" },
        signal: controller.signal,
      });
      if (!res.ok) throw new GcsSourceError("metadata-server", `http-${res.status}`);
      const parsed = parseTokenResponse(await res.json(), "metadata-server");
      return { ...parsed, source: "metadata-server" };
    } catch (err) {
      if (err instanceof GcsSourceError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new GcsSourceError("metadata-server", "timeout");
      }
      throw new GcsSourceError("metadata-server", "unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * ADC fallback (no new dependencies — plain fetch + node:crypto):
   * authorized_user entries are refreshed via the OAuth token endpoint;
   * service_account keys mint a self-signed JWT first.
   * Returns null when no ADC file is present (normal off-GCP state).
   */
  private async fetchFromAdc(): Promise<SourcedToken | null> {
    const explicit = this.env["GOOGLE_APPLICATION_CREDENTIALS"]?.trim();
    const home = this.env["HOME"]?.trim() || this.env["USERPROFILE"]?.trim();
    // The constructor dep wins for tests; otherwise the env var, otherwise
    // the gcloud well-known file. No path at all is the normal off-GCP
    // state — return null so the chain falls through to the env token.
    const path = this.adcCredentialsPath ?? explicit ?? (home ? `${home}/${GCS_ADC_WELL_KNOWN_SUFFIX}` : null);
    if (!path) return null;
    let raw: string;
    try {
      raw = await this.readFile(path);
    } catch {
      return null;
    }
    let doc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      doc = parsed as Record<string, unknown>;
    } catch {
      throw new GcsSourceError("adc", "bad-file");
    }
    if (doc["type"] === "authorized_user") {
      const clientId = doc["client_id"];
      const clientSecret = doc["client_secret"];
      const refreshToken = doc["refresh_token"];
      if (!nonEmpty(clientId) || !nonEmpty(clientSecret) || !nonEmpty(refreshToken)) {
        throw new GcsSourceError("adc", "bad-file");
      }
      return this.refreshAuthorizedUser(clientId, clientSecret, refreshToken);
    }
    if (doc["type"] === "service_account") {
      const clientEmail = doc["client_email"];
      const privateKey = doc["private_key"];
      if (!nonEmpty(clientEmail) || !nonEmpty(privateKey)) {
        throw new GcsSourceError("adc", "bad-file");
      }
      return this.mintServiceAccountToken(clientEmail, privateKey);
    }
    throw new GcsSourceError("adc", "unsupported-type");
  }

  private async refreshAuthorizedUser(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<SourcedToken> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString();
    let res: GcpTokenFetchResponse;
    try {
      res = await this.fetchImpl(GCS_ADC_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new GcsSourceError("adc", "unreachable");
    }
    if (!res.ok) throw new GcsSourceError("adc", `http-${res.status}`);
    const parsed = parseTokenResponse(await res.json(), "adc");
    return { ...parsed, source: "adc-authorized-user" };
  }

  private async mintServiceAccountToken(
    clientEmail: string,
    privateKey: string,
  ): Promise<SourcedToken> {
    const nowSec = Math.floor(this.clock.nowMs() / 1000);
    const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const claims = base64UrlEncode(
      new TextEncoder().encode(
        JSON.stringify({
          iss: clientEmail,
          scope: GCS_ADC_OAUTH_SCOPE,
          aud: GCS_ADC_TOKEN_URL,
          iat: nowSec,
          exp: nowSec + 3600,
        }),
      ),
    );
    const signingInput = `${header}.${claims}`;
    let assertion: string;
    try {
      const signer = createSign("RSA-SHA256");
      signer.update(signingInput);
      signer.end();
      assertion = `${signingInput}.${base64UrlEncode(new Uint8Array(signer.sign(privateKey)))}`;
    } catch {
      throw new GcsSourceError("adc", "bad-key");
    }
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString();
    let res: GcpTokenFetchResponse;
    try {
      res = await this.fetchImpl(GCS_ADC_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new GcsSourceError("adc", "unreachable");
    }
    if (!res.ok) throw new GcsSourceError("adc", `http-${res.status}`);
    const parsed = parseTokenResponse(await res.json(), "adc");
    return { ...parsed, source: "adc-service-account" };
  }
}

/**
 * Production token provider: metadata server → ADC → GCP_ACCESS_TOKEN.
 * Which source was used is logged (info); the token itself never is.
 */
export function createGcsTokenProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: ChainedGcsTokenProviderDeps = {},
): GcsTokenProvider {
  const provider = new RefreshingGcsTokenProvider(env, deps);
  return () => provider.getToken();
}

/** Last-resort env-only provider (kept for scripts/tests; prefer createGcsTokenProvider). */
export function envGcsTokenProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GcsTokenProvider {
  return async () => {
    const token = env["GCP_ACCESS_TOKEN"];
    if (!token) throw new Error("GCP_ACCESS_TOKEN is not set — cannot access GCS");
    return token;
  };
}
