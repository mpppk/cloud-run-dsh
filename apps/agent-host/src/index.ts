// Agent Host entrypoint. Reads the environment ONCE at the composition root,
// composes all collaborators, runs the restart recovery path (実装手順書
// section 30 — the normal path), and serves the Agent Gateway on 0.0.0.0:$PORT.

import { CloudRunInstanceClient } from "@cloud-run-dsh/cloud-run-instance-client";
import { composeAgentHost } from "./composition.js";
import type { AgentHostDependencies } from "./composition.js";
import { readAgentHostConfig } from "./config.js";
import { createHarnessComposition } from "./harness-real.js";
import {
  BunSqlLeaseStore,
  BunSqlQueryExecutor,
  ExecGitRunner,
  ExecSandboxCliRunner,
  FetchGcsClient,
  NodeFileSystem,
  SqlTransactionalStateStore,
  createCheckpointStorage,
  createEnvSecretProvider,
  createSessionRepository,
  envGcsTokenProvider,
  fetchHttpTransport,
  instanceHttpTransport,
} from "./adapters.js";

export async function createProductionDependencies(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AgentHostDependencies> {
  const config = readAgentHostConfig(env);

  const gcsClient = new FetchGcsClient({ tokenProvider: envGcsTokenProvider(env) });
  const executor = await BunSqlQueryExecutor.connect(config.databaseUrl);
  const repository = await createSessionRepository(config.databaseUrl);

  return {
    config,
    git: new ExecGitRunner(),
    fs: new NodeFileSystem(),
    checkpointStorage: createCheckpointStorage(gcsClient, config.checkpointBucket),
    repository,
    instanceRuntime: new CloudRunInstanceClient({
      transport: instanceHttpTransport,
      basePath: `projects/${config.gcpProjectId}/locations/${config.gcpRegion}`,
    }),
    sandboxRunner: new ExecSandboxCliRunner(config.sandboxCliPath),
    secretProvider: createEnvSecretProvider(env),
    brokerTransport: fetchHttpTransport,
    leaseStore: new BunSqlLeaseStore(executor),
    stateStore: new SqlTransactionalStateStore(executor),
    // Real DeepSeek Harness composition (実装手順書 section 10): fs-sandbox +
    // fs-observation-policy + tool-fs + tool-fs-search, workspace-write on
    // config.workspaceRoot.
    harness: await createHarnessComposition(config.workspaceRoot),
  };
}

export async function main(): Promise<void> {
  const deps = await createProductionDependencies();
  const host = composeAgentHost(deps);

  await host.recover();

  const server = Bun.serve({
    port: host.config.port,
    hostname: "0.0.0.0",
    fetch: (request) => host.gateway.handle(request),
  });
  host.logger.info("agent.host.listening", { event_detail: `port=${server.port}` });

  // Periodic checkpoint + idle polling (実装手順書 sections 21/28).
  host.checkpointScheduler.startPeriodic();
  host.runtime.startIdlePolling(60_000, () => {
    host.checkpointScheduler.stopPeriodic();
    // Graceful stop: the lease loop must not outlive the stopped host
    // (the loop also self-terminates on the next tick via the STOPPED check).
    host.stopLeaseHeartbeat();
    void server.stop(true);
  });
}

if (import.meta.main) {
  await main();
}
