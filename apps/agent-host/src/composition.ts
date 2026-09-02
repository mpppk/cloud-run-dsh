// Agent Host composition root (実装手順書 section 7).
//
// Every collaborator is injected through AgentHostDependencies — there are no
// module-level singletons and nothing reaches for process.env here. The only
// place env vars are read is `readAgentHostConfig` in config.ts, called by the
// entrypoint (index.ts) before composition.

import type {
  CheckpointStorage,
  Clock,
  FileSystem,
  GitRunner,
} from "@cloud-run-dsh/workspace-checkpoint";
import {
  CheckpointScheduler,
  SystemClock,
} from "@cloud-run-dsh/workspace-checkpoint";
import type { InstanceRuntime } from "@cloud-run-dsh/cloud-run-instance-client";
import { createSandboxManager } from "@cloud-run-dsh/cloud-run-sandbox";
import type { SandboxCliRunner, SandboxManager } from "@cloud-run-dsh/cloud-run-sandbox";
import { ControllerLeaseService } from "@cloud-run-dsh/controller-lease";
import type { ControllerLeaseService as ControllerLeaseServiceT, LeaseStore } from "@cloud-run-dsh/controller-lease";
import { createGitHubCredentialBroker } from "@cloud-run-dsh/github-credential-broker";
import type {
  GitHubCredentialBroker,
  HttpTransport,
  SecretProvider,
} from "@cloud-run-dsh/github-credential-broker";
import type { Logger, Metrics } from "@cloud-run-dsh/observability";
import { createLogger, NoOpMetrics } from "@cloud-run-dsh/observability";
import type { SessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import type { TransactionalStateStore } from "@cloud-run-dsh/workspace-runtime";
import { IdleManager, WorkspaceRuntime } from "@cloud-run-dsh/workspace-runtime";
import type { AgentHostConfig } from "./config.js";
import { createGuardedSandboxManager } from "./guard.js";
import type { HarnessComposition } from "./harness.js";
import { createFakeHarnessComposition } from "./harness.js";
import { CheckpointCoordinator, WorkspaceBootstrapper } from "./bootstrap.js";
import { buildLifecycleSteps, RestartRecovery } from "./recovery.js";
import type { RecoveryResult } from "./recovery.js";
import { HealthService } from "./health.js";
import { LeaseHeartbeatLoop } from "./lease-heartbeat.js";
import type { IntervalScheduler } from "./lease-heartbeat.js";
import type { AgentGatewayDeps } from "./gateway.js";
import { AgentGateway } from "./gateway.js";

export interface AgentHostDependencies {
  readonly config: AgentHostConfig;
  /** Real: ExecGitRunner. Test: recorded fake. */
  readonly git: GitRunner;
  /** Real: NodeFileSystem. Test: in-memory fake. */
  readonly fs: FileSystem;
  /** Real: GcsCheckpointStorage over FetchGcsClient. Test: InMemoryCheckpointStorage. */
  readonly checkpointStorage: CheckpointStorage;
  /** Real: PostgresSessionPersistenceRepository. Test: fake executor-backed repository. */
  readonly repository: SessionPersistenceRepository;
  /** Real: CloudRunInstanceClient. Test: fake InstanceRuntime. */
  readonly instanceRuntime: InstanceRuntime;
  /** Real: ExecSandboxCliRunner over the Cloud Run-provided sandbox CLI. Test: fake runner. */
  readonly sandboxRunner: SandboxCliRunner;
  /** Real: env-backed secret provider (host-only). Test: fixture provider. */
  readonly secretProvider: SecretProvider;
  /** Real: fetch-based transport. Test: canned transport. */
  readonly brokerTransport: HttpTransport;
  /** Real: BunSqlLeaseStore. Test: InMemoryLeaseStore (from ./testing). */
  readonly leaseStore: LeaseStore;
  /**
   * Interval scheduler driving the controller-lease heartbeat loop.
   * Real: unref'd setInterval. Test: fake-clock-bound scheduler so renewals
   * can be driven by advancing the injected clock (review BLOCKER fix).
   */
  readonly heartbeatScheduler?: IntervalScheduler;
  /** Real: persistent TransactionalStateStore. Test: InMemoryTransactionalStore. */
  readonly stateStore: TransactionalStateStore;
  /** Optional: DeepSeek Harness composition. Defaults to the fake (see harness.ts TODO). */
  readonly harness?: HarnessComposition;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
}

export interface AgentHost {
  readonly config: AgentHostConfig;
  readonly harness: HarnessComposition;
  readonly broker: GitHubCredentialBroker;
  readonly sandboxManager: SandboxManager;
  readonly bootstrapper: WorkspaceBootstrapper;
  readonly checkpointCoordinator: CheckpointCoordinator;
  readonly checkpointScheduler: CheckpointScheduler;
  readonly lease: ControllerLeaseServiceT;
  readonly idle: IdleManager;
  readonly runtime: WorkspaceRuntime;
  readonly health: HealthService;
  readonly recovery: RestartRecovery;
  /**
   * Controller-lease renewal loop. Started automatically by `recover()`
   * (after the lease is acquired), stopped on graceful stop, and self-terminating
   * once the runtime reaches STOPPED.
   */
  readonly leaseHeartbeat: LeaseHeartbeatLoop;
  readonly gateway: AgentGateway;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Runs the restart recovery path (実装手順書 section 30). */
  recover(): Promise<RecoveryResult>;
  /** Stops the lease renewal loop (invoked on graceful stop / shutdown). */
  stopLeaseHeartbeat(): void;
}

export function composeAgentHost(deps: AgentHostDependencies): AgentHost {
  const { config } = deps;
  const clock = deps.clock ?? new SystemClock();
  const logger = deps.logger ?? createLogger({ defaultFields: { workspaceId: config.workspaceId } });
  const metrics = deps.metrics ?? new NoOpMetrics();
  const harness = deps.harness ?? createFakeHarnessComposition(config.workspaceRoot);

  // GitHub Credential Broker (T7) — host-only secrets via injected provider.
  const broker = createGitHubCredentialBroker({
    secretProvider: deps.secretProvider,
    transport: deps.brokerTransport,
  });

  // SandboxManager (T3) behind the host exec guard (仕様書 section 26).
  const sandboxManager = createGuardedSandboxManager(
    createSandboxManager({ workspaceId: config.workspaceId, runner: deps.sandboxRunner }),
    { workspaceRoot: config.workspaceRoot },
  );

  // Workspace bootstrap (実装手順書 section 19) + checkpoint coordination (T5).
  const bootstrapper = new WorkspaceBootstrapper({
    workspaceId: config.workspaceId,
    workspaceDir: config.workspaceRoot,
    repository: { owner: config.repositoryOwner, name: config.repositoryName },
    baseBranch: config.baseBranch,
    checkpointKey: config.checkpointKey,
    broker,
    storage: deps.checkpointStorage,
    git: deps.git,
    fs: deps.fs,
  });
  const checkpointCoordinator = new CheckpointCoordinator({
    workspaceDir: config.workspaceRoot,
    checkpointKey: config.checkpointKey,
    storage: deps.checkpointStorage,
    git: deps.git,
    fs: deps.fs,
    clock,
  });
  const checkpointScheduler = new CheckpointScheduler({
    clock,
    git: deps.git,
    workspaceDir: config.workspaceRoot,
    checkpointFn: () => checkpointCoordinator.create().then(() => undefined),
  });

  // Controller lease (T6) — single writer per workspace.
  const lease = new ControllerLeaseService({ store: deps.leaseStore, clock });

  // Idle manager (T8) + workspace runtime (T8) with host lifecycle steps.
  const idle = new IdleManager(clock);
  const runtime = new WorkspaceRuntime({
    workspaceId: config.workspaceId,
    store: deps.stateStore,
    clock,
    instanceRuntime: deps.instanceRuntime,
    instanceName: config.instanceName,
    steps: buildLifecycleSteps({
      config,
      instanceRuntime: deps.instanceRuntime,
      bootstrapper,
      checkpointScheduler,
      sandboxManager,
      harness,
      repository: deps.repository,
    }),
    idle,
  });

  const health = new HealthService(config.workspaceId);
  const recovery = new RestartRecovery({
    config,
    clock,
    repository: deps.repository,
    runtime,
    lease,
    bootstrapper,
    health,
    logger,
    metrics,
  });

  const gatewayDeps: AgentGatewayDeps = { config, health, runtime, lease, logger };
  const gateway = new AgentGateway(gatewayDeps);

  // Controller-lease renewal loop (review BLOCKER fix): without it the 45s
  // lease expires and the gateway 409s every request permanently. Driven by
  // the injected scheduler; fails health + re-acquires on lease loss.
  const leaseHeartbeat = new LeaseHeartbeatLoop({
    lease,
    workspaceId: config.workspaceId,
    controllerId: config.controllerId,
    userId: config.userId,
    scheduler: deps.heartbeatScheduler,
    health,
    logger,
    onLeaseRegained: () => {
      // Only report healthy again if the workspace actually is (the loop
      // must never un-fail health for a workspace that is not READY).
      if (runtime.getState() === "READY") health.setReady();
    },
    // Self-termination: a gracefully stopped host must not keep renewing
    // (nor be kept alive by) the heartbeat loop.
    isStopped: () => runtime.getState() === "STOPPED",
  });

  // The graceful stop (runtime.stop) ends the renewal loop immediately — the
  // next-tick STOPPED check is only a backstop.
  const runtimeStopBound = runtime.stop.bind(runtime);
  runtime.stop = async () => {
    leaseHeartbeat.stop();
    return runtimeStopBound();
  };

  return {
    config,
    harness,
    broker,
    sandboxManager,
    bootstrapper,
    checkpointCoordinator,
    checkpointScheduler,
    lease,
    idle,
    runtime,
    health,
    recovery,
    leaseHeartbeat,
    gateway,
    logger,
    metrics,
    recover: async () => {
      const result = await recovery.recover();
      // The lease is held — start renewing it for as long as the host lives.
      leaseHeartbeat.start();
      return result;
    },
    stopLeaseHeartbeat: () => leaseHeartbeat.stop(),
  };
}
