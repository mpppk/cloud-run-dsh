// Agent turn starter (issue #21): drives a forwarded user message through the
// DeepSeek Harness agent loop on the same cordis composition family as
// harness-real.ts, persists the loop's session events to the shared Postgres
// log, and exposes cancel + approval-decision seams.
//
// Composition (mount order follows the inject chains):
//   harness base (mountHarnessBasePlugins: sessionProjections, systemPrompt,
//   tools, sandboxPolicy, fs, fs-observation-policy, subprocess, tool-fs,
//   tool-fs-search — the REAL file/search tools, never reimplemented)
//   + AgentRegistry (dsh-agent) + SessionStore (dsh-session) + LlmRuntime
//   (dsh-llm) + llm-deepseek plugin (the OpenAI-compatible chat-completions
//   adapter pointed at LLM_BASE_URL) + AgentLoop (the concrete loop — the
//   turn is NEVER hand-rolled) + ApprovalService (dsh-user-approval).
//
// Write discipline (single-writer invariants):
//   - `user/message` DSH events are NEVER persisted here: the control plane
//     is the sole writer of `user_message` (#22) and already appended it
//     before forwarding (input.seq references that row).
//   - Everything else the loop appends to its session log (turn/step
//     boundaries, assistant messages/chunks, tool calls/results,
//     approval/asked + approval/decided audits, …) IS persisted via
//     `session/event` → repository.append, in per-session order.

import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentSetup } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";
import {
  Config as LlmDeepseekConfig,
  apply as applyLlmDeepseek,
  inject as llmDeepseekInject,
} from "@deepseek-ai/dsh-llm-deepseek";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import type { ApprovalRequestEvent } from "@deepseek-ai/dsh-user-approval/types";
import type { Logger } from "@cloud-run-dsh/observability";
import type {
  NewSessionEvent,
  SessionPersistenceRepository,
} from "@cloud-run-dsh/session-persistence-postgres";
import type { AgentHostConfig } from "./config.js";
import type { AgentTurnInput, ApprovalDecision, TurnStarter } from "./gateway.js";
import { mountHarnessBasePlugins } from "./harness-real.js";
import { PostgresSessionPersistence } from "./session-persistence.js";

/**
 * Provider route the turn's agents request. This is the route the
 * llm-deepseek plugin registers its adapter under (`deepseek-official` in
 * the published package); pointing its `baseURL` at OpenRouter keeps the
 * same route while the wire model id (AgentOptions.model) selects the
 * OpenRouter model.
 */
export const LLM_PROVIDER_ROUTE = "deepseek-official";

export interface HarnessTurnStarterDeps {
  readonly config: AgentHostConfig;
  readonly repository: SessionPersistenceRepository;
  readonly logger: Logger;
  /**
   * Test seam: when provided, this adapter is registered for the turn's
   * provider route INSTEAD of mounting the llm-deepseek plugin, so unit
   * tests drive turns with zero network.
   */
  readonly llmTestAdapter?: LlmAdapter;
}

interface PendingApproval {
  settled: boolean;
  resolve: (outcome: ApprovalOutcome) => void;
}

export class HarnessTurnStarter implements TurnStarter {
  private readonly ctx: Context;
  private readonly config: AgentHostConfig;
  private readonly repository: SessionPersistenceRepository;
  private readonly logger: Logger;

  /** In-flight agent creations, keyed by session id (startTurn race guard). */
  private readonly creating = new Map<string, Promise<Agent>>();
  /** Per-session ordered append chains (session/event → Postgres stays ordered). */
  private readonly appendTails = new Map<string, Promise<void>>();
  /** approval/asked id → { sessionId, callId } link, updated synchronously on session/event. */
  private readonly askedLinks = new Map<string, { sessionId: string; callId?: string }>();
  /** callId → pending answerer (tool-linked asks). */
  private readonly pendingByCall = new Map<string, PendingApproval>();
  /** sessionId → FIFO of pending callId-less asks (rare path). */
  private readonly pendingAnonymous = new Map<string, PendingApproval[]>();
  /** Decisions that arrived with no pending ask yet (or for an unknown id). */
  private readonly earlyDecisions = new Map<string, ApprovalOutcome>();

  private constructor(
    ctx: Context,
    deps: HarnessTurnStarterDeps,
  ) {
    this.ctx = ctx;
    this.config = deps.config;
    this.repository = deps.repository;
    this.logger = deps.logger;
  }

  static async create(deps: HarnessTurnStarterDeps): Promise<HarnessTurnStarter> {
    const ctx = new Context();
    await mountHarnessBasePlugins(ctx, deps.config.workspaceRoot);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(SessionStore);
    // Postgres-backed session persistence (issue #39): the resume source.
    // Inert until resume() is called — the live write path stays in the
    // session/event subscription below (see session-persistence.ts).
    await ctx.plugin(PostgresSessionPersistence, {
      repository: deps.repository,
      workspaceId: deps.config.workspaceId,
      workspaceRoot: deps.config.workspaceRoot,
      logger: deps.logger,
    });
    await ctx.plugin(LlmRuntime);
    if (deps.llmTestAdapter) {
      ctx.llm.registerAdapter([LLM_PROVIDER_ROUTE], deps.llmTestAdapter);
    } else {
      // `thinking: 'disabled'` — the DeepSeek thinking extension is not
      // guaranteed to pass through OpenRouter; every request is limited to
      // effort `off` instead.
      await ctx.plugin({ inject: llmDeepseekInject, apply: applyLlmDeepseek }, LlmDeepseekConfig({
        baseURL: deps.config.llmBaseUrl,
        apiKeyEnv: deps.config.llmApiKeyEnv,
        thinking: "disabled",
        models: [{ id: deps.config.llmModel }],
      }));
    }
    await ctx.plugin(AgentLoop, AgentLoop.Config({ agents: [] }));
    await ctx.plugin(
      ApprovalService,
      ApprovalService.Config({ policy: deps.config.llmApprovalPolicy }),
    );
    return new HarnessTurnStarter(ctx, deps);
  }

  /** Test/inspection surface: the live agent for a session, if any. */
  agentFor(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId));
  }

  /**
   * Starts (enqueues) one turn for an already-persisted user message. Returns
   * as soon as the message is queued — it never waits for the turn to finish.
   * The `user_message` row itself is NOT appended here (control plane owns it).
   *
   * The session row must already exist: the control plane creates workspaces
   * and sessions and is their sole writer. Fail loud otherwise — starting a
   * turn for an unknown session would orphan the loop's events.
   */
  async startTurn(input: AgentTurnInput): Promise<void> {
    const session = await this.repository.getSession(input.sessionId);
    if (!session) {
      throw new Error(`cannot start turn: session not found: ${input.sessionId}`);
    }
    const agent = await this.getOrCreateAgent(SessionId(input.sessionId));
    agent.followup(
      createUserMessage({
        content: [{ type: "text", text: input.content }],
        source: { kind: "user" },
      }),
    );
    this.logger.info("turn.started", {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      seq: input.seq,
    });
  }

  /**
   * Cancels the live turn for one session (gateway /cancel seam → agent.cancel).
   * With no sessionId, cancels every live turn on this host (workspace-level
   * cancel; this host serves exactly one workspace).
   * @returns how many live turns were cancelled.
   */
  async cancelTurn(sessionId?: string): Promise<number> {
    if (sessionId !== undefined) {
      const agent = this.ctx.agents.get(SessionId(sessionId));
      if (!agent) return 0;
      agent.cancel({ kind: "user" });
      this.logger.info("turn.cancelled", { sessionId });
      return 1;
    }
    let cancelled = 0;
    for (const agent of this.ctx.agents.list()) {
      agent.cancel({ kind: "user" });
      cancelled += 1;
    }
    this.logger.info("turn.cancelled_all", { count: cancelled });
    return cancelled;
  }

  /**
   * Resolves one pending approval ask (gateway /approvals seam). Accepts
   * either the DSH-issued `approval/asked` id (carried on the persisted
   * event, which is what clients learn from the event log) or the tool call
   * id for tool-linked asks.
   * @returns true when the decision settled a known ask (or a known asked
   * event whose ask has not pended yet); false for a fully unknown id.
   */
  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<boolean> {
    const outcome: ApprovalOutcome = decision === "approved" ? "allowed-once" : "rejected";
    // Direct tool-call correlation first.
    if (this.settleCallId(approvalId, outcome)) return true;
    // Then the DSH-issued asked id via the subscriber-maintained link.
    const link = this.askedLinks.get(approvalId);
    if (link?.callId && this.settleCallId(link.callId, outcome)) return true;
    if (link) {
      // CallId-less ask: settle this session's oldest unsettled anonymous ask.
      if (this.settleAnonymous(link.sessionId, outcome)) return true;
      // The asked event is known but its ask has not pended yet (or already
      // settled): park the decision so the answerer picks it up.
      this.earlyDecisions.set(approvalId, outcome);
      if (link.callId) this.earlyDecisions.set(link.callId, outcome);
      return true;
    }
    // Fully unknown id — still park it (a racing client may resolve before
    // the asked event reaches us), but report it as unknown.
    this.earlyDecisions.set(approvalId, outcome);
    this.logger.warn("turn.approval_unknown_id", { approvalId });
    return false;
  }

  // -------------------------------------------------------------------------
  // Agent lifecycle
  // -------------------------------------------------------------------------

  private async getOrCreateAgent(sessionId: SessionId): Promise<Agent> {
    const live = this.ctx.agents.get(sessionId);
    if (live) return live;
    const key = sessionId as string;
    let pending = this.creating.get(key);
    if (!pending) {
      pending = this.createAgent(sessionId).finally(() => {
        this.creating.delete(key);
      });
      this.creating.set(key, pending);
    }
    return pending;
  }

  private async createAgent(sessionId: SessionId): Promise<Agent> {
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.config.workspaceRoot },
      agentOptions: { provider: LLM_PROVIDER_ROUTE, model: this.config.llmModel },
      setup: this.agentSetup(sessionId),
    });
    // Owned by the root fiber for the host lifetime: per-turn disposal would
    // drop the session log the next turn resumes from.
    void handle;
    const agent = this.ctx.agents.get(sessionId);
    if (!agent) {
      throw new Error(`agent for session ${sessionId as string} was not published`);
    }
    return agent;
  }

  /**
   * Resumes one agent per persisted session (issue #39 restart recovery).
   * Called once during recovery with the session ids read from Postgres —
   * sessions with no live agent are rehydrated via AgentLoop.resume() (the
   * create/createAgent counterpart for persisted history), NOT recreated
   * empty: recreating would silently drop the conversation history.
   *
   * A resume failure REJECTS (never falls back to create): history that
   * cannot be restored must surface as a recovery failure, not as a fresh
   * session that looks like deleted history. Sessions that are already live
   * are skipped (recovery runs once per boot; the skip is defensive).
   */
  async resumeSessions(sessionIds: readonly string[]): Promise<{ resumed: string[] }> {
    const resumed: string[] = [];
    for (const rawId of sessionIds) {
      const sessionId = SessionId(rawId);
      if (this.ctx.agents.get(sessionId)) {
        this.logger.info("turn.resume.skipped_live", { sessionId: rawId });
        continue;
      }
      const handle = await this.ctx.agentLoop.resume(this.ctx, {
        resumeSessionId: sessionId,
        agentOptions: { provider: LLM_PROVIDER_ROUTE, model: this.config.llmModel },
        setup: this.agentSetup(sessionId),
      });
      // Same ownership as created agents: the root fiber holds the handle
      // for the host lifetime.
      void handle;
      resumed.push(rawId);
      this.logger.info("turn.resumed", {
        workspaceId: this.config.workspaceId,
        sessionId: rawId,
      });
    }
    return { resumed };
  }

  /**
   * The agent-scoped world every agent gets — shared by create AND resume so
   * a resumed agent answers approvals and persists events exactly like a
   * fresh one. (A divergence here would mean resumed turns silently lose
   * approval handling or durability.)
   */
  private agentSetup(sessionId: SessionId): AgentSetup {
    return (agentCtx) => {
      // Agent-scoped answerer: scope-filtered dispatch delivers only this
      // agent's asks here. It pends until the HTTP decision arrives
      // (resolveApproval), the request signal aborts (turn cancel), or a
      // pre-arrived decision is found.
      agentCtx.on("approval/request", (req, next) =>
        this.onApprovalRequest(sessionId as string, req, next),
      );
      // Agent-scoped persistence feed: `session/event` is scope-filtered
      // dispatch, so a root listener never sees these — each agent's setup
      // subscribes its own session feed (and flush drain) here.
      // The asked-id → call-id link is updated SYNCHRONOUSLY (before the
      // async persist below): ApprovalService appends `approval/asked`
      // strictly before dispatching the `approval/request` waterfall, so by
      // the time the answerer pends, this link already exists.
      agentCtx.on("session/event", (session: Session, event: SessionEvent) => {
        if (event.type === "approval/asked") {
          const data = event.data as { id?: unknown; callId?: unknown };
          if (typeof data.id === "string") {
            this.askedLinks.set(data.id, {
              sessionId: session.id as string,
              callId: typeof data.callId === "string" ? data.callId : undefined,
            });
          }
        }
        void this.enqueueAppend(session, event).catch((error) => {
          // Persistence must never break the loop (session/event failures
          // are contained by the session boundary anyway).
          this.logger.error("turn.persist_failed", {
            sessionId: session.id as string,
            eventType: event.type,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
      // Durability checkpoint: drain this session's ordered append chain.
      agentCtx.on("session/flush", (session: Session) =>
        this.drainAppends(session.id as string),
      );
    };
  }

  // -------------------------------------------------------------------------
  // Approval bridge
  // -------------------------------------------------------------------------

  private onApprovalRequest(
    sessionId: string,
    req: ApprovalRequestEvent,
    _next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const callId = req.callId === undefined ? undefined : String(req.callId);
    // A decision that raced ahead of the ask settles immediately.
    const early = callId !== undefined ? this.earlyDecisions.get(callId) : undefined;
    if (early !== undefined) {
      if (callId !== undefined) this.earlyDecisions.delete(callId);
      return Promise.resolve(early);
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: PendingApproval = { settled: false, resolve };
      const settle = (outcome: ApprovalOutcome): void => {
        if (entry.settled) return;
        entry.settled = true;
        this.unpend(sessionId, callId, entry);
        resolve(outcome);
      };
      entry.resolve = settle;
      if (callId !== undefined) {
        this.pendingByCall.set(callId, entry);
      } else {
        const queue = this.pendingAnonymous.get(sessionId) ?? [];
        queue.push(entry);
        this.pendingAnonymous.set(sessionId, queue);
      }
      if (req.signal?.aborted) {
        settle("cancelled");
        return;
      }
      req.signal?.addEventListener("abort", () => settle("cancelled"), { once: true });
    });
  }

  private settleCallId(callId: string, outcome: ApprovalOutcome): boolean {
    const pending = this.pendingByCall.get(callId);
    if (pending && !pending.settled) {
      pending.resolve(outcome);
      return true;
    }
    return false;
  }

  private settleAnonymous(sessionId: string, outcome: ApprovalOutcome): boolean {
    const queue = this.pendingAnonymous.get(sessionId);
    const entry = queue?.find((e) => !e.settled);
    if (!entry) return false;
    entry.resolve(outcome);
    return true;
  }

  private unpend(sessionId: string, callId: string | undefined, entry: PendingApproval): void {
    if (callId !== undefined && this.pendingByCall.get(callId) === entry) {
      this.pendingByCall.delete(callId);
      return;
    }
    const queue = this.pendingAnonymous.get(sessionId);
    if (queue) {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
    }
  }

  // -------------------------------------------------------------------------
  // session/event → Postgres persistence (subscribed per-agent; see setup)
  // -------------------------------------------------------------------------

  private async enqueueAppend(session: Session, event: SessionEvent): Promise<void> {
    // The control plane is the SOLE writer of `user_message` — the row
    // already exists (input.seq); persisting the loop's `user/message` copy
    // would duplicate it.
    if (event.type === "user/message") return;
    const sessionId = session.id as string;
    const tail = this.appendTails.get(sessionId) ?? Promise.resolve();
    const next = tail.then(() => this.appendOne(sessionId, event));
    // A rejection must not poison the chain for later events; the error is
    // logged by the subscriber's catch above.
    const tracked = next.catch(() => undefined);
    this.appendTails.set(sessionId, tracked);
    await next;
    if (this.appendTails.get(sessionId) === tracked) {
      this.appendTails.delete(sessionId);
    }
  }

  private async drainAppends(sessionId: string): Promise<void> {
    await (this.appendTails.get(sessionId) ?? Promise.resolve());
  }

  private async appendOne(sessionId: string, event: SessionEvent): Promise<void> {
    const record: NewSessionEvent = {
      eventType: event.type,
      eventTime: event.time,
      data: event.data as unknown,
    };
    // Surface events cite their sources and carry a surface op; the
    // repository stores both so SSE/projection consumers can refetch them.
    const sourceEventSeqs =
      "sourceEventSeqs" in event ? (event.sourceEventSeqs as unknown) : undefined;
    const surfaceOp = "surfaceOp" in event ? (event.surfaceOp as unknown) : undefined;
    const withSources: NewSessionEvent =
      sourceEventSeqs !== undefined || surfaceOp !== undefined
        ? {
            ...record,
            ...(sourceEventSeqs !== undefined ? { sourceEventSeqs } : {}),
            ...(surfaceOp !== undefined ? { surfaceOp } : {}),
          }
        : record;
    await this.repository.append(sessionId, [withSources]);
  }
}
