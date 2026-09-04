// Test fakes shared by agent-host unit tests and tests/security.
// Not exported from the package entrypoint.

import type {
  Clock,
  FileSystem,
  GitResult,
  GitRunner,
} from "@cloud-run-dsh/workspace-checkpoint";
import type {
  InstanceInfo,
  InstanceRuntime,
  Workspace,
} from "@cloud-run-dsh/cloud-run-instance-client";
import type {
  SandboxCliResult,
  SandboxCliRunner,
} from "@cloud-run-dsh/cloud-run-sandbox";
import type {
  HttpTransport,
  HttpRequest,
  HttpResponse,
  Repository,
  SecretProvider,
} from "@cloud-run-dsh/github-credential-broker";
import type { AgentHostConfig } from "./config.js";
import { defaultCheckpointKey } from "./config.js";

export class FakeClock implements Clock {
  private currentMs: number;
  private advanceListeners: Array<() => void> = [];
  constructor(initialMs = 1_000_000_000_000) {
    this.currentMs = initialMs;
  }
  now(): Date {
    return new Date(this.currentMs);
  }
  nowMs(): number {
    return this.currentMs;
  }
  advance(ms: number): void {
    this.currentMs += ms;
    // Notify bound schedulers so interval callbacks fire in fake time.
    for (const listener of [...this.advanceListeners]) listener();
  }
  /** Registers a callback invoked after every advance (test wiring only). */
  onAdvance(listener: () => void): () => void {
    this.advanceListeners.push(listener);
    return () => {
      this.advanceListeners = this.advanceListeners.filter((l) => l !== listener);
    };
  }
}

/**
 * Interval scheduler bound to a FakeClock: intervals fire when the clock
 * advances past their scheduled time, so tests drive lease renewals by
 * advancing fake time instead of waiting on wall time.
 */
export class FakeIntervalScheduler {
  private jobs: Array<{
    fn: () => void;
    everyMs: number;
    nextAtMs: number;
    cancelled: boolean;
  }> = [];
  private readonly detach: () => void;

  constructor(private readonly clock: FakeClock) {
    this.detach = clock.onAdvance(() => this.fireDue());
  }

  start(fn: () => void, intervalMs: number): { cancel(): void } {
    const job = {
      fn,
      everyMs: intervalMs,
      nextAtMs: this.clock.nowMs() + intervalMs,
      cancelled: false,
    };
    this.jobs.push(job);
    return {
      cancel: () => {
        job.cancelled = true;
      },
    };
  }

  private get nowMs(): number {
    return this.clock.nowMs();
  }

  /** Fires every non-cancelled job whose scheduled time has passed. */
  private fireDue(): void {
    // Loop until no job is due: callbacks may schedule/advance internally.
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const job of this.jobs) {
        if (job.cancelled) continue;
        if (job.nextAtMs <= this.nowMs) {
          job.nextAtMs += job.everyMs;
          job.fn();
          progressed = true;
        }
      }
    }
  }

  /** Stops reacting to clock advances (test teardown). */
  dispose(): void {
    this.detach();
  }
}

export class InMemoryFs implements FileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly writes: { path: string; data: Uint8Array }[] = [];

  async readFile(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT: ${path}`);
    return new Uint8Array(data);
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, new Uint8Array(data));
    this.writes.push({ path, data: new Uint8Array(data) });
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
  async mkdir(path: string): Promise<void> {
    this.files.set(path, new Uint8Array(0));
  }
}

export interface RecordedGitCall {
  readonly args: readonly string[];
  readonly cwd?: string;
}

export class RecordingGitRunner implements GitRunner {
  readonly calls: RecordedGitCall[] = [];
  /** Override responses keyed by the first git argument. */
  readonly responses = new Map<string, GitResult>();

  run(args: readonly string[], opts?: { cwd?: string }): Promise<GitResult> {
    this.calls.push({ args, cwd: opts?.cwd });
    const result = this.responses.get(args[0] ?? "");
    return Promise.resolve(
      result ?? { exitCode: 0, stdout: "", stderr: "" },
    );
  }
}

export class FakeSandboxCliRunner implements SandboxCliRunner {
  readonly recorded: string[][] = [];
  nextResult: SandboxCliResult = { exitCode: 0, stdout: "", stderr: "" };

  async run(
    argv: readonly string[],
    _opts?: { stdin?: string | Uint8Array },
  ): Promise<SandboxCliResult> {
    this.recorded.push([...argv]);
    return this.nextResult;
  }
}

export class FakeInstanceRuntime implements InstanceRuntime {
  state = "READY";
  readonly calls: string[] = [];

  async create(workspace: Workspace): Promise<InstanceInfo> {
    this.calls.push(`create:${workspace.id}`);
    return { name: "fake-instance", state: this.state };
  }
  async start(instanceName: string): Promise<void> {
    this.calls.push(`start:${instanceName}`);
  }
  async stop(instanceName: string): Promise<void> {
    this.calls.push(`stop:${instanceName}`);
  }
  async get(instanceName: string): Promise<InstanceInfo> {
    this.calls.push(`get:${instanceName}`);
    return { name: instanceName, state: this.state };
  }
  async delete(instanceName: string): Promise<void> {
    this.calls.push(`delete:${instanceName}`);
  }
}

export const FAKE_INSTALLATION_TOKEN = "ghs_faketoken0000000000000000000000000000";

import { generateKeyPairSync } from "node:crypto";

// A real (throwaway) RSA key so the broker's RS256 JWT signing works in tests.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export const FAKE_PRIVATE_KEY_PEM = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

/** GitHub API transport handing out the fake installation token. */
export function fakeBrokerTransport(
  repo: Repository,
  token: string = FAKE_INSTALLATION_TOKEN,
): HttpTransport {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    if (req.method === "GET" && req.url.endsWith(`/repos/${repo.owner}/${repo.name}/installation`)) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: 42 }),
      };
    }
    if (req.method === "POST" && req.url.includes("/app/installations/42/access_tokens")) {
      return {
        status: 201,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      };
    }
    return { status: 404, headers: {}, body: "{}" };
  };
}

export function fakeSecretProvider(
  appId = "123456",
  privateKeyPem = FAKE_PRIVATE_KEY_PEM,
): SecretProvider {
  let calls = 0;
  return async () => {
    calls += 1;
    return { appId, privateKeyPem };
  };
}

export function makeConfig(overrides: Partial<AgentHostConfig> = {}): AgentHostConfig {
  return {
    workspaceId: "ws-1",
    port: 8080,
    workspaceRoot: "/workspace",
    checkpointBucket: "fake-checkpoints",
    checkpointKey: defaultCheckpointKey("ws-1"),
    databaseUrl: "postgres://fake",
    githubAppId: "123456",
    githubAppPrivateKeyPem: FAKE_PRIVATE_KEY_PEM,
    repositoryOwner: "mpppk",
    repositoryName: "cloud-run-dsh",
    baseBranch: "main",
    controllerId: "ctrl-1",
    userId: "user-1",
    instanceName: "dsh-ws-1",
    gcpProjectId: "fake-project",
    gcpRegion: "us-central1",
    sandboxCliPath: "/usr/local/gcp/bin/sandbox",
    allowEgress: true,
    llmBaseUrl: "https://openrouter.ai/api/v1",
    llmApiKeyEnv: "OPENROUTER_API_KEY",
    llmModel: "deepseek/deepseek-v4-flash",
    llmApprovalPolicy: "ask",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Composed test host
// ---------------------------------------------------------------------------

import { InMemoryCheckpointStorage } from "@cloud-run-dsh/workspace-checkpoint";
import { InMemoryLeaseStore } from "@cloud-run-dsh/controller-lease/testing";
import { InMemoryTransactionalStore } from "@cloud-run-dsh/workspace-runtime";
import { PostgresSessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import type { Logger } from "@cloud-run-dsh/observability";
import { composeAgentHost } from "./composition.js";
import type { AgentHost } from "./composition.js";
import type { TurnStarter } from "./gateway.js";

export interface TestHost {
  readonly host: AgentHost;
  readonly git: RecordingGitRunner;
  readonly fs: InMemoryFs;
  readonly storage: InMemoryCheckpointStorage;
  readonly sandboxRunner: FakeSandboxCliRunner;
  readonly instance: FakeInstanceRuntime;
  readonly leaseStore: InMemoryLeaseStore;
  readonly executor: InMemoryFakeExecutor;
  readonly repository: PostgresSessionPersistenceRepository;
  readonly clock: FakeClock;
  /** Interval scheduler bound to the fake clock (drives lease heartbeats). */
  readonly scheduler: FakeIntervalScheduler;
}

export async function composeTestHost(
  configOverrides: Partial<AgentHostConfig> = {},
  extra: { turnStarter?: TurnStarter; logger?: Logger; repository?: PostgresSessionPersistenceRepository } = {},
): Promise<TestHost> {
  const clock = new FakeClock();
  const git = new RecordingGitRunner();
  const fs = new InMemoryFs();
  const storage = new InMemoryCheckpointStorage();
  const sandboxRunner = new FakeSandboxCliRunner();
  const instance = new FakeInstanceRuntime();
  const leaseStore = new InMemoryLeaseStore();
  const executor = new InMemoryFakeExecutor();
  const repository = extra.repository ?? new PostgresSessionPersistenceRepository(executor);
  const config = makeConfig(configOverrides);
  const scheduler = new FakeIntervalScheduler(clock);

  const host = composeAgentHost({
    config,
    git,
    fs,
    checkpointStorage: storage,
    repository,
    instanceRuntime: instance,
    sandboxRunner,
    secretProvider: fakeSecretProvider(),
    brokerTransport: fakeBrokerTransport({
      owner: config.repositoryOwner,
      name: config.repositoryName,
    }),
    leaseStore,
    stateStore: new InMemoryTransactionalStore({}, clock),
    clock,
    heartbeatScheduler: scheduler,
    turnStarter: extra.turnStarter,
    logger: extra.logger,
  });

  return { host, git, fs, storage, sandboxRunner, instance, leaseStore, executor, repository, clock, scheduler };
}

export async function seedWorkspace(th: TestHost): Promise<void> {
  const config = th.host.config;
  await th.repository.createWorkspace({
    id: config.workspaceId,
    ownerId: config.userId,
    repositoryOwner: config.repositoryOwner,
    repositoryName: config.repositoryName,
    baseBranch: config.baseBranch,
    instanceName: config.instanceName,
  });
}
