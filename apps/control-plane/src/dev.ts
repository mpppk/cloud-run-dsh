// Local development server for the control plane.
//
// Boots the full HTTP surface on 127.0.0.1:$PORT (default 8787) with every
// dependency backed by in-memory implementations — no GCP, Cloud SQL or
// Cloud Run required:
//   - PostgresSessionPersistenceRepository over InMemoryFakeExecutor
//     (imported via the package's `./testing` entrypoint; the fake executor
//     is deliberately NOT exported from the production index)
//   - ControllerLeaseService over InMemoryLeaseStore
//   - InMemoryMembershipStore, RuntimeRegistry, SystemClock
//   - a logging WorkspaceRuntimeHandle that records activity kinds
//
// Run with: bun run dev:control-plane
// See docs/local-development.md for a curl walkthrough.

import { ControllerLeaseService, HEARTBEAT_INTERVAL_MS } from "@cloud-run-dsh/controller-lease";
import { InMemoryLeaseStore } from "@cloud-run-dsh/controller-lease/testing";
import { PostgresSessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import type {
  SessionPersistenceRepository,
  Workspace,
} from "@cloud-run-dsh/session-persistence-postgres";
import type { ActivityKind } from "@cloud-run-dsh/workspace-runtime";
import { createControlPlaneDeps, createFetchHandler } from "./index.js";
import { SERVER_IDLE_TIMEOUT_SECONDS } from "./server.js";
import type { RunningControlPlane } from "./index.js";
import {
  InMemoryMembershipStore,
  RuntimeRegistry,
  SystemClock,
  type ControlPlaneDeps,
  type WorkspaceRuntimeHandle,
} from "./index.js";

const DEFAULT_PORT = 8787;

/**
 * Issue #136: delay between the dev server's STARTING write and its READY
 * write below. In production the agent-host performs this leg (instance
 * boot + restore, seconds to ~3 min after a stop-then-open per #121); the
 * dev server has no agent-host, so it plays that role with a short timer.
 * This keeps the local open path async-shaped (202 STARTING -> GET polls ->
 * READY) exactly like production, so the #138 product UI is verifiable
 * locally. A constant — not inline — so the stand-in delay is visible.
 */
export const DEV_OPEN_READY_DELAY_MS = 3000;

/**
 * Pending READY timers per workspace id (module-level, not per handle — see
 * LoggingWorkspaceRuntimeHandle.open()). Workspace ids are UUIDs, so entries
 * never collide across dev servers sharing this process (tests).
 */
const readyTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearDevReadyTimer(workspaceId: string): void {
  const pending = readyTimers.get(workspaceId);
  if (pending !== undefined) {
    clearTimeout(pending);
    readyTimers.delete(workspaceId);
  }
}

/**
 * Dev stand-in for the production agent-host lease heartbeat
 * (`apps/agent-host/src/lease-heartbeat.ts`: every HEARTBEAT_INTERVAL_MS the
 * host extends the lease it adopted, so the lease stays alive while the
 * Instance runs).
 *
 * The dev server has no agent-host, so without this the lease always lapses
 * LEASE_EXPIRY_MS (45s) after open while the row stays READY — a state
 * production never reaches (the host renews every 15s) but every slow local
 * click-walk does. The interval is the production constant itself, not a
 * copy: same thinking, one source of truth.
 *
 * Lives ONLY in this dev entrypoint: production (main.ts) composes
 * createFetchHandler directly and never imports this module, so this timer
 * can never run in production.
 */
export const DEV_LEASE_HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_MS;

/**
 * Lease heartbeat timers per workspace id (module-level, keyed by workspace
 * id — same reason as readyTimers above: the RuntimeRegistry rebuilds the
 * handle when the lease changes, so a per-handle timer would be orphaned by
 * that rebuild and a later stop() could not reach it).
 */
const leaseHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

function clearDevLeaseHeartbeat(workspaceId: string): void {
  const pending = leaseHeartbeatTimers.get(workspaceId);
  if (pending !== undefined) {
    clearInterval(pending);
    leaseHeartbeatTimers.delete(workspaceId);
  }
}

/** Stops every dev lease heartbeat (process shutdown). */
export function stopAllDevLeaseHeartbeats(): void {
  for (const workspaceId of [...leaseHeartbeatTimers.keys()]) {
    clearDevLeaseHeartbeat(workspaceId);
  }
}

/** Test seam: whether the dev lease heartbeat is currently armed. */
export function isDevLeaseHeartbeatRunning(workspaceId: string): boolean {
  return leaseHeartbeatTimers.has(workspaceId);
}

/**
 * Minimal in-memory runtime handle for local development: open/stop flip the
 * state, agent input is always allowed, and every activity kind is logged so
 * a developer can see what the control plane thinks is happening.
 *
 * Issue #131: open/stop also persist the new state to the workspace row via
 * repo.updateWorkspace, so GET /v1/workspaces/:id (which reads the same row)
 * agrees with the open/stop response — exactly what the production T8
 * runtime does through SqlTransactionalStateStore. Without this the dev
 * server answered open -> READY while the row stayed STOPPED forever.
 */
export class LoggingWorkspaceRuntimeHandle implements WorkspaceRuntimeHandle {
  private state = "STOPPED";
  readonly activities: ActivityKind[] = [];

  constructor(
    private readonly workspaceId: string,
    private readonly repo: SessionPersistenceRepository,
    private readonly leases: ControllerLeaseService,
  ) {}

  /**
   * One heartbeat tick: extend whoever currently holds this workspace's
   * lease — exactly what the production agent-host renews (it extends the
   * adopted lease, never takes a new one). Resolving the holder fresh each
   * tick (instead of a captured controllerId) keeps the meaning identical
   * across re-opens, which may resolve a different lease.
   *
   * Never re-acquires: a lost lease (released, expired, taken over, or gone
   * with a deleted workspace) stops this timer silently. The dev server owns
   * no user identity to acquire with; the next open() acquires fresh for its
   * caller and re-arms the timer via ensureLeaseHeartbeat() below.
   */
  private async tickDevLeaseHeartbeat(): Promise<void> {
    const current = await this.leases.getActive(this.workspaceId);
    if (!current) {
      clearDevLeaseHeartbeat(this.workspaceId);
      console.log(`[dev] workspace ${this.workspaceId}: lease heartbeat stopped (no active lease)`);
      return;
    }
    try {
      await this.leases.heartbeat(this.workspaceId, current.controllerId);
    } catch (e) {
      clearDevLeaseHeartbeat(this.workspaceId);
      console.log(
        `[dev] workspace ${this.workspaceId}: lease heartbeat stopped (renewal failed: ${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  /** Arms the heartbeat for this workspace unless already armed (idempotent). */
  private ensureLeaseHeartbeat(): void {
    if (leaseHeartbeatTimers.has(this.workspaceId)) return;
    const timer = setInterval(() => {
      void this.tickDevLeaseHeartbeat().catch((e) => {
        console.log(
          `[dev] workspace ${this.workspaceId}: lease heartbeat tick failed: ${String(e)}`,
        );
      });
    }, DEV_LEASE_HEARTBEAT_INTERVAL_MS);
    // Unref'd so a forgotten timer can never keep the dev process (or a test
    // runner) alive — same rule as the agent-host's systemIntervalScheduler.
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
    leaseHeartbeatTimers.set(this.workspaceId, timer);
  }

  async open(): Promise<string> {
    // Issue #136: answer STARTING now and become READY on a timer, standing
    // in for the production agent-host (see DEV_OPEN_READY_DELAY_MS).
    //
    // Two idempotency guards keep the stand-in honest:
    // - a re-open of an already-READY row is a no-op (mirrors the production
    //   WorkspaceRuntime.open() idempotency that handlers answer with 200 —
    //   without this the dev server flapped READY -> STARTING -> READY);
    // - timers live in a module-level map keyed by workspace id (not on the
    //   handle): the RuntimeRegistry rebuilds the handle when the lease
    //   changes, and a per-handle timer would be orphaned by that rebuild —
    //   a later stop() would clear only the new handle's (empty) timer while
    //   the orphan still flips the STOPPED row to READY behind our back.
    clearDevReadyTimer(this.workspaceId);
    const current = await this.repo.getWorkspace(this.workspaceId);
    if (current?.runtimeState === "READY") {
      this.state = "READY";
      // Idempotent no-op, but the heartbeat must keep running: the lease the
      // opener holds still needs its dev stand-in renewal.
      this.ensureLeaseHeartbeat();
      return this.state;
    }
    await this.repo.updateWorkspace(this.workspaceId, { runtimeState: "STARTING" });
    this.state = "STARTING";
    console.log(`[dev] workspace ${this.workspaceId}: open -> STARTING (READY in ~${DEV_OPEN_READY_DELAY_MS}ms)`);
    const timer = setTimeout(() => {
      readyTimers.delete(this.workspaceId);
      void this.repo
        .updateWorkspace(this.workspaceId, { runtimeState: "READY" })
        .then(() => {
          this.state = "READY";
          console.log(`[dev] workspace ${this.workspaceId}: STARTING -> READY`);
        })
        .catch((e) => {
          console.log(`[dev] workspace ${this.workspaceId}: READY transition failed: ${String(e)}`);
        });
    }, DEV_OPEN_READY_DELAY_MS);
    readyTimers.set(this.workspaceId, timer);
    // The workspace is running now: stand in for the agent-host heartbeat so
    // the lease outlives LEASE_EXPIRY_MS exactly like production.
    this.ensureLeaseHeartbeat();
    return this.state;
  }

  async stop(): Promise<string> {
    clearDevReadyTimer(this.workspaceId);
    // A stopped workspace has no agent-host, so there is nothing left to
    // renew — same rule as the production loop's isStopped self-stop.
    clearDevLeaseHeartbeat(this.workspaceId);
    await this.repo.updateWorkspace(this.workspaceId, { runtimeState: "STOPPED" });
    this.state = "STOPPED";
    console.log(`[dev] workspace ${this.workspaceId}: stop -> STOPPED`);
    return this.state;
  }

  getState(): string {
    return this.state;
  }

  recordActivity(kind: ActivityKind): void {
    this.activities.push(kind);
    console.log(`[dev] workspace ${this.workspaceId}: activity ${kind}`);
  }

  async assertAgentInputAllowed(): Promise<void> {
    // Local dev: always allowed when the workspace is open.
  }

  async runManualCheckpoint(): Promise<{ skipped: boolean }> {
    this.recordActivity("checkpoint");
    // Local dev has no agent-host to consult, so there is never a
    // clean-tree skip to report (issue #89).
    return { skipped: false };
  }

  async deleteInstance(): Promise<void> {
    // Local dev never creates a real Instance — nothing to delete.
    console.log(`[dev] workspace ${this.workspaceId}: deleteInstance -> no-op`);
  }

  async getInstanceUrl(): Promise<string | null> {
    // Local dev never creates a real Instance — there is no URL to forward to.
    return null;
  }
}

/** Builds the in-memory dependency composition used by the dev server. */
export function createDevControlPlaneDeps(): ControlPlaneDeps {
  const repo = new PostgresSessionPersistenceRepository(new InMemoryFakeExecutor());
  const leases = new ControllerLeaseService({
    store: new InMemoryLeaseStore(),
    clock: new SystemClock(),
  });
  const membership = new InMemoryMembershipStore();
  const runtimes = new RuntimeRegistry((workspace: Workspace) => {
    console.log(`[dev] creating runtime handle for workspace ${workspace.id}`);
    return new LoggingWorkspaceRuntimeHandle(workspace.id, repo, leases);
  });

  return createControlPlaneDeps({
    repo,
    leases,
    membership,
    runtimes,
    clock: new SystemClock(),
  });
}

/**
 * Dev-only fake IAP (issue #138).
 *
 * In production IAP always injects `x-goog-authenticated-user-id` /
 * `x-goog-authenticated-user-email` before the container, so the browser
 * sends nothing. The local dev server has no IAP, and the product UI
 * (`/app`) deliberately has no header input box (showing IAP internals to
 * users would defeat its "no open / lease words" acceptance rule), so the
 * dev server injects a default development identity when — and only when —
 * the request carries NEITHER header. Any explicit header disables the
 * injection for that request, so the debug UI's per-user switching keeps
 * working untouched.
 *
 * Lives ONLY in this dev entrypoint: production (main.ts) composes
 * createFetchHandler directly and never imports this module.
 */
export const DEV_FAKE_IAP_USER_ID_HEADER = "accounts.google.com:dev";
export const DEV_FAKE_IAP_USER_EMAIL_HEADER = "dev@example.com";

/** `DSH_DEV_FAKE_IAP=0` (also `false` / `no`) disables the fake IAP. Default: enabled. */
export function isDevFakeIapEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env["DSH_DEV_FAKE_IAP"];
  if (raw === undefined) return true;
  const lowered = raw.trim().toLowerCase();
  return lowered !== "0" && lowered !== "false" && lowered !== "no";
}

/**
 * Dev fetch handler: the production handler wrapped with fake-IAP header
 * injection. Same routing, same auth order (static before auth), same
 * idleTimeout as startControlPlane — the only difference is the default
 * identity for headerless browser navigations and fetches.
 */
export function createDevFetchHandler(
  deps: ControlPlaneDeps,
): (request: Request) => Promise<Response> {
  const base = createFetchHandler(deps);
  return (request: Request): Promise<Response> => {
    if (
      isDevFakeIapEnabled() &&
      !request.headers.get("x-goog-authenticated-user-id") &&
      !request.headers.get("x-goog-authenticated-user-email")
    ) {
      const headers = new Headers(request.headers);
      headers.set("x-goog-authenticated-user-id", DEV_FAKE_IAP_USER_ID_HEADER);
      headers.set("x-goog-authenticated-user-email", DEV_FAKE_IAP_USER_EMAIL_HEADER);
      request = new Request(request, { headers });
    }
    return base(request);
  };
}

/** Starts the dev server: production socket options, dev fetch handler. */
export function startDevControlPlane(deps: ControlPlaneDeps, port: number): RunningControlPlane {
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port,
    idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
    fetch: createDevFetchHandler(deps),
  });
  return {
    port: server.port as number,
    stop: () => server.stop(true),
  };
}

function main(): void {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[dev] invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }
  const deps = createDevControlPlaneDeps();
  const server = startDevControlPlane(deps, port);
  const url = `http://127.0.0.1:${server.port}`;
  console.log(`[dev] control plane listening on ${url}`);
  if (isDevFakeIapEnabled()) {
    console.log(
      `[dev] fake IAP enabled: requests without IAP headers run as ${DEV_FAKE_IAP_USER_EMAIL_HEADER} ` +
        `(explicit headers still win; disable with DSH_DEV_FAKE_IAP=0)`,
    );
  } else {
    console.log("[dev] fake IAP disabled (DSH_DEV_FAKE_IAP=0): requests without IAP headers get 401");
  }
  console.log("[dev] IAP headers: x-goog-authenticated-user-id / x-goog-authenticated-user-email");
  console.log(`[dev] e.g. curl -H 'x-goog-authenticated-user-id: accounts.google.com:me' \\`);
  console.log(`[dev]        -H 'x-goog-authenticated-user-email: me@example.com' ${url}/livez`);
  console.log("[dev] See docs/local-development.md for a full walkthrough. Ctrl-C to stop.");

  process.on("SIGINT", () => {
    console.log("\n[dev] shutting down");
    stopAllDevLeaseHeartbeats();
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopAllDevLeaseHeartbeats();
    server.stop();
    process.exit(0);
  });
}

if (import.meta.main) {
  main();
}
