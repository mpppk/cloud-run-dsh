/**
 * Issue #155 production E2E verification (public control plane).
 *
 * Exercises the #155 acceptance list against a REAL deployment WITHOUT
 * deploying anything: all state lives server-side, created resources are
 * deleted in a finally block, and secrets/sessions travel via environment
 * ONLY (never argv, never logs — see redact()).
 *
 * Required env:
 *   APP_ORIGIN   public control-plane origin, e.g. https://dsh-control-abc.run.app
 *   DSH_SESSION  raw __Host-dsh_session value (paste from a logged-in browser;
 *                DevTools → Application → Cookies). Proves the GitHub-login leg
 *                out-of-band; this tool never handles OAuth credentials.
 * Optional env:
 *   E2E_ORIGIN        Origin header for same-origin mutations (default: APP_ORIGIN)
 *   E2E_REPO_OWNER    workspace repo owner for create (default: mpppk)
 *   E2E_REPO_NAME     workspace repo name for create (default: demo)
 *   E2E_TIMEOUT_MS    READY poll budget in ms (default: 600000)
 *   E2E_REQUEST_MS    per-request timeout in ms (default: 30000)
 *   AGENT_HOST_URL    workspace Instance base URL (optional): when set, the
 *                     tool asserts anonymous requests are denied (401/403),
 *                     proving the agent-host asymmetry.
 *
 * Exit 0 when every applicable check passes, 1 otherwise. The session value
 * is never printed (redact() covers check details).
 *
 * NOTE: dry-running against the local dev server fails the anonymous checks
 * by design — dev auto-login replaces missing/invalid cookies with a fresh
 * dev session (production has no auto-login, so the same checks 401/403
 * there). Run the real thing against the deployed public origin.
 *
 * Run: APP_ORIGIN=… DSH_SESSION=… bun run scripts/verify-issue155-e2e.ts
 */

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Masks anything that looks like the session value or a token in log lines. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export function checkResult(name: string, ok: boolean, detail: string): CheckResult {
  return { name, ok, detail };
}

export function formatReport(results: readonly CheckResult[]): string {
  const passed = results.filter((r) => r.ok).length;
  const lines = results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name} — ${r.detail}`);
  return [...lines, `summary: ${passed}/${results.length} checks passed`].join("\n");
}

/** Cookie header carrying the operator session (name pinned to the app contract). */
export function sessionCookieHeader(session: string): Record<string, string> {
  return { cookie: `__Host-dsh_session=${session}` };
}

interface Ctx {
  origin: string;
  sameOrigin: string;
  session: string;
  repoOwner: string;
  repoName: string;
  requestMs: number;
  readyMs: number;
  agentHostUrl: string | null;
  secrets: string[];
}

async function request(
  ctx: Ctx,
  method: string,
  path: string,
  init: { body?: unknown; origin?: string | null; cookie?: boolean; rawCookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (init.origin !== undefined) {
    if (init.origin !== null) headers["origin"] = init.origin;
  }
  if (init.cookie !== false) {
    Object.assign(headers, sessionCookieHeader(init.rawCookie ?? ctx.session));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.requestMs);
  try {
    return await fetch(`${ctx.origin}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function readFirstSseEvent(ctx: Ctx, path: string): Promise<{ status: number; event: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(ctx.requestMs, 30_000));
  try {
    const res = await fetch(`${ctx.origin}${path}`, {
      headers: sessionCookieHeader(ctx.session),
      signal: controller.signal,
    });
    if (res.status !== 200 || !res.body) return { status: res.status, event: null };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = /(?:^|\n)event: ([^\n]+)/.exec(buffer);
      if (match) {
        await reader.cancel().catch(() => undefined);
        return { status: 200, event: match[1] };
      }
      if (buffer.length > 64_000) break;
    }
    await reader.cancel().catch(() => undefined);
    return { status: 200, event: null };
  } catch {
    return { status: -1, event: null };
  } finally {
    clearTimeout(timer);
  }
}

async function pollReady(
  ctx: Ctx,
  workspaceId: string,
): Promise<{ ready: boolean; state: string }> {
  const deadline = Date.now() + ctx.readyMs;
  let state = "";
  for (;;) {
    const res = await request(ctx, "GET", `/v1/workspaces/${workspaceId}`, { origin: null });
    if (res.status === 200) {
      state = String(((await safeJson(res)) as { runtimeState?: string } | null)?.runtimeState ?? "");
      if (state === "READY" || state === "RESTORE_FAILED" || state === "ERROR") return { ready: state === "READY", state };
    }
    if (Date.now() > deadline) return { ready: false, state: state || "timeout" };
    await Bun.sleep(10_000);
  }
}

export async function verifyE2E(ctx: Ctx): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const push = (name: string, ok: boolean, detail: string): void => {
    results.push(checkResult(name, ok, redact(detail, ctx.secrets)));
  };

  // 1. Public surface: HTML + login reachable anonymously.
  const html = await request(ctx, "GET", "/", { cookie: false });
  push(
    "public-html",
    html.status === 200 && (html.headers.get("content-type") ?? "").includes("text/html"),
    `GET / -> ${html.status}`,
  );
  const login = await request(ctx, "GET", "/auth/login", { cookie: false });
  const loginLoc = login.headers.get("location") ?? "";
  push(
    "public-login-redirect",
    login.status === 302 && loginLoc.includes("github.com/login/oauth/authorize"),
    `GET /auth/login -> ${login.status} (${login.status === 503 ? "OAuth unconfigured — rollout incomplete" : "redirects to GitHub"})`,
  );

  // 2. Anonymous API denial.
  const anonGet = await request(ctx, "GET", "/v1/workspaces", { cookie: false });
  push("anonymous-v1-401", anonGet.status === 401, `GET /v1/workspaces -> ${anonGet.status}`);
  const anonPost = await request(
    ctx,
    "POST",
    "/v1/workspaces",
    { body: { repositoryOwner: ctx.repoOwner, repositoryName: ctx.repoName }, cookie: false },
  );
  push("anonymous-post-401", anonPost.status === 401, `POST /v1/workspaces -> ${anonPost.status}`);

  // 3. Foreign-origin mutation refused (with a VALID session + origin).
  const forged = await request(
    ctx,
    "POST",
    "/v1/workspaces",
    {
      body: { repositoryOwner: ctx.repoOwner, repositoryName: ctx.repoName },
      origin: "https://evil.example",
    },
  );
  push("foreign-origin-403", forged.status === 403, `cross-origin POST -> ${forged.status}`);

  // 4. Authenticated lifecycle. Everything below runs inside try/finally so
  // the workspace is deleted even when a later step fails.
  const me = await request(ctx, "GET", "/auth/session", { origin: null });
  const principal = (await safeJson(me)) as { user?: { id?: string } } | null;
  push(
    "session-principal",
    me.status === 200 && typeof principal?.user?.id === "string",
    `GET /auth/session -> ${me.status} id=${principal?.user?.id ?? "none"}`,
  );

  let workspaceId: string | null = null;
  try {
    const created = await request(
      ctx,
      "POST",
      "/v1/workspaces",
      {
        body: { repositoryOwner: ctx.repoOwner, repositoryName: ctx.repoName },
        origin: ctx.sameOrigin,
      },
    );
    const createdBody = (await safeJson(created)) as { id?: string } | null;
    workspaceId = typeof createdBody?.id === "string" ? createdBody.id : null;
    push(
      "workspace-create",
      created.status === 201 && workspaceId !== null,
      `POST /v1/workspaces -> ${created.status}`,
    );
    if (!workspaceId) return results;

    const opened = await request(ctx, "POST", `/v1/workspaces/${workspaceId}/open`, {
      body: {},
      origin: ctx.sameOrigin,
    });
    push(
      "workspace-open",
      opened.status === 202 || opened.status === 200,
      `POST open -> ${opened.status}`,
    );

    const { ready, state } = await pollReady(ctx, workspaceId);
    push("workspace-ready", ready, `polled runtimeState=${state}`);

    const sessRes = await request(ctx, "POST", `/v1/workspaces/${workspaceId}/sessions`, {
      body: {},
      origin: ctx.sameOrigin,
    });
    const sessBody = (await safeJson(sessRes)) as { id?: string } | null;
    const sessionId = typeof sessBody?.id === "string" ? sessBody.id : null;
    push("session-create", sessRes.status === 201 && sessionId !== null, `POST sessions -> ${sessRes.status}`);
    if (!sessionId) return results;

    const acquired = await request(ctx, "POST", `/v1/workspaces/${workspaceId}/controller/acquire`, {
      body: {},
      origin: ctx.sameOrigin,
    });
    // 200 = lease taken; 409 = already held — open() establishes the lease
    // for the opener, so a conflict here still leaves message-send gated
    // correctly (the send below is the real proof).
    push(
      "controller-acquire",
      acquired.status === 200 || acquired.status === 409,
      `POST acquire -> ${acquired.status}`,
    );

    const messaged = await request(ctx, "POST", `/v1/sessions/${sessionId}/messages`, {
      body: { content: "e2e smoke: reply with pong" },
      origin: ctx.sameOrigin,
    });
    push("message-send", messaged.status === 201, `POST messages -> ${messaged.status}`);

    const sse = await readFirstSseEvent(ctx, `/v1/sessions/${sessionId}/events?seq=0`);
    push(
      "sse-stream",
      sse.status === 200 && sse.event !== null,
      `GET events -> ${sse.status} first=${sse.event ?? "none"}`,
    );

    const checkpointed = await request(ctx, "POST", `/v1/workspaces/${workspaceId}/checkpoints`, {
      body: {},
      origin: ctx.sameOrigin,
    });
    push(
      "manual-checkpoint",
      checkpointed.status === 200,
      `POST checkpoints -> ${checkpointed.status}`,
    );

    const stopped = await request(ctx, "POST", `/v1/workspaces/${workspaceId}/stop`, {
      body: {},
      origin: ctx.sameOrigin,
    });
    push("workspace-stop", stopped.status === 200, `POST stop -> ${stopped.status}`);
  } finally {
    if (workspaceId) {
      const deleted = await request(ctx, "DELETE", `/v1/workspaces/${workspaceId}`, {
        origin: ctx.sameOrigin,
      });
      push("cleanup-delete-workspace", deleted.status === 200, `DELETE workspace -> ${deleted.status}`);
    }
  }

  // 5. Logout revokes the session (last: nothing else needs it).
  const logout = await request(ctx, "POST", "/auth/logout", { body: {}, origin: ctx.sameOrigin });
  const loggedOut = logout.status === 200;
  const afterLogout = await request(ctx, "GET", "/v1/workspaces", { origin: null });
  push(
    "logout-revokes",
    loggedOut && afterLogout.status === 401,
    `POST logout -> ${logout.status}, reuse -> ${afterLogout.status}`,
  );

  // 6. Agent-host asymmetry: anonymous requests to the Instance must be denied.
  if (ctx.agentHostUrl) {
    let status = -1;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ctx.requestMs);
      try {
        const res = await fetch(`${ctx.agentHostUrl.replace(/\/$/, "")}/readyz`, {
          redirect: "manual",
          signal: controller.signal,
        });
        status = res.status;
        await res.body?.cancel().catch(() => undefined);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      status = -1;
    }
    push(
      "agent-host-anonymous-denial",
      status === 401 || status === 403,
      `GET agent-host /readyz -> ${status} (want 401/403, never 200)`,
    );
  } else {
    push("agent-host-anonymous-denial", true, "skipped (AGENT_HOST_URL unset)");
  }

  return results;
}

function readEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

async function main(): Promise<void> {
  const origin = readEnv("APP_ORIGIN").replace(/\/$/, "");
  const session = readEnv("DSH_SESSION");
  if (!origin || !session) {
    console.error("APP_ORIGIN and DSH_SESSION are required (session via env only, never argv).");
    process.exit(2);
  }
  const ctx: Ctx = {
    origin,
    sameOrigin: readEnv("E2E_ORIGIN", origin),
    session,
    repoOwner: readEnv("E2E_REPO_OWNER", "mpppk"),
    repoName: readEnv("E2E_REPO_NAME", "demo"),
    requestMs: Number(readEnv("E2E_REQUEST_MS", "30000")),
    readyMs: Number(readEnv("E2E_TIMEOUT_MS", "600000")),
    agentHostUrl: readEnv("AGENT_HOST_URL") || null,
    secrets: [session],
  };
  const results = await verifyE2E(ctx);
  console.log(formatReport(results));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
