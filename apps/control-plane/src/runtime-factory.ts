// Production RuntimeRegistry factory — wires the T8 WorkspaceRuntime for the
// control plane (main.ts) so open/stop/checkpoint reach real Cloud Run
// Instances instead of the removed placeholder.
//
// Per-workspace composition (built lazily by the RuntimeRegistry factory):
//   instance client  CloudRunInstanceClient over the injected HttpTransport
//                    (fake transport in tests; authenticated fetch in prod),
//                    constructed PER WORKSPACE because the create env
//                    (WORKSPACE_ID, repo coordinates, controller identity)
//                    differs per workspace.
//   state store      injected TransactionalStateStore (SQL compare-and-set over
//                    workspaces.runtime_state in production).
//   clock            the injected two-method ControlPlaneClock (now + nowMs).
//                    NEVER the T6 one-method systemClock — see below.
//   idle             IdleManager over the same clock.
//   checkpointFn     GCS-backed manual-checkpoint marker (see below).
//
// What the lifecycle steps mean on the control plane (which has no workspace
// files, no git, no sandbox — the image deliberately omits them):
//   waitForInstanceHealth  REAL: polls Instances API GET until READY, then
//                          polls the agent-host /healthz until it reports
//                          ready, and persists workspaces.instance_url.
//   clone/checkout/        NO-OP: executed INSIDE the instance by the
//   restore/sandbox/       agent-host restart recovery (実装手順書 section 30).
//   restoreHarness         The control plane observes their completion via the
//                          agent-host /healthz poll above; READY here means
//                          "instance healthy AND agent-host recovery complete".
//   runLifecycleCheckpoint NO-OP success: durable checkpoints are written
//                          continuously by the agent-host periodic scheduler.
//                          A control-plane-driven remote checkpoint trigger is
//                          follow-up work for #22 (no agent-host endpoint
//                          exists yet to trigger one).
//   flushSessionPersistence NO-OP: session events are append-only at write
//                          time (same rationale as the agent-host steps).
//   deleteSandbox          NO-OP: stopping the Instance discards all of its
//                          local state; no separate sandbox resource exists
//                          from the control-plane side.

import {
  CloudRunInstanceClient,
  InstanceAlreadyExistsError,
  InstanceNotFoundError,
} from "@cloud-run-dsh/cloud-run-instance-client";
import type {
  HttpTransport,
  InstanceInfo,
  InstanceRuntime,
  Workspace as InstanceWorkspace,
} from "@cloud-run-dsh/cloud-run-instance-client";
import { GcsCheckpointStorage } from "@cloud-run-dsh/workspace-checkpoint";
import type { GcsClient } from "@cloud-run-dsh/workspace-checkpoint";
import { IdleManager, WorkspaceRuntime } from "@cloud-run-dsh/workspace-runtime";
import type {
  TransactionalStateStore,
  WorkspaceLifecycleSteps,
} from "@cloud-run-dsh/workspace-runtime";
import type {
  SessionPersistenceRepository,
  Workspace,
} from "@cloud-run-dsh/session-persistence-postgres";
import { RuntimeRegistry, WorkspaceRuntimeHandleAdapter } from "./deps.js";
import type { ControlPlaneClock } from "./deps.js";
import type { ControlPlaneConfig } from "./config.js";

/** Minimal surface used to poll the agent-host /healthz (global fetch in prod). */
export type HealthFetch = (url: string) => Promise<{ ok: boolean; status: number }>;

export interface PollConfig {
  readonly maxAttempts: number;
  readonly intervalMs: number;
}

/** ~2 minutes: Instance create/start cold start budget. */
export const DEFAULT_INSTANCE_POLL: PollConfig = { maxAttempts: 60, intervalMs: 2000 };
/** ~1 minute: agent-host recovery (clone + restore + sandbox) budget once READY. */
export const DEFAULT_AGENT_HEALTH_POLL: PollConfig = { maxAttempts: 30, intervalMs: 2000 };

export interface ProductionRuntimeOptions {
  readonly config: ControlPlaneConfig;
  readonly repo: SessionPersistenceRepository;
  readonly stateStore: TransactionalStateStore;
  /** Two-method clock — validated at construction (see assertTwoMethodClock). */
  readonly clock: ControlPlaneClock;
  /** Instances API transport (fake in tests; authenticated fetch in prod). */
  readonly instanceTransport: HttpTransport;
  /** GCS client behind the checkpoint storage (fake in tests). */
  readonly gcsClient: GcsClient;
  readonly healthFetch?: HealthFetch;
  readonly instancePoll?: PollConfig;
  readonly agentHealthPoll?: PollConfig;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Defaults to crypto.randomUUID() per handle (the agent-host self-acquires on boot). */
  readonly controllerIdForWorkspace?: (workspace: Workspace) => string;
}

/**
 * Construction-time guard for the issue-#23 pitfall: the T6 one-method
 * `systemClock` is structurally assignable where only `now()` is used, so
 * passing it compiles but throws `TypeError: clock.nowMs is not a function`
 * inside the first successful open() (IdleManager.recordActivity). Failing
 * here — with the fix spelled out — turns that runtime cliff into a loud
 * composition error. Covered by a dedicated regression test.
 */
export function assertTwoMethodClock(clock: ControlPlaneClock): void {
  if (typeof (clock as { nowMs?: unknown }).nowMs !== "function") {
    throw new Error(
      "control-plane RuntimeRegistry requires a two-method clock (now() + nowMs()); " +
        "the T6 one-method `systemClock` from @cloud-run-dsh/controller-lease compiles " +
        "but throws `TypeError: clock.nowMs is not a function` inside the first successful open(). " +
        "Pass the deps.ts SystemClock instead (see ControlPlaneClock).",
    );
  }
}

/** Instance name rule — identical to the client's default (`dsh-<workspace-id>`). */
export function defaultInstanceName(workspace: Pick<Workspace, "id" | "instanceName">): string {
  return workspace.instanceName ?? `dsh-${workspace.id}`;
}

/**
 * The 13 agent-host REQUIRED_ENV_KEYS (apps/agent-host/src/config.ts) for one
 * workspace, PLUS the LLM key the agent-host resolves per request via its
 * default LLM_API_KEY_ENV=OPENROUTER_API_KEY (issue #41), PLUS whichever of
 * the optional LLM_BASE_URL / LLM_MODEL / LLM_APPROVAL_POLICY overrides the
 * control plane was configured with (absent = agent-host default applies).
 * The exact key set is asserted in tests — dropping one produces an
 * instance whose agent-host crashes at boot with MissingRequiredEnvError
 * (or whose first turn dies with MISSING_CREDENTIAL for the LLM key), so
 * this list must stay in lockstep with the agent-host config.
 *
 * Fail-fast (#22 "never fake success"): a blank LLM key throws HERE — before
 * any Instances API call — so open() rejects without creating anything.
 * The error names the missing variable only; the key VALUE is never
 * interpolated into it, and this return value is never logged (the only
 * consumer is the Instances API create body; no logger in this module takes
 * it — keep it that way).
 */
export function buildInstanceEnv(
  config: ControlPlaneConfig,
  workspace: Workspace,
  instanceName: string,
  controllerId: string,
): Record<string, string> {
  if (config.openrouterApiKey.trim() === "") {
    throw new Error(
      "cannot build instance env: OPENROUTER_API_KEY is not configured — " +
        "set it on the control plane so created Instances can call the LLM " +
        "(refusing to create a credential-less Instance that would fail its first turn)",
    );
  }
  return {
    WORKSPACE_ID: workspace.id,
    CHECKPOINT_BUCKET: config.checkpointBucket,
    DATABASE_URL: config.agentHostDatabaseUrl,
    GITHUB_APP_ID: config.githubAppId,
    GITHUB_APP_PRIVATE_KEY_PEM: config.githubAppPrivateKeyPem,
    OPENROUTER_API_KEY: config.openrouterApiKey,
    ...(config.llmBaseUrl !== undefined ? { LLM_BASE_URL: config.llmBaseUrl } : {}),
    ...(config.llmModel !== undefined ? { LLM_MODEL: config.llmModel } : {}),
    ...(config.llmApprovalPolicy !== undefined ? { LLM_APPROVAL_POLICY: config.llmApprovalPolicy } : {}),
    REPOSITORY_OWNER: workspace.repositoryOwner,
    REPOSITORY_NAME: workspace.repositoryName,
    BASE_BRANCH: workspace.baseBranch,
    CONTROLLER_ID: controllerId,
    USER_ID: workspace.ownerId,
    INSTANCE_NAME: instanceName,
    GCP_PROJECT_ID: config.gcpProjectId,
    GCP_REGION: config.gcpRegion,
  };
}

/**
 * InstanceRuntime that ensures the Instance exists before starting it:
 * open() means "this workspace is running", whether the Instance already
 * exists (start) or has never been created (create with the workspace env,
 * then start). A lost create race (409) falls through to start.
 *
 * stop() swallows InstanceNotFoundError: the desired end state (not running)
 * already holds, so failing the workspace stop for a missing Instance would
 * be a lie in the other direction.
 */
class EnsureCreatedInstanceRuntime implements InstanceRuntime {
  constructor(
    private readonly client: CloudRunInstanceClient,
    private readonly workspace: Workspace,
    private readonly repo: SessionPersistenceRepository,
  ) {}

  create(workspace: InstanceWorkspace): Promise<InstanceInfo> {
    return this.client.create(workspace);
  }

  async start(instanceName: string): Promise<void> {
    let exists = true;
    try {
      await this.client.get(instanceName);
    } catch (e) {
      if (!(e instanceof InstanceNotFoundError)) throw e;
      exists = false;
    }
    if (!exists) {
      try {
        await this.client.create({ id: this.workspace.id, instanceName });
      } catch (e) {
        if (!(e instanceof InstanceAlreadyExistsError)) throw e;
        // Lost the create race — the Instance exists now; proceed to start.
      }
      await this.repo.updateWorkspace(this.workspace.id, { instanceName });
    }
    await this.client.start(instanceName);
  }

  async stop(instanceName: string): Promise<void> {
    try {
      await this.client.stop(instanceName);
    } catch (e) {
      if (e instanceof InstanceNotFoundError) return;
      throw e;
    }
  }

  get(instanceName: string): Promise<InstanceInfo> {
    return this.client.get(instanceName);
  }

  delete(instanceName: string): Promise<void> {
    return this.client.delete(instanceName);
  }
}

async function waitForInstanceHealth(args: {
  client: CloudRunInstanceClient;
  instanceName: string;
  repo: SessionPersistenceRepository;
  workspaceId: string;
  healthFetch: HealthFetch;
  instancePoll: PollConfig;
  agentHealthPoll: PollConfig;
  sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  const { client, instanceName, repo, workspaceId, healthFetch, sleep } = args;
  let instanceUrl: string | null = null;
  for (let attempt = 1; attempt <= args.instancePoll.maxAttempts; attempt++) {
    const info = await client.get(instanceName);
    if (info.state === "READY" && info.url) {
      instanceUrl = info.url;
      break;
    }
    if (attempt < args.instancePoll.maxAttempts) await sleep(args.instancePoll.intervalMs);
  }
  if (!instanceUrl) {
    throw new Error(
      `instance ${instanceName} never became READY ` +
        `(${args.instancePoll.maxAttempts} polls) — not retrying blindly`,
    );
  }
  const healthUrl = `${instanceUrl.replace(/\/$/, "")}/healthz`;
  for (let attempt = 1; attempt <= args.agentHealthPoll.maxAttempts; attempt++) {
    try {
      const res = await healthFetch(healthUrl);
      if (res.ok) {
        await repo.updateWorkspace(workspaceId, { instanceUrl });
        return;
      }
    } catch {
      // Agent-host not reachable yet — keep polling within budget.
    }
    if (attempt < args.agentHealthPoll.maxAttempts) await sleep(args.agentHealthPoll.intervalMs);
  }
  throw new Error(
    `instance ${instanceName} is READY but its agent-host never became healthy ` +
      `(${args.agentHealthPoll.maxAttempts} polls of ${healthUrl}) — not marking READY blindly`,
  );
}

/**
 * Manual-checkpoint work for runManualCheckpoint: records a durable,
 * timestamped request marker in the checkpoint bucket. The control plane has
 * no workspace files (and no git) so it cannot build a T5 bundle itself; the
 * agent-host owns bundle creation. #22 teaches the agent-host to honor these
 * markers (or replaces them with a direct trigger call); until then the
 * marker is an auditable record of operator intent, never a silent no-op.
 */
export function buildManualCheckpointFn(
  storage: GcsCheckpointStorage,
  workspaceId: string,
  clock: ControlPlaneClock,
): () => Promise<void> {
  return async () => {
    const requestedAt = clock.now().toISOString();
    const key = `workspaces/${workspaceId}/manual-checkpoints/${requestedAt.replace(/[:.]/g, "-")}.json`;
    const marker = new TextEncoder().encode(
      JSON.stringify({ kind: "manual-checkpoint-request", workspaceId, requestedAt }),
    );
    await storage.put(key, marker);
  };
}

/** Builds the production RuntimeRegistry. Validates the clock first (pitfall guard). */
export function createProductionRuntimeRegistry(opts: ProductionRuntimeOptions): RuntimeRegistry {
  assertTwoMethodClock(opts.clock);
  const { config, repo, stateStore, clock } = opts;
  const basePath = `projects/${config.gcpProjectId}/locations/${config.gcpRegion}`;
  const checkpointStorage = new GcsCheckpointStorage(opts.gcsClient, config.checkpointBucket);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const healthFetch: HealthFetch = opts.healthFetch ?? ((url: string) => fetch(url));
  const instancePoll = opts.instancePoll ?? DEFAULT_INSTANCE_POLL;
  const agentHealthPoll = opts.agentHealthPoll ?? DEFAULT_AGENT_HEALTH_POLL;

  return new RuntimeRegistry((workspace: Workspace) => {
    const instanceName = defaultInstanceName(workspace);
    const controllerId =
      opts.controllerIdForWorkspace?.(workspace) ?? crypto.randomUUID();
    const client = new CloudRunInstanceClient({
      transport: opts.instanceTransport,
      basePath,
      image: config.agentHostImage,
      serviceAccount: config.agentHostServiceAccount,
      env: buildInstanceEnv(config, workspace, instanceName, controllerId),
    });
    const instanceRuntime = new EnsureCreatedInstanceRuntime(client, workspace, repo);
    const idle = new IdleManager(clock);
    // Last URL seen for this handle (seeded from the durable row). Updated
    // whenever the live API reports a (possibly recreated, changed) URL, and
    // persisted so #22 can also read workspaces.instance_url directly.
    let lastKnownUrl: string | null = workspace.instanceUrl;
    const steps: WorkspaceLifecycleSteps = {
      waitForInstanceHealth: () =>
        waitForInstanceHealth({
          client,
          instanceName,
          repo,
          workspaceId: workspace.id,
          healthFetch,
          instancePoll,
          agentHealthPoll,
          sleep,
        }),
      // Executed inside the Instance by agent-host restart recovery
      // (実装手順書 section 30); observed via the /healthz poll above.
      cloneRepository: async () => {},
      checkoutBase: async () => {},
      restoreCheckpoint: async () => {},
      createSandbox: async () => {},
      restoreHarness: async () => {},
      // Durable checkpoints are the agent-host's job (periodic scheduler);
      // a remote trigger is #22 follow-up work.
      runLifecycleCheckpoint: async () => {},
      // Session events persist append-only at write time (as on agent-host).
      flushSessionPersistence: async () => {},
      // Instance stop discards all local state; no separate sandbox exists here.
      deleteSandbox: async () => {},
    };
    const runtime = new WorkspaceRuntime({
      workspaceId: workspace.id,
      store: stateStore,
      clock,
      instanceRuntime,
      instanceName,
      steps,
      idle,
    });
    const checkpointFn = buildManualCheckpointFn(checkpointStorage, workspace.id, clock);
    const instanceUrlProvider = async (): Promise<string | null> => {
      try {
        const info = await client.get(instanceName);
        if (info.url) {
          if (info.url !== lastKnownUrl) {
            lastKnownUrl = info.url;
            await repo.updateWorkspace(workspace.id, { instanceUrl: info.url });
          }
          return info.url;
        }
        // The Instance exists but exposes no URL yet (e.g. PENDING while a
        // recreation is in flight). A cached URL at this point would be the
        // previous generation's dead address — report "not running" instead
        // of forwarding to it.
        return null;
      } catch (e) {
        if (e instanceof InstanceNotFoundError) {
          // The Instance is gone: any durable URL is dead. Clear it so #22
          // never forwards to it (callers answer 409 / open first). The
          // clear is best-effort — the in-memory entry is nulled regardless,
          // and the next lookup re-attempts the clear while still returning
          // null, so a stale row is never served from here.
          lastKnownUrl = null;
          await repo.updateWorkspace(workspace.id, { instanceUrl: null }).catch(() => undefined);
          return null;
        }
        // Transient lookup failure (network/auth) — fall through to the
        // durable row; a possibly-stale URL beats no URL when the API
        // itself could not be reached.
      }
      if (lastKnownUrl) return lastKnownUrl;
      const current = await repo.getWorkspace(workspace.id).catch(() => null);
      lastKnownUrl = current?.instanceUrl ?? null;
      return lastKnownUrl;
    };
    return new WorkspaceRuntimeHandleAdapter(runtime, checkpointFn, instanceUrlProvider);
  });
}
