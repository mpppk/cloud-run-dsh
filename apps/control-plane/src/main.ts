// Control Plane production entrypoint (T9, 実装手順書 section 24).
//
// Composes the real Postgres-backed dependencies (session persistence,
// controller leases, owner-based membership) plus the production T8
// WorkspaceRuntime composition (Cloud Run instance client over the
// authenticated Instances API transport, SQL state store, GCS checkpoint
// storage) and serves the HTTP surface on 0.0.0.0:$PORT (Cloud Run injects
// PORT).
//
// Run with: bun run apps/control-plane/src/main.ts (see apps/control-plane/README.md)

import { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import { createLogger } from "@cloud-run-dsh/observability";
import { PostgresSessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import { createControlPlaneDeps, startControlPlane, SystemClock } from "./index.js";
import { readControlPlaneConfig } from "./config.js";
import {
  BunSqlLeaseStore,
  BunSqlQueryExecutor,
  FetchGcsClient,
  SqlTransactionalStateStore,
  createAuthenticatedInstanceTransport,
  createDbReadinessProbe,
  createGcpAccessTokenProvider,
} from "./prod-adapters.js";
import { HttpAgentHostForwarder, createIdTokenProvider } from "./forwarding.js";
import { OwnerMembershipStore } from "./prod-adapters.js";
import { createProductionRuntimeRegistry } from "./runtime-factory.js";
import { startStoppedInstanceSweeper } from "./instance-gc.js";

async function main(): Promise<void> {
  const config = readControlPlaneConfig();
  // Structured JSON logging via @cloud-run-dsh/observability, same as the
  // agent-host composition root.
  const logger = createLogger();

  const executor = await BunSqlQueryExecutor.connect(config.databaseUrl);
  const repo = new PostgresSessionPersistenceRepository(executor);
  const clock = new SystemClock();
  // Issue #76: the shared metadata → ADC → env chain with caching. The
  // logger records WHICH source minted each token, never the token itself.
  const tokenProvider = createGcpAccessTokenProvider(undefined, undefined, { logger });
  // Issue #68: ONE ID-token provider shared by the #22 forwarder AND the
  // agent-host health poll. Tokens are audience-bound per Instance URL, so
  // sharing one RefreshingIdTokenProvider shares its per-audience cache
  // instead of minting twice per open. The poll needs it because Instances
  // carry invoker IAM — a bare fetch() 401s on every attempt.
  const idTokenProvider = createIdTokenProvider();
  // Issue #72/#75: ONE forwarder shared by the message handlers AND the
  // runtime registry's remote lifecycle steps (stop preparation, manual
  // checkpoint) — a single ID-token/timeout/409-vs-502 implementation.
  // Constructed BEFORE the registry so both sides share it.
  const messageForwarder = new HttpAgentHostForwarder({
    idTokenProvider,
    logger,
  });
  const runtimes = createProductionRuntimeRegistry({
    config,
    repo,
    stateStore: new SqlTransactionalStateStore(executor),
    // NOTE: the two-method SystemClock from deps.ts is REQUIRED here — the
    // T6 one-method `systemClock` compiles but throws
    // "clock.nowMs is not a function" inside the first successful open()
    // (see deps.ts; createProductionRuntimeRegistry re-validates this).
    clock,
    instanceTransport: createAuthenticatedInstanceTransport(tokenProvider),
    gcsClient: new FetchGcsClient({ tokenProvider }),
    idTokenProvider,
    messageForwarder,
  });
  const deps = createControlPlaneDeps({
    repo,
    leases: new ControllerLeaseService({
      store: new BunSqlLeaseStore(executor),
      clock,
    }),
    membership: new OwnerMembershipStore(executor),
    runtimes,
    clock,
    logger,
    // Issue #97: /readyz probes the database for real (short-timeout
    // SELECT 1 + result cache — see createDbReadinessProbe). Before this,
    // no probe was wired, so a deployment that could never reach its
    // database still answered 200 {"status":"ready"} (measured 2026-09-05).
    readiness: createDbReadinessProbe(executor, { logger }),
    // Issue #22: forward appended user_message events to the workspace
    // Instance (ID-token auth for invoker IAM). The forwarder makes
    // postMessage 409 when the Instance has no URL (open first) and 502
    // when the forward fails after the append (never a fake 201).
    messageForwarder,
  });

  logger.info(
    "runtime registry wired: open/stop drive Cloud Run Instances " +
      `in projects/${config.gcpProjectId}/locations/${config.gcpRegion}`,
  );

  const server = startControlPlane(deps, config.port);
  logger.info(`listening on 0.0.0.0:${server.port} (DATABASE_URL configured)`);

  // Issue #85 案A: background GC of stopped-Instance objects. Only deletes
  // the Instances of long-idle STOPPED workspaces (rows + checkpoints stay;
  // the next open() recreates). Interval 0 disables the sweeper; explicit
  // DELETE /v1/workspaces/:id still deletes Instances on demand.
  const sweeper =
    config.instanceGcIntervalMs > 0
      ? startStoppedInstanceSweeper(
          {
            repo,
            runtimes,
            clock,
            logger,
            staleAfterMs: config.instanceGcStaleAfterMs,
          },
          { intervalMs: config.instanceGcIntervalMs },
        )
      : null;
  if (sweeper) {
    logger.info(
      "stopped-instance GC sweeper enabled " +
        `(every ${config.instanceGcIntervalMs}ms, stale after ${config.instanceGcStaleAfterMs}ms)`,
    );
  } else {
    logger.info("stopped-instance GC sweeper disabled (INSTANCE_GC_INTERVAL_MS=0)");
  }

  const shutdown = (signal: string): void => {
    logger.info(`${signal} received; shutting down`);
    sweeper?.stop();
    server.stop();
    void executor.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
  await main();
}
