// Control Plane — Workspace API & Agent Gateway (T9)
//
// HTTP surface per 仕様書 section 24, composed from the existing packages:
//   T4 @cloud-run-dsh/session-persistence-postgres — workspace/session/event store
//   T6 @cloud-run-dsh/controller-lease            — single-writer controller lease
//   T8 @cloud-run-dsh/workspace-runtime           — state machine, open/stop, idle
//
// Auth: IAP identity -> internal user -> workspace membership -> authorization
// (仕様書 sections 21/26, 実装手順書 section 25). Membership is ALWAYS verified.

import { githubUserId } from "./auth.js";
import { InMemorySessionStore } from "./auth-session.js";
import type { AuthenticatedUser, IapIdentity, InternalUser } from "./auth.js";
import type { ControlPlaneDeps } from "./deps.js";
export type { WorkspaceRuntimeHandle, ControlPlaneDeps, ControlPlaneClock, InstanceDiagnostic } from "./deps.js";
export { WorkspaceRuntimeHandleAdapter, RuntimeRegistry, SystemClock } from "./deps.js";
export {
  authenticate,
  githubUser,
  githubUserId,
  parseIapHeaders,
  type AuthenticatedUser,
  type IapIdentity,
  type InternalUser,
  type AuthDeps,
} from "./auth.js";
export {
  bindingMatches,
  buildOAuthBindingClearCookie,
  buildOAuthBindingSetCookie,
  buildSessionClearCookie,
  buildSessionSetCookie,
  generateCodeVerifier,
  generateRawToken,
  hashToken,
  InMemorySessionStore,
  parseOAuthBindingCookies,
  parseSessionCookies,
  pkceChallenge,
  PostgresSessionStore,
  authenticateSession,
  CLEANUP_DEFAULT_LIMIT,
  LOGIN_FLOW_LIFETIME_MS,
  OAUTH_BINDING_BYTES,
  OAUTH_BINDING_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_LIFETIME_MS,
  SESSION_TOKEN_BYTES,
  type ConsumedLoginFlow,
  type CreatedLoginFlow,
  type CreatedSession,
  type ExpiredCleanup,
  type SessionAuthDeps,
  type SessionRecord,
  type SessionStore,
} from "./auth-session.js";
export {
  InMemoryMembershipStore,
  assertMember,
  type MembershipStore,
} from "./membership.js";
export { ApiError, badRequest, unauthorized, forbidden, notFound, conflict, badGateway, unavailable } from "./errors.js";
export {
  AgentHostConflictError,
  AgentHostForwardError,
  HttpAgentHostForwarder,
  RefreshingIdTokenProvider,
  buildIdTokenUrl,
  createIdTokenProvider,
  parseJwtExpSeconds,
  ID_TOKEN_DEFAULT_EXPIRES_IN_S,
  ID_TOKEN_ENV_LIFETIME_S,
  ID_TOKEN_ENV_VAR,
  ID_TOKEN_METADATA_BASE,
  ID_TOKEN_REFRESH_MARGIN_MS,
  type AgentHostForwardResult,
  type AgentHostFetchFn,
  type CheckpointForwardResult,
  type ForwardApprovalArgs,
  type ForwardCancelArgs,
  type ForwardCheckpointArgs,
  type ForwardIdentity,
  type ForwardMessageArgs,
  type ForwardPrepareStopArgs,
  type PrepareStopForwardResult,
  type HttpAgentHostForwarderOptions,
  type IdTokenProvider,
  type MessageForwarder,
  type RefreshingIdTokenProviderDeps,
} from "./forwarding.js";
export {
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  deleteWorkspace,
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
  FetchGitHubUserAuthClient,
  GitHubOAuthError,
  buildAuthorizeUrl,
  callbackUrl,
  handleAuthCallback,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthSession,
  resolveReturnTo,
  type AuthRouteDeps,
  type CodeExchangeInput,
  type GitHubUserAuthClient,
  type GitHubUserProfile,
  type OAuthConfig,
} from "./auth-github.js";
export {
  RepositoryAuthorizerTransientError,
  RepositoryInputError,
  createRepositoryAuthorizer,
  validateRepositoryCoordinates,
  type RepositoryAuthorizer,
  type RepositoryPermissionInput,
} from "@cloud-run-dsh/github-credential-broker";
export { serveStaticFile } from "./static.js";
export {
  createFetchHandler,
  describeError,
  errorContextFromRequest,
  startControlPlane,
  toErrorResponse,
  type ErrorLogContext,
  type RunningControlPlane,
  type ToErrorResponseOptions,
} from "./server.js";

export { PLACEHOLDER_KIND } from "./placeholder.js";
export type { ControlPlanePlaceholder } from "./placeholder.js";
export { createPlaceholder } from "./placeholder.js";

/**
 * TRANSITIONAL (#149) IAP identity -> internal user resolution.
 *
 * Issue #149 requires `AuthenticatedUser.id` to be `github:<numeric-id>`
 * derived from an IMMUTABLE provider id — never a mutable login. IAP only
 * supplies a Google subject, which is stable per Google account but is NOT a
 * GitHub numeric id, so this shim namespaces it distinctly (`github:iapp-<subject>`)
 * and carries the IAP email as the display login. This mapping is replaced
 * by real GitHub OAuth issuance in #151 (which knows the true numeric id);
 * rows written under the transitional namespace keep working because
 * membership compares the same `id` string on both sides.
 *
 * Replace via deps.resolveUser for a real user directory.
 */
export function defaultResolveUser(identity: IapIdentity): Promise<InternalUser | null> {
  const providerUserId = `iapp-${identity.subject}`;
  return Promise.resolve({
    id: githubUserId(providerUserId),
    provider: "github",
    providerUserId,
    login: identity.email,
  });
}

/**
 * Builds the dependency object. All collaborators are injected so tests use
 * fakes and no real GCP/DB/network is required.
 *
 * `sessions` defaults to an in-memory store (issue #150); production passes
 * a Postgres-backed store explicitly.
 */
export function createControlPlaneDeps(
  deps: Omit<ControlPlaneDeps, "resolveUser" | "sessions"> & {
    resolveUser?: ControlPlaneDeps["resolveUser"];
    sessions?: ControlPlaneDeps["sessions"];
  },
): ControlPlaneDeps {
  return { resolveUser: defaultResolveUser, sessions: new InMemorySessionStore(), ...deps };
}
