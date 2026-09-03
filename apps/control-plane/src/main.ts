// Control Plane production entrypoint (T9, 実装手順書 section 24).
//
// Composes the real Postgres-backed dependencies (session persistence,
// controller leases, owner-based membership) and serves the HTTP surface on
// 0.0.0.0:$PORT (Cloud Run injects PORT).
//
// KNOWN LIMITATION (P11a): the production RuntimeRegistry is a placeholder —
// workspace runtime operations (open/stop/checkpoint/agent input) fail fast
// with RuntimeNotWiredError until the T8 composition (Cloud Run instance
// client + checkpoint storage + GCS) is wired. The server starts, /healthz is
// live, and /readyz reports NOT ready with the reason, so a deployment of
// this image cannot be mistaken for a fully functional control plane.
//
// Run with: bun run apps/control-plane/src/main.ts (see apps/control-plane/README.md)

import { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import { PostgresSessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import { createControlPlaneDeps, startControlPlane, SystemClock } from "./index.js";
import { readControlPlaneConfig } from "./config.js";
import {
  BunSqlLeaseStore,
  BunSqlQueryExecutor,
  createPlaceholderRuntimeRegistry,
  OwnerMembershipStore,
} from "./prod-adapters.js";

async function main(): Promise<void> {
  const config = readControlPlaneConfig();

  const executor = await BunSqlQueryExecutor.connect(config.databaseUrl);
  const deps = createControlPlaneDeps({
    repo: new PostgresSessionPersistenceRepository(executor),
    leases: new ControllerLeaseService({
      // NOTE: the two-method SystemClock from deps.ts is REQUIRED here — the
      // T6 one-method `systemClock` compiles but throws
      // "clock.nowMs is not a function" inside the runtime (see deps.ts).
      store: new BunSqlLeaseStore(executor),
      clock: new SystemClock(),
    }),
    membership: new OwnerMembershipStore(executor),
    runtimes: createPlaceholderRuntimeRegistry(),
    clock: new SystemClock(),
    readiness: () => ({
      ready: false,
      reason:
        "workspace runtime operations are unavailable: " +
        "the production RuntimeRegistry is a placeholder (P11a will wire the " +
        "Cloud Run instance client, checkpoint storage and GCS collaborators)",
    }),
  });

  // Startup WARN so an operator reading container logs sees immediately that
  // runtime operations are unavailable in this image.
  console.warn(
    `[control-plane] WARN: runtime operations are unavailable: RuntimeRegistry is a placeholder ` +
      `(RuntimeNotWiredError on open/stop/checkpoint; P11a wires the full T8 composition)`,
  );

  const server = startControlPlane(deps, config.port);
  console.log(`[control-plane] listening on 0.0.0.0:${server.port} (DATABASE_URL configured)`);

  const shutdown = (signal: string): void => {
    console.log(`[control-plane] ${signal} received; shutting down`);
    server.stop();
    void executor.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
  await main();
}
