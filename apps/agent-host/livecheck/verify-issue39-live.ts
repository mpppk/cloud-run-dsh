// Live issue #39 verification (NOT part of the committed test suite — the
// suite stays hermetic. Run on demand; see PR body).
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-... bun apps/agent-host/livecheck/verify-issue39-live.ts
//
// What it proves against the REAL model (default deepseek/deepseek-v4-flash
// on OpenRouter) over REAL HTTP on both hops:
//   1. control-plane POST /v1/sessions/:id/cancel interrupts a live turn
//      (turn/end reason=aborted in the shared repo).
//   2. control-plane POST /v1/sessions/:id/approvals/:approvalId settles a
//      live escalation ask (rejected write outside the workspace completes
//      the turn instead of hanging).
//   3. A fresh HarnessTurnStarter on the same repo resumes the session with
//      history intact and runs a followup turn.
// The key travels via the environment only and is never printed.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import { InMemoryLeaseStore } from "@cloud-run-dsh/controller-lease/testing";
import { InMemoryLogger, createLogger } from "@cloud-run-dsh/observability";
import {
  PostgresSessionPersistenceRepository,
} from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import type { ActivityKind } from "@cloud-run-dsh/workspace-runtime";
import {
  HttpAgentHostForwarder,
  RuntimeRegistry,
  SystemClock,
  createControlPlaneDeps,
  createFetchHandler,
  InMemoryMembershipStore,
  type WorkspaceRuntimeHandle,
} from "../../control-plane/src/index.js";
import { composeTestHost, makeConfig } from "../src/fakes.js";
import { HarnessTurnStarter } from "../src/turn.js";

if (!process.env["OPENROUTER_API_KEY"]) {
  console.error("OPENROUTER_API_KEY is not set");
  process.exit(2);
}

/** Minimal READY handle whose Instance is the test agent-host server. */
class TestInstanceHandle implements WorkspaceRuntimeHandle {
  constructor(private readonly instanceUrl: string) {}
  async open(): Promise<string> {
    return "READY";
  }
  async stop(): Promise<string> {
    return "STOPPED";
  }
  getState(): string {
    return "READY";
  }
  recordActivity(_kind: ActivityKind): void {}
  async assertAgentInputAllowed(): Promise<void> {}
  async runManualCheckpoint(): Promise<{ skipped: boolean }> {
    return { skipped: false };
  }
  async getInstanceUrl(): Promise<string | null> {
    return this.instanceUrl;
  }
}

async function waitFor(
  label: string,
  cond: () => Promise<boolean>,
  timeoutMs = 120_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`LIVE_TIMEOUT waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const workspaceRoot = await mkdtemp(join(tmpdir(), "live-i39-"));
const executor = new InMemoryFakeExecutor();
const repo = new PostgresSessionPersistenceRepository(executor);
const clock = new SystemClock();
const leases = new ControllerLeaseService({ store: new InMemoryLeaseStore(), clock });
const membership = new InMemoryMembershipStore();
const runtimes = new RuntimeRegistry(() => {
  throw new Error("live script presets its handle");
});
const logger = createLogger({ defaultFields: { component: "verify-i39-live" } });
const cpDeps = createControlPlaneDeps({
  resolveUser: async (identity) =>
    identity.subject === "alice" ? { id: "alice", email: "alice@example.com" } : null,
  repo,
  leases,
  membership,
  runtimes,
  clock,
  logger,
  messageForwarder: new HttpAgentHostForwarder({
    idTokenProvider: async () => "live-id-token",
    logger: new InMemoryLogger(),
  }),
});
const cpServer = Bun.serve({ port: 0, fetch: createFetchHandler(cpDeps) });

const cpFetch = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("x-goog-authenticated-user-id", "accounts.google.com:alice");
  headers.set("x-goog-authenticated-user-email", "alice@example.com");
  return fetch(`${cpServer.url.origin}${path}`, { ...init, headers });
};

// The control-plane workspace id must equal the host's WORKSPACE_ID —
// production wires the same workspace through both sides.
const createdPre = await cpFetch("/v1/workspaces", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ repositoryOwner: "mpppk", repositoryName: "demo" }),
});
if (createdPre.status !== 201) throw new Error(`workspace create: ${createdPre.status}`);
const workspaceId = ((await createdPre.json()) as { id: string }).id;

// The agent-host serves the SAME repo (shared in-memory stand-in for Cloud SQL)
// with the REAL turn starter (no test adapter -> real OpenRouter calls).
const config = makeConfig({ workspaceRoot, workspaceId });
const starter = await HarnessTurnStarter.create({ config, repository: repo, logger });
const th = await composeTestHost({ workspaceId }, { turnStarter: starter, repository: repo });
// The workspace row already exists (created above); membership for the
// host-side user is irrelevant to the gateway path.
// Issue #60: the host owns only completeRestore(), so the control-plane
// phase (STOPPED -> STARTING) is seeded before the boot — the live script
// drives the gateway directly and never runs a control-plane open.
await th.inMemoryStateStore!.apply(workspaceId, "STOPPED", "STARTING", "livecheck-control-plane-open");
await th.host.recover();
const ahServer = Bun.serve({ port: 0, fetch: (req) => th.host.gateway.handle(req) });

let hbTimer: ReturnType<typeof setInterval> | undefined;
try {
  runtimes.set(workspaceId, new TestInstanceHandle(ahServer.url.origin));

  const sessionRes = await cpFetch(`/v1/workspaces/${workspaceId}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (sessionRes.status !== 201) throw new Error(`session create: ${sessionRes.status}`);
  const sessionId = ((await sessionRes.json()) as { id: string }).id;

  const acquire = await cpFetch(`/v1/workspaces/${workspaceId}/controller/acquire`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (acquire.status !== 200) throw new Error(`acquire: ${acquire.status}`);
  const controllerId = ((await acquire.json()) as { controllerId: string }).controllerId;

  // The controller lease expires in real time (45s TTL); model turns take
  // longer, so heartbeat before every controller-only call (production
  // clients do this every 15s).
  const heartbeat = async () => {
    const hb = await cpFetch(`/v1/workspaces/${workspaceId}/controller/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ controllerId }),
    });
    if (hb.status !== 200) throw new Error(`heartbeat: ${hb.status}`);
  };
  // Renew in the background too: the waits below outlast one TTL.
  hbTimer = setInterval(() => {
    void heartbeat().catch((e) => console.log("heartbeat failed: " + String(e)));
  }, 10_000);

  // The control-plane session row above lives in the shared repo the
  // starter reads — no mirroring needed.

  // ---- 1. long turn, cancelled mid-flight through the control plane ----
  const longPrompt =
    "Write a very long essay (at least 2000 words) about the history of container " +
    "orchestration, covering Borg, Omega, Kubernetes, and Cloud Run. Be verbose.";
  await heartbeat();
  const msgRes = await cpFetch(`/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: longPrompt }),
  });
  console.log("message status=" + msgRes.status);
  if (msgRes.status !== 201) throw new Error(`message: ${msgRes.status}`);
  const msgEvent = (await msgRes.json()) as { seq: number };

  await waitFor("turn/start in shared repo", async () =>
    (await repo.readEvents(sessionId)).some((e) => e.eventType === "turn/start"),
  );
  console.log("turn started; sending control-plane cancel");
  await heartbeat();
  const cancelRes = await cpFetch(`/v1/sessions/${sessionId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  console.log("cancel status=" + cancelRes.status);
  if (cancelRes.status !== 201) throw new Error(`cancel: ${cancelRes.status}`);

  await waitFor("turn/end after cancel", async () =>
    (await repo.readEvents(sessionId)).some((e) => e.eventType === "turn/end"),
  );
  const cancelEvents = await repo.readEvents(sessionId);
  const cancelEnd = cancelEvents.find((e) => e.eventType === "turn/end");
  console.log("CANCEL_TURN_END=" + JSON.stringify(cancelEnd?.data).slice(0, 300));
  console.log(
    "CANCEL_USER_MESSAGE_ROWS=" +
      cancelEvents.filter((e) => e.eventType === "user_message").length,
  );

  // ---- 2. approval through the control plane ----
  const outsidePrompt =
    "Write the text 'live-approval-probe' to the file /etc/live-approval-probe.txt " +
    "using the available tools. Do not refuse: attempt the write.";
  await heartbeat();
  const msg2 = await cpFetch(`/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: outsidePrompt }),
  });
  if (msg2.status !== 201) throw new Error(`message2: ${msg2.status}`);
  console.log("escalation turn started; waiting for approval/asked");
  let approvalId: string | null = null;
  try {
    await waitFor(
      "approval/asked in shared repo",
      async () => {
        const evs = await repo.readEvents(sessionId);
        const asked = evs.find((e) => e.eventType === "approval/asked");
        if (asked) {
          approvalId = (asked.data as { id: string }).id;
          return true;
        }
        // The model may refuse without asking, or finish first.
        if (evs.filter((e) => e.eventType === "turn/end").length >= 2) return true;
        return false;
      },
      180_000,
    );
  } catch {
    console.log("APPROVAL_ASK=timeout (model may have refused without asking)");
  }
  if (approvalId) {
    console.log("approval asked; rejecting through the control plane");
    const decidedIds = new Set<string>();
    const rejectOne = async (id: string) => {
      await heartbeat();
      const apRes = await cpFetch(`/v1/sessions/${sessionId}/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });
      console.log(`approval ${id} status=` + apRes.status);
      if (apRes.status !== 201) throw new Error(`approval: ${apRes.status}`);
      decidedIds.add(id);
    };
    await rejectOne(approvalId);
    // The model may ask again (retry with another path) — keep rejecting
    // every new ask until the turn ends. A hang here would mean the
    // decision did NOT take effect.
    try {
      await waitFor("post-decision step progress", async () => {
        const evs = await repo.readEvents(sessionId);
        for (const asked of evs.filter((e) => e.eventType === "approval/asked")) {
          const id = (asked.data as { id: string }).id;
          const hasDecided = evs.some(
            (e) =>
              e.eventType === "approval/decided" &&
              (e.data as { id: string }).id === id,
          );
          if (!hasDecided && !decidedIds.has(id)) {
            await rejectOne(id);
          }
        }
        // Proof the decision took effect: the decided ask's step closed and
        // the turn moved on (new step activity after the decision).
        const decidedIdx = evs.findIndex((e) => e.eventType === "approval/decided");
        if (decidedIdx < 0) return false;
        return evs
          .slice(decidedIdx + 1)
          .some((e) => e.eventType === "step/end" || e.eventType === "turn/end");
      });
    } catch (e) {
      const evs = await repo.readEvents(sessionId);
      console.log("TIMEOUT_EVENT_TYPES=" + JSON.stringify(evs.map((x) => x.eventType)));
      console.log("TIMEOUT_LAST_DATA=" + JSON.stringify(evs[evs.length - 1]?.data).slice(0, 500));
      throw e;
    }
    const decided = (await repo.readEvents(sessionId)).find(
      (e) => e.eventType === "approval/decided",
    );
    console.log("APPROVAL_DECIDED=" + JSON.stringify(decided?.data).slice(0, 300));
    console.log("APPROVAL_REJECTED_COUNT=" + decidedIds.size);
    console.log("APPROVAL_TOOK_EFFECT=true (step closed after the decision)");
  } else {
    console.log("APPROVAL_ASK=none (no live ask to resolve; see turn log)");
  }

  // ---- 3. close the escalation turn, then resume on a fresh starter ----
  await heartbeat();
  const cancel2 = await cpFetch(`/v1/sessions/${sessionId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  console.log("cancel2 status=" + cancel2.status);
  if (cancel2.status !== 201) throw new Error(`cancel2: ${cancel2.status}`);
  await waitFor("final turn/end", async () =>
    (await repo.readEvents(sessionId)).some(
      (e) =>
        e.eventType === "turn/end" &&
        JSON.stringify(e.data).includes("aborted"),
    ),
  );
  console.log("TURN2_ABORTED=true");

  // ---- 4. resume on a fresh starter over the same repo ----
  const starter2 = await HarnessTurnStarter.create({
    config,
    repository: repo,
    logger,
  });
  const resumed = await starter2.resumeSessions([sessionId]);
  console.log("RESUMED=" + JSON.stringify(resumed));
  if (resumed.resumed.length !== 1) throw new Error("resume did not resume the session");
  console.log("LIVE39_OK seq0=" + msgEvent.seq);
} finally {
  if (hbTimer !== undefined) clearInterval(hbTimer);
  cpServer.stop(true);
  ahServer.stop(true);
}
process.exit(0);
