// Control Plane — Workspace API & Agent Gateway (T9)
//
// HTTP surface per 仕様書 section 24, composed from the existing packages:
//   T4 @cloud-run-dsh/session-persistence-postgres — workspace/session/event store
//   T6 @cloud-run-dsh/controller-lease            — single-writer controller lease
//   T8 @cloud-run-dsh/workspace-runtime           — state machine, open/stop, idle
//
// Auth: IAP identity -> internal user -> workspace membership -> authorization
// (仕様書 sections 21/26, 実装手順書 section 25). Membership is ALWAYS verified.

import type { IapIdentity, InternalUser } from "./auth.js";
import type { ControlPlaneDeps } from "./deps.js";
export type { WorkspaceRuntimeHandle, ControlPlaneDeps, ControlPlaneClock } from "./deps.js";
export { WorkspaceRuntimeHandleAdapter, RuntimeRegistry, SystemClock } from "./deps.js";
export {
  authenticate,
  parseIapHeaders,
  type IapIdentity,
  type InternalUser,
  type AuthDeps,
} from "./auth.js";
export {
  InMemoryMembershipStore,
  assertMember,
  type MembershipStore,
} from "./membership.js";
export { ApiError, badRequest, unauthorized, forbidden, notFound, conflict, unavailable } from "./errors.js";
export {
  createWorkspace,
  getWorkspace,
  openWorkspace,
  stopWorkspace,
  listSessions,
  createSession,
  postMessage,
  postApproval,
  postCancel,
  manualCheckpoint,
  acquireController,
  heartbeatController,
  releaseController,
  loadWorkspace,
  loadSession,
  requireController,
  type RouteContext,
} from "./handlers.js";
export { handleSessionEvents } from "./sse.js";
export {
  createFetchHandler,
  startControlPlane,
  toErrorResponse,
  type RunningControlPlane,
} from "./server.js";

export { PLACEHOLDER_KIND } from "./placeholder.js";
export type { ControlPlanePlaceholder } from "./placeholder.js";
export { createPlaceholder } from "./placeholder.js";

/**
 * Default IAP identity -> internal user resolution: the IAP subject IS the
 * internal user id. Replace via deps.resolveUser for a real user directory.
 */
export function defaultResolveUser(identity: IapIdentity): Promise<InternalUser | null> {
  return Promise.resolve({ id: identity.subject, email: identity.email });
}

/**
 * Builds the dependency object. All collaborators are injected so tests use
 * fakes and no real GCP/DB/network is required.
 */
export function createControlPlaneDeps(
  deps: Omit<ControlPlaneDeps, "resolveUser"> & { resolveUser?: ControlPlaneDeps["resolveUser"] },
): ControlPlaneDeps {
  return { resolveUser: defaultResolveUser, ...deps };
}
