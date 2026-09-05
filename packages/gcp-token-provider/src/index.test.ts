// Token chain tests (issue #27; shared by both apps since issue #76).
//
// Conventions: time is driven by the injected FakeClock (never wall time),
// fetch and ADC file reads are stubbed, and the InMemoryLogger proves which
// source was used without ever carrying the token itself.

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { InMemoryLogger } from "@cloud-run-dsh/observability";
import type { Clock } from "@cloud-run-dsh/workspace-checkpoint";
import {
  GCS_TOKEN_REFRESH_MARGIN_MS,
  RefreshingGcsTokenProvider,
} from "./index.js";

/** Minimal wall-free clock: the provider only ever reads nowMs(). */
class FakeClock implements Clock {
  private currentMs: number;
  constructor(initialMs = 1_000_000_000_000) {
    this.currentMs = initialMs;
  }
  now(): Date {
    return new Date(this.currentMs);
  }
  nowMs(): number {
    return this.currentMs;
  }
  advance(ms: number): void {
    this.currentMs += ms;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedFetch {
  url: string;
  init: RequestInit | undefined;
}

function createFetchStub(
  respond: (call: RecordedFetch) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr = typeof url === "string" ? url.toString() : url instanceof URL ? url.href : url.url;
    const call: RecordedFetch = { url: urlStr, init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const METADATA_TOKEN = {
  access_token: "ya29.metadata-token- hungrily-unique-AAA111",
  expires_in: 3600,
  token_type: "Bearer",
};

function metadataFetchStub(token: typeof METADATA_TOKEN = METADATA_TOKEN) {
  return createFetchStub((call) => {
    if (!call.url.includes("metadata.google.internal")) {
      return new Response("unexpected url", { status: 500 });
    }
    return jsonResponse(token);
  });
}

/** Fails the test if any log line contains the raw token. */
function expectTokenNeverLogged(logger: InMemoryLogger, token: string): void {
  for (const line of logger.lines) {
    expect(line.includes(token)).toBe(false);
  }
}

function tokenSourceEvent(logger: InMemoryLogger): Record<string, unknown> | undefined {
  return logger.parsed.find((entry) => entry["event"] === "gcs.auth.token_source") as
    | Record<string, unknown>
    | undefined;
}

describe("RefreshingGcsTokenProvider", () => {
  test("sends the Metadata-Flavor header to the metadata server", async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = metadataFetchStub();
    const provider = new RefreshingGcsTokenProvider({}, { clock, fetchImpl });

    await provider.getToken();

    expect(calls.length).toBe(1);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Metadata-Flavor"]).toBe("Google");
    expect(calls[0]!.url).toContain("metadata.google.internal");
  });

  test("caches within expiry and never re-hits the metadata server", async () => {
    const clock = new FakeClock();
    const logger = new InMemoryLogger();
    const { fetchImpl, calls } = metadataFetchStub();
    const provider = new RefreshingGcsTokenProvider({}, { clock, logger, fetchImpl });

    const first = await provider.getToken();
    clock.advance(10 * 60 * 1000);
    const second = await provider.getToken();
    clock.advance(30 * 60 * 1000);
    const third = await provider.getToken();

    expect(first).toBe(METADATA_TOKEN.access_token);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(calls.length).toBe(1);
    expectTokenNeverLogged(logger, METADATA_TOKEN.access_token);
  });

  test("refetches once the remaining lifetime drops below the 60s margin", async () => {
    const clock = new FakeClock();
    let issued = 0;
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({ ...METADATA_TOKEN, access_token: `ya29.token-${issued++}` }),
    );
    const provider = new RefreshingGcsTokenProvider({}, { clock, fetchImpl });

    const first = await provider.getToken();
    expect(first).toBe("ya29.token-0");

    // 3600s lifetime - 60s margin: 3539s in, the cached token is still valid.
    clock.advance((3600 - 61) * 1000);
    expect(await provider.getToken()).toBe("ya29.token-0");
    expect(calls.length).toBe(1);

    // 1s later the remaining 60s boundary is reached — the next call refetches.
    clock.advance(1000);
    expect(await provider.getToken()).toBe("ya29.token-1");
    expect(calls.length).toBe(2);

    expect(GCS_TOKEN_REFRESH_MARGIN_MS).toBe(60_000);
  });

  test("falls back to ADC authorized_user when the metadata server 404s", async () => {
    const clock = new FakeClock();
    const logger = new InMemoryLogger();
    const adcDoc = JSON.stringify({
      type: "authorized_user",
      client_id: "adc-client-id",
      client_secret: "adc-client-secret",
      refresh_token: "adc-refresh-token",
    });
    const readPaths: string[] = [];
    const { fetchImpl, calls } = createFetchStub((call) => {
      if (call.url.includes("metadata.google.internal")) {
        return new Response("not found", { status: 404 });
      }
      if (call.url === "https://oauth2.googleapis.com/token") {
        return jsonResponse({ access_token: "ya29.adc-user-token-XYZ999", expires_in: 3600 });
      }
      return new Response("unexpected url", { status: 500 });
    });
    const env: Record<string, string | undefined> = {
      GOOGLE_APPLICATION_CREDENTIALS: "/adc/creds.json",
    };
    const provider = new RefreshingGcsTokenProvider(env, {
      clock,
      logger,
      fetchImpl,
      readFile: async (path) => {
        readPaths.push(path);
        return adcDoc;
      },
    });

    const token = await provider.getToken();

    expect(token).toBe("ya29.adc-user-token-XYZ999");
    expect(readPaths).toEqual(["/adc/creds.json"]);
    expect(calls.some((c) => c.url.includes("metadata.google.internal"))).toBe(true);
    const event = tokenSourceEvent(logger);
    expect(event?.["source"]).toBe("adc-authorized-user");
    expectTokenNeverLogged(logger, "ya29.adc-user-token-XYZ999");
    expectTokenNeverLogged(logger, "adc-refresh-token");

    // The ADC token is cached too — no second round of fetches.
    clock.advance(60 * 1000);
    expect(await provider.getToken()).toBe("ya29.adc-user-token-XYZ999");
    expect(calls.length).toBe(2);
  });

  test("falls back to the env token when metadata is unreachable and no ADC file exists", async () => {
    const clock = new FakeClock();
    const logger = new InMemoryLogger();
    const { fetchImpl } = createFetchStub(() => {
      throw new TypeError("fetch failed");
    });
    const env: Record<string, string | undefined> = { GCP_ACCESS_TOKEN: "env-fallback-token-QQQ777" };
    const provider = new RefreshingGcsTokenProvider(env, {
      clock,
      logger,
      fetchImpl,
      readFile: async () => {
        throw new Error("ENOENT: no adc file");
      },
    });

    expect(await provider.getToken()).toBe("env-fallback-token-QQQ777");
    expect(tokenSourceEvent(logger)?.["source"]).toBe("env");
    expectTokenNeverLogged(logger, "env-fallback-token-QQQ777");
  });

  test("re-reads the env token after its synthetic lifetime so rotation propagates", async () => {
    const clock = new FakeClock();
    const { fetchImpl } = createFetchStub(() => {
      throw new TypeError("fetch failed");
    });
    const env: Record<string, string | undefined> = { GCP_ACCESS_TOKEN: "env-token-v1" };
    const provider = new RefreshingGcsTokenProvider(env, {
      clock,
      fetchImpl,
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });

    expect(await provider.getToken()).toBe("env-token-v1");
    env["GCP_ACCESS_TOKEN"] = "env-token-v2";
    // 300s synthetic lifetime - 60s margin = 240s effective cache.
    clock.advance(239 * 1000);
    expect(await provider.getToken()).toBe("env-token-v1");
    clock.advance(2000);
    expect(await provider.getToken()).toBe("env-token-v2");
  });

  test("mints a token from an ADC service_account key", async () => {
    const clock = new FakeClock();
    const logger = new InMemoryLogger();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const adcDoc = JSON.stringify({
      type: "service_account",
      client_email: "test@example.iam.gserviceaccount.com",
      private_key: pem,
    });
    const { fetchImpl, calls } = createFetchStub((call) => {
      if (call.url.includes("metadata.google.internal")) {
        return new Response("forbidden", { status: 403 });
      }
      return jsonResponse({ access_token: "ya29.sa-token-ZZZ555", expires_in: 3600 });
    });
    const provider = new RefreshingGcsTokenProvider(
      { GOOGLE_APPLICATION_CREDENTIALS: "/adc/sa.json" },
      {
        clock,
        logger,
        fetchImpl,
        readFile: async () => adcDoc,
      },
    );

    expect(await provider.getToken()).toBe("ya29.sa-token-ZZZ555");
    expect(tokenSourceEvent(logger)?.["source"]).toBe("adc-service-account");
    const tokenCall = calls.find((c) => c.url === "https://oauth2.googleapis.com/token");
    expect(tokenCall).toBeDefined();
    expectTokenNeverLogged(logger, "ya29.sa-token-ZZZ555");
  });

  test("concurrent calls during one refresh share a single in-flight fetch", async () => {
    const clock = new FakeClock();
    let release!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { fetchImpl, calls } = createFetchStub(() => gate);
    const provider = new RefreshingGcsTokenProvider({}, { clock, fetchImpl });

    const pending = Array.from({ length: 10 }, () => provider.getToken());
    // Let every caller reach the shared in-flight promise before releasing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(1);
    release(jsonResponse(METADATA_TOKEN));

    const tokens = await Promise.all(pending);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBe(METADATA_TOKEN.access_token);
    expect(calls.length).toBe(1);
  });

  test("a failed refresh does not poison the provider — the next call retries", async () => {
    const clock = new FakeClock();
    let failures = 1;
    const { fetchImpl, calls } = createFetchStub(() => {
      if (failures > 0) {
        failures -= 1;
        return new Response("boom", { status: 500 });
      }
      return jsonResponse(METADATA_TOKEN);
    });
    // No ADC file and no env token: the first refresh must surface the error.
    const provider = new RefreshingGcsTokenProvider(
      {},
      {
        clock,
        fetchImpl,
        readFile: async () => {
          throw new Error("ENOENT");
        },
      },
    );

    await expect(provider.getToken()).rejects.toThrow(/no GCS credential source/);
    // The rejected in-flight promise was cleared, so the retry fetches again.
    expect(await provider.getToken()).toBe(METADATA_TOKEN.access_token);
    expect(calls.length).toBe(2);
  });

  test("throws a actionable error when no source is available", async () => {
    const clock = new FakeClock();
    const logger = new InMemoryLogger();
    const { fetchImpl } = createFetchStub(() => new Response("denied", { status: 403 }));
    const provider = new RefreshingGcsTokenProvider(
      {},
      {
        clock,
        logger,
        fetchImpl,
        readFile: async () => {
          throw new Error("ENOENT");
        },
      },
    );

    await expect(provider.getToken()).rejects.toThrow(/no GCS credential source available/);
    const failure = logger.parsed.find((e) => e["event"] === "gcs.auth.no_credential_source");
    expect(failure).toBeDefined();
  });

  test("uses the gcloud well-known ADC path when GOOGLE_APPLICATION_CREDENTIALS is unset", async () => {
    const clock = new FakeClock();
    const readPaths: string[] = [];
    const { fetchImpl } = createFetchStub((call) => {
      if (call.url.includes("metadata.google.internal")) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse({ access_token: "ya29.well-known-WWW123", expires_in: 3600 });
    });
    const provider = new RefreshingGcsTokenProvider(
      { HOME: "/home/dev", GCP_ACCESS_TOKEN: undefined },
      {
        clock,
        fetchImpl,
        readFile: async (path) => {
          readPaths.push(path);
          return JSON.stringify({
            type: "authorized_user",
            client_id: "id",
            client_secret: "secret",
            refresh_token: "rt",
          });
        },
      },
    );

    expect(await provider.getToken()).toBe("ya29.well-known-WWW123");
    expect(readPaths).toEqual(["/home/dev/.config/gcloud/application_default_credentials.json"]);
  });

  test("adcCredentialsPath dep overrides the env/well-known ADC lookup (issue #76)", async () => {
    const clock = new FakeClock();
    const readPaths: string[] = [];
    const { fetchImpl } = createFetchStub((call) => {
      if (call.url.includes("metadata.google.internal")) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse({ access_token: "ya29.override-OOO456", expires_in: 3600 });
    });
    const provider = new RefreshingGcsTokenProvider(
      { HOME: "/home/dev", GOOGLE_APPLICATION_CREDENTIALS: "/env/creds.json" },
      {
        clock,
        fetchImpl,
        adcCredentialsPath: "/dep/creds.json",
        readFile: async (path) => {
          readPaths.push(path);
          return JSON.stringify({
            type: "authorized_user",
            client_id: "id",
            client_secret: "secret",
            refresh_token: "rt",
          });
        },
      },
    );

    expect(await provider.getToken()).toBe("ya29.override-OOO456");
    expect(readPaths).toEqual(["/dep/creds.json"]);
  });
});
