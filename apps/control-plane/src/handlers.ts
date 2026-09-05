// Route handlers — 仕様書 section 24 API surface.
//
// Authorization pipeline for every workspace-scoped route:
//   authenticate (IAP identity -> internal user)
//     -> workspace membership check (仕様書 section 26 item 7)
//     -> controller check for controller-only operations (仕様書 section 20)

import type {
  ControllerLease,
  ControllerLeaseService,
} from "@cloud-run-dsh/controller-lease";
import {
  LeaseAlreadyHeldError,
  LeaseExpiredError,
  LeaseNotFoundError,
  NotLeaseOwnerError,
} from "@cloud-run-dsh/controller-lease";
import type { Session, Workspace } from "@cloud-run-dsh/session-persistence-postgres";
import { ApiError, badGateway, badRequest, conflict, notFound } from "./errors.js";
import {
  AgentHostConflictError,
  type ForwardMessageArgs,
} from "./forwarding.js";
import { assertMember } from "./membership.js";
import type { InternalUser } from "./auth.js";
import type { ControlPlaneDeps } from "./deps.js";
import {
  optionalObject,
  optionalString,
  parseJsonBody,
  parseOptionalJsonBody,
  requireSegment,
  requireString,
} from "./validate.js";

export interface RouteContext {
  readonly request: Request;
  readonly params: Record<string, string>;
  readonly url: URL;
  readonly deps: ControlPlaneDeps;
  readonly user: InternalUser;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Loads a workspace or throws 404. */
export async function loadWorkspace(deps: ControlPlaneDeps, id: string): Promise<Workspace> {
  const workspace = await deps.repo.getWorkspace(id);
  if (!workspace) throw notFound(`workspace ${id} not found`);
  return workspace;
}

/** Loads a session or throws 404. */
export async function loadSession(deps: ControlPlaneDeps, id: string): Promise<Session> {
  const session = await deps.repo.getSession(id);
  if (!session) throw notFound(`session ${id} not found`);
  return session;
}

/**
 * Loads the session and verifies the caller is a member of its workspace.
 * (仕様書 section 21: identity + membership before authorization.)
 */
export async function loadSessionForMember(
  deps: ControlPlaneDeps,
  sessionId: string,
  userId: string,
): Promise<Session> {
  const session = await loadSession(deps, sessionId);
  await assertMember(deps, session.workspaceId, userId);
  return session;
}

/**
 * Controller enforcement (仕様書 section 20): message send, approval, cancel
 * and manual checkpoint require the caller to hold the active controller
 * lease. Observers get 409.
 */
export async function requireController(
  leases: ControllerLeaseService,
  workspaceId: string,
  userId: string,
): Promise<ControllerLease> {
  const lease = await leases.getActive(workspaceId);
  if (!lease) {
    throw conflict("no active controller for this workspace");
  }
  if (lease.userId !== userId) {
    throw conflict("only the controller can perform this operation");
  }
  return lease;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const createWorkspace: RouteHandler = async (ctx) => {
  const body = await parseJsonBody(ctx.request);
  const repositoryOwner = requireString(body, "repositoryOwner");
  const repositoryName = requireString(body, "repositoryName");
  const baseBranch = optionalString(body, "baseBranch") ?? "main";
  const id = crypto.randomUUID();
  const workspace = await ctx.deps.repo.createWorkspace({
    id,
    ownerId: ctx.user.id,
    repositoryOwner,
    repositoryName,
    baseBranch,
    runtimeState: "STOPPED",
  });
  // The owner is always a member.
  await ctx.deps.membership.addMember(workspace.id, ctx.user.id);
  return json(toWorkspaceDto(workspace), 201);
};

export const getWorkspace: RouteHandler = async (ctx) => {
  const id = requireSegment(ctx.params.id, "id");
  const workspace = await loadWorkspace(ctx.deps, id);
  await assertMember(ctx.deps, workspace.id, ctx.user.id);
  return json(toWorkspaceDto(workspace));
};

export const openWorkspace: RouteHandler = async (ctx) => {
  const id = requireSegment(ctx.params.id, "id");
  await parseOptionalJsonBody(ctx.request);
  const workspace = await loadWorkspace(ctx.deps, id);
  await assertMember(ctx.deps, workspace.id, ctx.user.id);
  // Issue #60 案B: the controller lease and the Instance share ONE controller
  // identity. Establish it BEFORE touching the runtime and inject it into the
  // Instance env, so the agent-host adopts this lease instead of
  // self-acquiring a conflicting one on the same row (the old deadlock: the
  // user's lease (A) vs the host's self-acquire (B), neither able to proceed).
  // Open is lifecycle, not authorship: any active lease is reused whoever
  // holds it (§20 still gates messages by userId); only a missing/expired
  // lease is freshly acquired for the opener.
  const controllerId = await ensureControllerLeaseForOpen(
    ctx.deps.leases,
    workspace.id,
    ctx.user.id,
  );
  // 実装手順書 section 27: concurrent opens coalesce inside the T8 runtime.
  const handle = await ctx.deps.runtimes.get(workspace, controllerId);
  const state = await handle.open();
  return json({ workspaceId: workspace.id, state });
};

/**
 * Resolves the single controller identity for an open (issue #60 案B).
 *
 * Reuses the active lease when one exists (whoever holds it — see above);
 * otherwise acquires a fresh lease for the opener. A lost acquire race (a
 * concurrent open won the CAS) falls back to the winner's lease instead of
 * failing: both opens converge on the same controllerId, which is exactly
 * what the agent-host needs to adopt.
 */
export async function ensureControllerLeaseForOpen(
  leases: ControllerLeaseService,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const active = await leases.getActive(workspaceId);
  if (active) return active.controllerId;
  try {
    const lease = await leases.acquire(workspaceId, crypto.randomUUID(), userId);
    return lease.controllerId;
  } catch (e) {
    if (e instanceof LeaseAlreadyHeldError) {
      const winner = await leases.getActive(workspaceId);
      if (winner) return winner.controllerId;
    }
    throw e;
  }
}

export const stopWorkspace: RouteHandler = async (ctx) => {
  const id = requireSegment(ctx.params.id, "id");
  await parseOptionalJsonBody(ctx.request);
  const workspace = await loadWorkspace(ctx.deps, id);
  await assertMember(ctx.deps, workspace.id, ctx.user.id);
  const handle = await ctx.deps.runtimes.get(workspace);
  // Issue #72: the REAL caller travels into the agent-host prepare-stop
  // forward (the factory refuses a faceless stop when a forwarder is wired).
  const state = await handle.stop({ id: ctx.user.id, email: ctx.user.email });
  return json({ workspaceId: workspace.id, state });
};

/**
 * Deletes a workspace and its Cloud Run Instance (issue #85 案B).
 *
 * Membership is checked FIRST (like every other workspace-scoped route): a
 * non-member gets 403 and nothing is touched. The Instance is deleted BEFORE
 * the row: if the Instances API call fails the row is kept so the delete is
 * retryable (a STOPPED workspace will also be picked up by the hourly #85 GC
 * reaper). A missing Instance is success. Sessions, events, checkpoints and
 * the controller lease go with the row (repo.deleteWorkspace cascades).
 */
export const deleteWorkspace: RouteHandler = async (ctx) => {
  const id = requireSegment(ctx.params.id, "id");
  const workspace = await loadWorkspace(ctx.deps, id);
  await assertMember(ctx.deps, workspace.id, ctx.user.id);
  const handle = await ctx.deps.runtimes.get(workspace);
  try {
    await handle.deleteInstance();
  } catch (e) {
    ctx.deps.logger?.error("control-plane.workspace-delete.instance-failed", {
      workspaceId: workspace.id,
      instanceName: workspace.instanceName ?? undefined,
      error: e instanceof Error ? e.message : String(e),
    });
    throw badGateway(
      "workspace instance could not be deleted — the workspace was kept; retry later",
    );
  }
  const deleted = await ctx.deps.repo.deleteWorkspace(workspace.id);
  // Lost a race with a concurrent delete: the workspace is gone, which is
  // the requested end state, but report it honestly as 404.
  if (!deleted) throw notFound(`workspace ${id} not found`);
  // Best-effort membership cleanup. The owner-only production store derives
  // membership from the (now deleted) row, so failures here change nothing.
  try {
    for (const memberId of await ctx.deps.membership.listMembers(workspace.id)) {
      await ctx.deps.membership.removeMember(workspace.id, memberId).catch(() => undefined);
    }
  } catch {
    // ignore — the workspace row (the source of truth) is already gone.
  }
  ctx.deps.logger?.info("control-plane.workspace-deleted", {
    workspaceId: workspace.id,
    instanceName: workspace.instanceName ?? undefined,
  });
  return json({ workspaceId: workspace.id, deleted: true });
};

export const listSessions: RouteHandler = async (ctx) => {
  const id = requireSegment(ctx.params.id, "id");
  const workspace = await loadWorkspace(ctx.deps, id);
  await assertMember(ctx.deps, workspace.id, ctx.user.id);
  const sessions = await ctx.deps.repo.listSessions(workspace.id);
  return json({ sessions: sessions.map(toSessionDto) });
};

export const createSession: RouteHandler = async (ctx) => {
  const id = requireSegment(ctx.params.id, "id");
  const body = await parseOptionalJsonBody(ctx.request);
  const metadata = optionalObject(body, "metadata");
  const workspace = await loadWorkspace(ctx.deps, id);
  await assertMember(ctx.deps, workspace.id, ctx.user.id);
  const session = await ctx.deps.repo.createSession({
    id: crypto.randomUUID(),
    workspaceId: workspace.id,
    metadata: metadata ?? {},
  });
  return json(toSessionDto(session), 201);
};

export const manualCheckpoint: RouteHandler = async (ctx) => {
  const id = requireSegment(ctx.params.id, "id");
  await parseOptionalJsonBody(ctx.request);
  const workspace = await loadWorkspace(ctx.deps, id);
  await assertMember(ctx.deps, workspace.id, ctx.user.id);
  // Manual checkpoint is controller-only (仕様書 section 20).
  await requireController(ctx.deps.leases, workspace.id, ctx.user.id);
  const handle = await ctx.deps.runtimes.get(workspace);
  // Issue #75: the REAL caller travels into the agent-host checkpoint
  // forward, and `checkpointed: true` is now backed by a real durable
  // snapshot (a clean-tree host skip is still success — its snapshot
  // already covers the tree; a failure rejects and never reaches this
  // line). The marker records the host's skip flag for audit, and the
  // response carries it as `skipped` (issue #89) so callers can tell a
  // real snapshot apart from a clean-tree skip.
  const { skipped } = await handle.runManualCheckpoint({ id: ctx.user.id, email: ctx.user.email });
  return json({ workspaceId: workspace.id, checkpointed: true, skipped });
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const postMessage: RouteHandler = async (ctx) => {
  const sessionId = requireSegment(ctx.params.id, "id");
  const body = await parseJsonBody(ctx.request);
  const content = requireString(body, "content");
  const session = await loadSessionForMember(ctx.deps, sessionId, ctx.user.id);
  // Message send is controller-only (仕様書 section 20).
  await requireController(ctx.deps.leases, session.workspaceId, ctx.user.id);
  const workspace = await loadWorkspace(ctx.deps, session.workspaceId);
  const handle = await ctx.deps.runtimes.get(workspace);
  // The workspace state must accept agent input (仕様書 section 8).
  // Issue #122: awaited — the gate reloads the persisted row, so a
  // late agent-host recovery (DB READY) unblocks turns without re-open.
  await handle.assertAgentInputAllowed();
  // A user message is meaningful activity (仕様書 section 11).
  handle.recordActivity("user_message");
  // Resolve the forward target BEFORE appending: when the Instance is not
  // running there is no turn to start, so answering 409 without writing
  // avoids an orphan `user_message` no turn will ever consume.
  const forwarder = ctx.deps.messageForwarder;
  let instanceUrl: string | null = null;
  if (forwarder) {
    instanceUrl = await handle.getInstanceUrl();
    if (!instanceUrl) {
      throw conflict(
        `workspace instance is not running — open the workspace first, then retry`,
      );
    }
  }
  // The control plane is the SOLE writer of `user_message` (issue #22):
  // the agent-host starts the turn from the forwarded seq/content below
  // and must not append the event again.
  const [event] = await ctx.deps.repo.append(session.id, [
    {
      eventType: "user_message",
      eventTime: ctx.deps.clock.now().getTime(),
      data: { content },
    },
  ]);
  if (forwarder && instanceUrl) {
    const forwardArgs: ForwardMessageArgs = {
      instanceUrl,
      workspaceId: workspace.id,
      sessionId: session.id,
      seq: event!.seq,
      content,
      identity: { id: ctx.user.id, email: ctx.user.email },
    };
    try {
      await forwarder.forward(forwardArgs);
    } catch (e) {
      // The host refused for a caller-actionable reason — propagate the 409
      // (lease, stale state) instead of reporting a gateway failure.
      if (e instanceof AgentHostConflictError) {
        throw conflict(e.message);
      }
      // The event is recorded but the turn did not start: never fake the
      // 201. Details go to the structured log; the response stays generic.
      ctx.deps.logger?.error("control-plane.forward.failed", {
        workspaceId: workspace.id,
        sessionId: session.id,
        seq: event!.seq,
        error: e instanceof Error ? e.message : String(e),
      });
      throw badGateway(
        "message recorded but the workspace instance did not accept it — the turn did not start",
      );
    }
  }
  return json(toEventDto(event!), 201);
};

export const postApproval: RouteHandler = async (ctx) => {
  const sessionId = requireSegment(ctx.params.id, "id");
  const approvalId = requireSegment(ctx.params.approvalId, "approvalId");
  const body = await parseOptionalJsonBody(ctx.request);
  const decision = optionalString(body, "decision") ?? "approved";
  if (decision !== "approved" && decision !== "rejected") {
    throw badRequest("field 'decision' must be 'approved' or 'rejected'");
  }
  const session = await loadSessionForMember(ctx.deps, sessionId, ctx.user.id);
  // Approval is controller-only (仕様書 section 20).
  await requireController(ctx.deps.leases, session.workspaceId, ctx.user.id);
  const workspace = await loadWorkspace(ctx.deps, session.workspaceId);
  const handle = await ctx.deps.runtimes.get(workspace);
  // The workspace state must accept agent input (仕様書 section 8).
  // Issue #122: awaited — see postMessage.
  await handle.assertAgentInputAllowed();
  // An approval operation is meaningful activity (仕様書 section 11).
  handle.recordActivity("approval");
  // Resolve the forward target BEFORE appending (issue #39, same rule as
  // postMessage): when the Instance is not running there is no live turn to
  // decide, so answering 409 without writing avoids an orphan `approval` no
  // turn will ever consume.
  const forwarder = ctx.deps.messageForwarder;
  let instanceUrl: string | null = null;
  if (forwarder) {
    instanceUrl = await handle.getInstanceUrl();
    if (!instanceUrl) {
      throw conflict(
        `workspace instance is not running — open the workspace first, then retry`,
      );
    }
  }
  // The control plane is the SOLE writer of `approval`: the agent-host
  // resolves the decision from the forwarded approvalId/decision below and
  // must not append the event again.
  const [event] = await ctx.deps.repo.append(session.id, [
    {
      eventType: "approval",
      eventTime: ctx.deps.clock.now().getTime(),
      data: { approvalId, decision },
    },
  ]);
  if (forwarder && instanceUrl) {
    try {
      await forwarder.forwardApproval({
        instanceUrl,
        workspaceId: workspace.id,
        sessionId: session.id,
        approvalId,
        decision,
        identity: { id: ctx.user.id, email: ctx.user.email },
      });
    } catch (e) {
      // The host refused for a caller-actionable reason — propagate the 409
      // (lease, stale state) instead of reporting a gateway failure.
      if (e instanceof AgentHostConflictError) {
        throw conflict(e.message);
      }
      // The event is recorded but the decision did not reach the turn: never
      // fake the 201. Details go to the structured log; the response stays
      // generic.
      ctx.deps.logger?.error("control-plane.forward.failed", {
        kind: "approval",
        workspaceId: workspace.id,
        sessionId: session.id,
        approvalId,
        error: e instanceof Error ? e.message : String(e),
      });
      throw badGateway(
        "approval recorded but the workspace instance did not accept it — the decision did not reach the turn",
      );
    }
  }
  return json(toEventDto(event!), 201);
};

export const postCancel: RouteHandler = async (ctx) => {
  const sessionId = requireSegment(ctx.params.id, "id");
  await parseOptionalJsonBody(ctx.request);
  const session = await loadSessionForMember(ctx.deps, sessionId, ctx.user.id);
  // Cancel is controller-only (仕様書 section 20).
  await requireController(ctx.deps.leases, session.workspaceId, ctx.user.id);
  const workspace = await loadWorkspace(ctx.deps, session.workspaceId);
  const handle = await ctx.deps.runtimes.get(workspace);
  // The workspace state must accept agent input (仕様書 section 8).
  // Issue #122: awaited — see postMessage.
  await handle.assertAgentInputAllowed();
  // An explicit workspace operation is meaningful activity (仕様書 section 11).
  handle.recordActivity("workspace_operation");
  // Resolve the forward target BEFORE appending (issue #39, same rule as
  // postMessage): when the Instance is not running there is no live turn to
  // interrupt, so answering 409 without writing avoids an orphan `cancel`.
  const forwarder = ctx.deps.messageForwarder;
  let instanceUrl: string | null = null;
  if (forwarder) {
    instanceUrl = await handle.getInstanceUrl();
    if (!instanceUrl) {
      throw conflict(
        `workspace instance is not running — open the workspace first, then retry`,
      );
    }
  }
  // The control plane is the SOLE writer of `cancel`: the agent-host cancels
  // the live turn from the forwarded session below and must not append again.
  const [event] = await ctx.deps.repo.append(session.id, [
    {
      eventType: "cancel",
      eventTime: ctx.deps.clock.now().getTime(),
      data: { cancelledBy: ctx.user.id },
    },
  ]);
  if (forwarder && instanceUrl) {
    try {
      await forwarder.forwardCancel({
        instanceUrl,
        workspaceId: workspace.id,
        sessionId: session.id,
        identity: { id: ctx.user.id, email: ctx.user.email },
      });
    } catch (e) {
      // The host refused for a caller-actionable reason — propagate the 409
      // (lease, stale state) instead of reporting a gateway failure.
      if (e instanceof AgentHostConflictError) {
        throw conflict(e.message);
      }
      // The event is recorded but the turn was not interrupted: never fake
      // the 201. Details go to the structured log; the response stays generic.
      ctx.deps.logger?.error("control-plane.forward.failed", {
        kind: "cancel",
        workspaceId: workspace.id,
        sessionId: session.id,
        error: e instanceof Error ? e.message : String(e),
      });
      throw badGateway(
        "cancel recorded but the workspace instance did not accept it — the turn was not interrupted",
      );
    }
  }
  return json(toEventDto(event!), 201);
};

// ---------------------------------------------------------------------------
// Controller lease (仕様書 section 20, 実装手順書 section 26)
// ---------------------------------------------------------------------------

export const acquireController: RouteHandler = async (ctx) => {
  const workspaceId = requireSegment(ctx.params.id, "id");
  await parseOptionalJsonBody(ctx.request);
  const workspace = await loadWorkspace(ctx.deps, workspaceId);
  await assertMember(ctx.deps, workspace.id, ctx.user.id);
  const controllerId = crypto.randomUUID();
  try {
    const lease = await ctx.deps.leases.acquire(workspace.id, controllerId, ctx.user.id);
    return json(toLeaseDto(lease), 200);
  } catch (e) {
    if (e instanceof LeaseAlreadyHeldError) {
      throw conflict(`controller lease already held by ${e.holderControllerId}`);
    }
    throw e;
  }
};

export const heartbeatController: RouteHandler = async (ctx) => {
  const workspaceId = requireSegment(ctx.params.id, "id");
  const body = await parseJsonBody(ctx.request);
  const controllerId = requireString(body, "controllerId");
  const workspace = await loadWorkspace(ctx.deps, workspaceId);
  await assertMember(ctx.deps, workspace.id, ctx.user.id);
  try {
    const lease = await ctx.deps.leases.heartbeat(workspace.id, controllerId);
    return json(toLeaseDto(lease));
  } catch (e) {
    if (e instanceof LeaseNotFoundError) {
      throw notFound(`no controller lease for workspace ${workspace.id}`);
    }
    if (e instanceof NotLeaseOwnerError || e instanceof LeaseExpiredError) {
      throw conflict("controller lease is not owned by this controller");
    }
    throw e;
  }
};

export const releaseController: RouteHandler = async (ctx) => {
  const workspaceId = requireSegment(ctx.params.id, "id");
  const body = await parseJsonBody(ctx.request);
  const controllerId = requireString(body, "controllerId");
  const workspace = await loadWorkspace(ctx.deps, workspaceId);
  await assertMember(ctx.deps, workspace.id, ctx.user.id);
  try {
    await ctx.deps.leases.release(workspace.id, controllerId);
    return json({ released: true });
  } catch (e) {
    if (e instanceof LeaseNotFoundError) {
      throw notFound(`no controller lease for workspace ${workspace.id}`);
    }
    if (e instanceof NotLeaseOwnerError) {
      throw conflict("controller lease is not owned by this controller");
    }
    throw e;
  }
};

// ---------------------------------------------------------------------------
// DTOs — responses never expose internals or secrets.
// ---------------------------------------------------------------------------

function toWorkspaceDto(w: Workspace) {
  return {
    id: w.id,
    ownerId: w.ownerId,
    repositoryOwner: w.repositoryOwner,
    repositoryName: w.repositoryName,
    baseBranch: w.baseBranch,
    runtimeState: w.runtimeState,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

function toSessionDto(s: Session) {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    metadata: s.metadata,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function toEventDto(e: {
  sessionId: string;
  seq: number;
  eventType: string;
  eventTime: number;
  data: unknown;
}) {
  return {
    sessionId: e.sessionId,
    seq: e.seq,
    eventType: e.eventType,
    eventTime: e.eventTime,
    data: e.data,
  };
}

function toLeaseDto(l: ControllerLease) {
  return {
    workspaceId: l.workspaceId,
    controllerId: l.controllerId,
    expiresAt: l.expiresAt.toISOString(),
  };
}

export { json, ApiError };
