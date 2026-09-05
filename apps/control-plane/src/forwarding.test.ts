// Tests for issue #22 forwarding: ID tokens (invoker IAM) + the
// control-plane -> agent-host HTTP forward.
//
// Conventions: time is driven by an injected mutable clock (never wall
// time), fetch is stubbed, and the InMemoryLogger proves which source was
// used without ever carrying a token.

import { describe, expect, test } from "bun:test";
import { InMemoryLogger } from "@cloud-run-dsh/observability";
import {
  AgentHostConflictError,
  AgentHostForwardError,
  HttpAgentHostForwarder,
  RefreshingIdTokenProvider,
  ID_TOKEN_ENV_VAR,
  ID_TOKEN_REFRESH_MARGIN_MS,
  buildIdTokenUrl,
  parseJwtExpSeconds,
  type ForwardApprovalArgs,
  type ForwardCancelArgs,
  type ForwardCheckpointArgs,
  type ForwardMessageArgs,
  type ForwardPrepareStopArgs,
} from "./forwarding.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** Unsigned JWT with controllable exp/aud (signature is irrelevant here). */
function unsignedJwt(exp: number, aud = "https://x.run.app"): string {
  const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ aud, exp, iss: "test" }));
  return `${header}.${payload}.sig`;
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class MutableClock {
  ms: number;
  constructor(startMs: number) {
    this.ms = startMs;
  }
  nowMs(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

interface RecordedFetch {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  respond: (call: RecordedFetch) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr =
      typeof url === "string" ? url.toString() : url instanceof URL ? url.href : url.url;
    const call: RecordedFetch = { url: urlStr, init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function forwardArgs(overrides: Partial<ForwardMessageArgs> = {}): ForwardMessageArgs {
  return {
    instanceUrl: "https://dsh-ws-1.run.app",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    seq: 0,
    content: "fix the flaky test",
    identity: { id: "alice", email: "alice@example.com" },
    ...overrides,
  };
}

/** Fails the test if any log line contains the raw token. */
function expectTokenNeverLogged(logger: InMemoryLogger, token: string): void {
  for (const line of logger.lines) {
    expect(line.includes(token)).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// RefreshingIdTokenProvider
// ---------------------------------------------------------------------------

describe("RefreshingIdTokenProvider", () => {
  test("requests the audience-scoped identity endpoint with Metadata-Flavor", async () => {
    const clock = new MutableClock(1_000_000_000_000);
    const token = unsignedJwt(Math.floor(clock.nowMs() / 1000) + 3600);
    const { fetchImpl, calls } = stubFetch(() => textResponse(token));
    const provider = new RefreshingIdTokenProvider({}, { clock, fetchImpl });

    await expect(
      provider.getToken("https://dsh-ws-1.run.app"),
    ).resolves.toBe(token);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(buildIdTokenUrl("https://dsh-ws-1.run.app"));
    expect(calls[0]!.url).toContain("audience=https%3A%2F%2Fdsh-ws-1.run.app");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Metadata-Flavor"]).toBe("Google");
  });

  test("caches per audience: same audience hits cache, other audiences re-fetch", async () => {
    const clock = new MutableClock(1_000_000_000_000);
    // The metadata server signs each audience into its token — mint one per URL.
    const { fetchImpl, calls } = stubFetch((call) =>
      textResponse(
        unsignedJwt(
          Math.floor(clock.nowMs() / 1000) + 3600,
          new URL(call.url).searchParams.get("audience") ?? "unknown",
        ),
      ),
    );
    const provider = new RefreshingIdTokenProvider({}, { clock, fetchImpl });

    const a1 = await provider.getToken("https://a.run.app");
    const a1again = await provider.getToken("https://a.run.app");
    const b1 = await provider.getToken("https://b.run.app");
    expect(a1again).toBe(a1);
    expect(b1).not.toBe(a1);
    // one mint per audience
    expect(calls.length).toBe(2);
  });

  test("refetches once the remaining lifetime drops below the 60s margin", async () => {
    const clock = new MutableClock(1_000_000_000_000);
    const { fetchImpl, calls } = stubFetch(() =>
      textResponse(unsignedJwt(Math.floor(clock.nowMs() / 1000) + 3600)),
    );
    const provider = new RefreshingIdTokenProvider({}, { clock, fetchImpl });

    const first = await provider.getToken("https://a.run.app");
    expect(calls.length).toBe(1);
    // 3539s in, 61s of lifetime remain — above the 60s margin, still cached.
    clock.advance((3600 - 61) * 1000);
    expect(await provider.getToken("https://a.run.app")).toBe(first);
    expect(calls.length).toBe(1);
    // 61s later the token is fully expired (hence below the margin): refetch.
    clock.advance(61 * 1000);
    const second = await provider.getToken("https://a.run.app");
    expect(calls.length).toBe(2);
    expect(second).not.toBe(first); // later exp, freshly minted
  });

  test("concurrent callers share one in-flight mint", async () => {
    const clock = new MutableClock(1_000_000_000_000);
    let resolveMint!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveMint = resolve;
    });
    const { fetchImpl, calls } = stubFetch(() => gate);
    const provider = new RefreshingIdTokenProvider({}, { clock, fetchImpl });

    const pending = Promise.all([
      provider.getToken("https://a.run.app"),
      provider.getToken("https://a.run.app"),
      provider.getToken("https://a.run.app"),
    ]);
    await Bun.sleep(10);
    resolveMint(textResponse(unsignedJwt(Math.floor(clock.nowMs() / 1000) + 3600)));
    const [t1, t2, t3] = await pending;
    expect(t1).toBe(t2);
    expect(t2).toBe(t3);
    expect(calls.length).toBe(1);
  });

  test("falls back to GCP_ID_TOKEN when the metadata server is unreachable", async () => {
    const clock = new MutableClock(1_000_000_000_000);
    const logger = new InMemoryLogger();
    const { fetchImpl } = stubFetch(() => {
      throw new Error("fetch failed");
    });
    const provider = new RefreshingIdTokenProvider(
      { [ID_TOKEN_ENV_VAR]: "env-token-abc" },
      { clock, logger, fetchImpl },
    );
    await expect(provider.getToken("https://a.run.app")).resolves.toBe("env-token-abc");
    const sources = logger.parsed
      .filter((e) => e["event"] === "control-plane.auth.id_token_source")
      .map((e) => e["source"]);
    expect(sources).toEqual(["env"]);
  });

  test("no source -> actionable error mentioning GCP_ID_TOKEN", async () => {
    const clock = new MutableClock(1_000_000_000_000);
    const { fetchImpl } = stubFetch(() => {
      throw new Error("fetch failed");
    });
    const provider = new RefreshingIdTokenProvider({}, { clock, fetchImpl });
    await expect(provider.getToken("https://a.run.app")).rejects.toThrow(
      new RegExp(ID_TOKEN_ENV_VAR),
    );
  });

  test("metadata non-200 / empty body -> falls back, never serves garbage", async () => {
    const clock = new MutableClock(1_000_000_000_000);
    for (const respond of [
      () => textResponse("nope", 403),
      () => textResponse("   ", 200),
      () => textResponse("not-a-jwt", 200),
    ]) {
      const { fetchImpl } = stubFetch(respond);
      const provider = new RefreshingIdTokenProvider({}, { clock, fetchImpl });
      await expect(provider.getToken("https://a.run.app")).rejects.toThrow(
        /no ID token source/,
      );
    }
  });

  test("empty audience is rejected before any fetch", async () => {
    const { fetchImpl, calls } = stubFetch(() => textResponse("x"));
    const provider = new RefreshingIdTokenProvider({}, { fetchImpl });
    await expect(provider.getToken("   ")).rejects.toThrow(/audience/);
    expect(calls.length).toBe(0);
  });

  test("tokens are never logged, only the source is", async () => {
    const clock = new MutableClock(1_000_000_000_000);
    const logger = new InMemoryLogger();
    const token = unsignedJwt(Math.floor(clock.nowMs() / 1000) + 3600);
    const { fetchImpl } = stubFetch(() => textResponse(token));
    const provider = new RefreshingIdTokenProvider({}, { clock, logger, fetchImpl });
    await provider.getToken("https://a.run.app");
    expectTokenNeverLogged(logger, token);
    expect(
      logger.parsed.some((e) => e["event"] === "control-plane.auth.id_token_source"),
    ).toBe(true);
  });
});

describe("parseJwtExpSeconds", () => {
  test("reads exp, rejects malformed tokens", () => {
    expect(parseJwtExpSeconds(unsignedJwt(12345))).toBe(12345);
    expect(parseJwtExpSeconds("not-a-jwt")).toBeNull();
    expect(parseJwtExpSeconds("a.b")).toBeNull();
    expect(parseJwtExpSeconds(`${base64url("{}")}.${base64url("{}")}.s`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HttpAgentHostForwarder
// ---------------------------------------------------------------------------

describe("HttpAgentHostForwarder", () => {
  function successSetup(
    body: unknown = { accepted: true, turnStarted: true },
    status = 202,
  ): {
    calls: { url: string; init: RequestInit | undefined }[];
    forwarder: HttpAgentHostForwarder;
    seenAudiences: string[];
  } {
    const seenAudiences: string[] = [];
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const forwarder = new HttpAgentHostForwarder({
      idTokenProvider: async (aud) => {
        seenAudiences.push(aud);
        return "id-token-123";
      },
      fetchFn: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(body, status);
      }) as (url: string, init?: RequestInit) => Promise<Response>,
    });
    return { calls, forwarder, seenAudiences };
  }

  test("POSTs to the instance gateway path with ID token + caller identity", async () => {
    const { calls, forwarder, seenAudiences } = successSetup();
    const result = await forwarder.forward(forwardArgs({ seq: 7 }));
    expect(result).toEqual({ status: 202, turnStarted: true });

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://dsh-ws-1.run.app/workspaces/ws-1/sessions/sess-1/messages",
    );
    const init = calls[0]!.init!;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer id-token-123");
    expect(headers["x-goog-authenticated-user-email"]).toBe("alice@example.com");
    expect(headers["x-goog-authenticated-user-id"]).toBe("accounts.google.com:alice");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      workspaceId: "ws-1",
      sessionId: "sess-1",
      seq: 7,
      content: "fix the flaky test",
    });
    // Audience is the instance origin (no trailing slash).
    expect(seenAudiences).toEqual(["https://dsh-ws-1.run.app"]);
  });

  test("trailing-slash instance URLs do not leak into the audience", async () => {
    const { forwarder, seenAudiences } = successSetup();
    await forwarder.forward(forwardArgs({ instanceUrl: "https://dsh-ws-1.run.app/" }));
    expect(seenAudiences).toEqual(["https://dsh-ws-1.run.app"]);
  });

  test("agent-host 409/403 propagate as AgentHostConflictError (not forward failure)", async () => {
    for (const status of [409, 403]) {
      const { forwarder } = successSetup({ error: "lease not held" }, status);
      const err = await forwarder.forward(forwardArgs()).catch((e) => e);
      expect(err).toBeInstanceOf(AgentHostConflictError);
      expect(String(err.message)).toContain(String(status));
    }
  });

  test("agent-host 5xx -> AgentHostForwardError (never success)", async () => {
    const { forwarder } = successSetup({ error: "boom" }, 500);
    await expect(forwarder.forward(forwardArgs())).rejects.toBeInstanceOf(
      AgentHostForwardError,
    );
  });

  test("202 with turnStarted:false -> AgentHostForwardError (turn did not start)", async () => {
    const { forwarder } = successSetup({ accepted: true, turnStarted: false });
    const err = await forwarder.forward(forwardArgs()).catch((e) => e);
    expect(err).toBeInstanceOf(AgentHostForwardError);
    expect(String(err.message)).toContain("turnStarted:false");
  });

  test("unreachable instance -> AgentHostForwardError naming the base URL", async () => {
    const forwarder = new HttpAgentHostForwarder({
      idTokenProvider: async () => "tok",
      fetchFn: (async () => {
        throw new Error("connection refused");
      }) as (url: string, init?: RequestInit) => Promise<Response>,
    });
    const err = await forwarder.forward(forwardArgs()).catch((e) => e);
    expect(err).toBeInstanceOf(AgentHostForwardError);
    expect(String(err.message)).toContain("https://dsh-ws-1.run.app");
  });

  test("ID token mint failure -> AgentHostForwardError (no unauthenticated forward)", async () => {
    const seen: string[] = [];
    const forwarder = new HttpAgentHostForwarder({
      idTokenProvider: async () => {
        throw new Error("no ID token source available");
      },
      fetchFn: (async (url: string) => {
        seen.push(url);
        return jsonResponse({});
      }) as (url: string, init?: RequestInit) => Promise<Response>,
    });
    await expect(forwarder.forward(forwardArgs())).rejects.toBeInstanceOf(
      AgentHostForwardError,
    );
    expect(seen).toEqual([]);
  });

  test("forward timeout aborts instead of parking on a dead instance", async () => {
    const forwarder = new HttpAgentHostForwarder({
      idTokenProvider: async () => "tok",
      fetchFn: (((url: string, init?: RequestInit) => {
        // Hang until the abort signal fires, then behave like fetch.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }) as unknown) as (url: string, init?: RequestInit) => Promise<Response>,
      timeoutMs: 20,
    });
    const err = await forwarder.forward(forwardArgs()).catch((e) => e);
    expect(err).toBeInstanceOf(AgentHostForwardError);
    expect(String(err.message)).toContain("timed out");
  });

  test("delivery is logged without secrets (no token, no content)", async () => {
    const logger = new InMemoryLogger();
    const forwarder = new HttpAgentHostForwarder({
      idTokenProvider: async () => "id-token-123",
      fetchFn: (async () => jsonResponse({ turnStarted: true })) as (
        url: string,
        init?: RequestInit,
      ) => Promise<Response>,
      logger,
    });
    await forwarder.forward(forwardArgs());
    const delivered = logger.parsed.find((e) => e["event"] === "control-plane.forward.delivered");
    expect(delivered).toBeTruthy();
    expect(delivered!["seq"]).toBe(0);
    for (const line of logger.lines) {
      expect(line.includes("id-token-123")).toBe(false);
      expect(line.includes("fix the flaky test")).toBe(false);
    }
  });

  test("refresh-margin constant matches the #27 access-token shape (60s)", () => {
    expect(ID_TOKEN_REFRESH_MARGIN_MS).toBe(60_000);
  });
});

describe("HttpAgentHostForwarder approval/cancel (issue #39)", () => {
  function approvalSetup(
    body: unknown = { accepted: true },
    status = 202,
  ): {
    calls: { url: string; init: RequestInit | undefined }[];
    forwarder: HttpAgentHostForwarder;
    seenAudiences: string[];
  } {
    const seenAudiences: string[] = [];
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const forwarder = new HttpAgentHostForwarder({
      idTokenProvider: async (aud) => {
        seenAudiences.push(aud);
        return "id-token-123";
      },
      fetchFn: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(body, status);
      }) as (url: string, init?: RequestInit) => Promise<Response>,
    });
    return { calls, forwarder, seenAudiences };
  }

  const approvalArgs = (overrides: Partial<ForwardApprovalArgs> = {}): ForwardApprovalArgs => ({
    instanceUrl: "https://dsh-ws-1.run.app",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    approvalId: "ask-1",
    decision: "rejected",
    identity: { id: "alice", email: "alice@example.com" },
    ...overrides,
  });

  const cancelArgs = (overrides: Partial<ForwardCancelArgs> = {}): ForwardCancelArgs => ({
    instanceUrl: "https://dsh-ws-1.run.app",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    identity: { id: "alice", email: "alice@example.com" },
    ...overrides,
  });

  test("forwardApproval POSTs to the session approvals path with id + decision", async () => {
    const { calls, forwarder, seenAudiences } = approvalSetup();
    const result = await forwarder.forwardApproval(approvalArgs());
    expect(result).toEqual({ status: 202, turnStarted: true });

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://dsh-ws-1.run.app/workspaces/ws-1/sessions/sess-1/approvals",
    );
    const init = calls[0]!.init!;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer id-token-123");
    expect(headers["x-goog-authenticated-user-email"]).toBe("alice@example.com");
    expect(headers["x-goog-authenticated-user-id"]).toBe("accounts.google.com:alice");
    expect(JSON.parse(init.body as string)).toEqual({
      approvalId: "ask-1",
      decision: "rejected",
    });
    expect(seenAudiences).toEqual(["https://dsh-ws-1.run.app"]);
  });

  test("forwardCancel POSTs to the session cancel path", async () => {
    const { calls, forwarder } = approvalSetup({ accepted: true });
    const result = await forwarder.forwardCancel(cancelArgs());
    expect(result).toEqual({ status: 202, turnStarted: true });

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://dsh-ws-1.run.app/workspaces/ws-1/sessions/sess-1/cancel",
    );
    const init = calls[0]!.init!;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer id-token-123");
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: "sess-1" });
  });

  test("approval/cancel share the message contract: 409/403 -> conflict, 5xx/unreachable -> forward error", async () => {
    for (const status of [409, 403]) {
      const { forwarder } = approvalSetup({ error: "lease not held" }, status);
      await expect(forwarder.forwardApproval(approvalArgs())).rejects.toBeInstanceOf(
        AgentHostConflictError,
      );
      const { forwarder: cancelForwarder } = approvalSetup({ error: "nope" }, status);
      await expect(cancelForwarder.forwardCancel(cancelArgs())).rejects.toBeInstanceOf(
        AgentHostConflictError,
      );
    }
    const { forwarder: fiveHundred } = approvalSetup({ error: "boom" }, 500);
    await expect(fiveHundred.forwardApproval(approvalArgs())).rejects.toBeInstanceOf(
      AgentHostForwardError,
    );
    const unreachable = new HttpAgentHostForwarder({
      idTokenProvider: async () => "tok",
      fetchFn: (async () => {
        throw new Error("connection refused");
      }) as (url: string, init?: RequestInit) => Promise<Response>,
    });
    const err = await unreachable.forwardCancel(cancelArgs()).catch((e) => e);
    expect(err).toBeInstanceOf(AgentHostForwardError);
    expect(String(err.message)).toContain("https://dsh-ws-1.run.app");
  });
});

describe("HttpAgentHostForwarder lifecycle forwards (issues #72/#75)", () => {
  const prepareArgs = (overrides: Partial<ForwardPrepareStopArgs> = {}): ForwardPrepareStopArgs => ({
    instanceUrl: "https://dsh-ws-1.run.app",
    workspaceId: "ws-1",
    identity: { id: "alice", email: "alice@example.com" },
    ...overrides,
  });

  const checkpointArgs = (overrides: Partial<ForwardCheckpointArgs> = {}): ForwardCheckpointArgs => ({
    instanceUrl: "https://dsh-ws-1.run.app",
    workspaceId: "ws-1",
    identity: { id: "alice", email: "alice@example.com" },
    ...overrides,
  });

  function lifecycleSetup(body: unknown = {}, status = 200): {
    calls: { url: string; init: RequestInit | undefined }[];
    forwarder: HttpAgentHostForwarder;
  } {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const forwarder = new HttpAgentHostForwarder({
      idTokenProvider: async () => "id-token-123",
      fetchFn: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(body, status);
      }) as (url: string, init?: RequestInit) => Promise<Response>,
    });
    return { calls, forwarder };
  }

  test("forwardPrepareStop POSTs to the prepare-stop path with the caller identity headers", async () => {
    const { calls, forwarder } = lifecycleSetup({ prepared: true, state: "STOPPING" });
    const result = await forwarder.forwardPrepareStop(prepareArgs());
    expect(result).toEqual({ status: 200, prepared: true, state: "STOPPING" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://dsh-ws-1.run.app/workspaces/ws-1/prepare-stop");
    const init = calls[0]!.init!;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer id-token-123");
    expect(headers["x-goog-authenticated-user-email"]).toBe("alice@example.com");
    expect(headers["x-goog-authenticated-user-id"]).toBe("accounts.google.com:alice");
  });

  test("forwardCheckpoint POSTs to the checkpoint path and reports the host skip flag", async () => {
    const { calls, forwarder } = lifecycleSetup({
      checkpointed: true,
      skipped: true,
      state: "READY",
    });
    const result = await forwarder.forwardCheckpoint(checkpointArgs());
    expect(result).toEqual({
      status: 200,
      checkpointed: true,
      skipped: true,
      state: "READY",
    });
    expect(calls[0]!.url).toBe("https://dsh-ws-1.run.app/workspaces/ws-1/checkpoint");
  });

  test("a 200 claiming prepared:false / checkpointed:false still rejects (never fake success)", async () => {
    const { forwarder: lyingPrepare } = lifecycleSetup({ prepared: false, state: "STOPPING" });
    await expect(lyingPrepare.forwardPrepareStop(prepareArgs())).rejects.toBeInstanceOf(
      AgentHostForwardError,
    );
    const { forwarder: lyingCheckpoint } = lifecycleSetup({ checkpointed: false });
    await expect(lyingCheckpoint.forwardCheckpoint(checkpointArgs())).rejects.toBeInstanceOf(
      AgentHostForwardError,
    );
  });

  test("lifecycle forwards share the message contract: 409/403 -> conflict, 5xx/unreachable -> forward error", async () => {
    for (const status of [409, 403]) {
      const { forwarder } = lifecycleSetup({ error: "lease not held" }, status);
      await expect(forwarder.forwardPrepareStop(prepareArgs())).rejects.toBeInstanceOf(
        AgentHostConflictError,
      );
      const { forwarder: checkpointForwarder } = lifecycleSetup({ error: "nope" }, status);
      await expect(
        checkpointForwarder.forwardCheckpoint(checkpointArgs()),
      ).rejects.toBeInstanceOf(AgentHostConflictError);
    }
    const { forwarder: fiveHundred } = lifecycleSetup({ error: "boom" }, 500);
    await expect(fiveHundred.forwardPrepareStop(prepareArgs())).rejects.toBeInstanceOf(
      AgentHostForwardError,
    );
    const unreachable = new HttpAgentHostForwarder({
      idTokenProvider: async () => "tok",
      fetchFn: (async () => {
        throw new Error("connection refused");
      }) as (url: string, init?: RequestInit) => Promise<Response>,
    });
    await expect(unreachable.forwardCheckpoint(checkpointArgs())).rejects.toBeInstanceOf(
      AgentHostForwardError,
    );
  });
});

describe("HttpAgentHostForwarder delivery logging", () => {
  // NOTE: approvalSetup/approvalArgs/cancelArgs live in the issue-#39
  // describe above (closure-scoped), so this block re-declares the two
  // tiny arg builders it needs instead of reaching across describes.
  const approvalArgs = (overrides: Partial<ForwardApprovalArgs> = {}): ForwardApprovalArgs => ({
    instanceUrl: "https://dsh-ws-1.run.app",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    approvalId: "ask-1",
    decision: "rejected",
    identity: { id: "alice", email: "alice@example.com" },
    ...overrides,
  });

  const cancelArgs = (overrides: Partial<ForwardCancelArgs> = {}): ForwardCancelArgs => ({
    instanceUrl: "https://dsh-ws-1.run.app",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    identity: { id: "alice", email: "alice@example.com" },
    ...overrides,
  });

  test("approval/cancel delivery is logged with kind, without secrets", async () => {
    const logger = new InMemoryLogger();
    const forwarder = new HttpAgentHostForwarder({
      idTokenProvider: async () => "id-token-123",
      fetchFn: (async () => jsonResponse({ accepted: true })) as (
        url: string,
        init?: RequestInit,
      ) => Promise<Response>,
      logger,
    });
    await forwarder.forwardApproval(approvalArgs());
    await forwarder.forwardCancel(cancelArgs());
    const kinds = logger.parsed
      .filter((e) => e["event"] === "control-plane.forward.delivered")
      .map((e) => e["kind"]);
    expect(kinds).toEqual(["approval", "cancel"]);
    for (const line of logger.lines) {
      expect(line.includes("id-token-123")).toBe(false);
    }
  });
});
