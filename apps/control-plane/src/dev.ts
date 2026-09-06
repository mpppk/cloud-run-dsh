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

import { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import { InMemoryLeaseStore } from "@cloud-run-dsh/controller-lease/testing";
import { PostgresSessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import type {
  SessionPersistenceRepository,
  Workspace,
} from "@cloud-run-dsh/session-persistence-postgres";
import type { ActivityKind } from "@cloud-run-dsh/workspace-runtime";
import { createControlPlaneDeps, startControlPlane } from "./index.js";
import {
  InMemoryMembershipStore,
  RuntimeRegistry,
  SystemClock,
  type ControlPlaneDeps,
  type WorkspaceRuntimeHandle,
} from "./index.js";

const DEFAULT_PORT = 8787;

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
  ) {}

  async open(): Promise<string> {
    await this.repo.updateWorkspace(this.workspaceId, { runtimeState: "READY" });
    this.state = "READY";
    console.log(`[dev] workspace ${this.workspaceId}: open -> READY`);
    return this.state;
  }

  async stop(): Promise<string> {
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
    return new LoggingWorkspaceRuntimeHandle(workspace.id, repo);
  });

  return createControlPlaneDeps({
    repo,
    leases,
    membership,
    runtimes,
    clock: new SystemClock(),
  });
}

function main(): void {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[dev] invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }
  const deps = createDevControlPlaneDeps();
  const server = startControlPlane(deps, port);
  const url = `http://127.0.0.1:${server.port}`;
  console.log(`[dev] control plane listening on ${url}`);
  console.log("[dev] IAP headers: x-goog-authenticated-user-id / x-goog-authenticated-user-email");
  console.log(`[dev] e.g. curl -H 'x-goog-authenticated-user-id: accounts.google.com:me' \\`);
  console.log(`[dev]        -H 'x-goog-authenticated-user-email: me@example.com' ${url}/livez`);
  console.log("[dev] See docs/local-development.md for a full walkthrough. Ctrl-C to stop.");

  process.on("SIGINT", () => {
    console.log("\n[dev] shutting down");
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop();
    process.exit(0);
  });
}

if (import.meta.main) {
  main();
}
