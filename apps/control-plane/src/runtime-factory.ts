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
//   openInstance  REAL: the instance start (create-or-start + :start API
//                 calls). Issue #136 made this async: NO readiness polling
//                 happens in-request anymore — the old waitForInstanceHealth
//                 (Instances API GET until READY, then the agent-host /readyz
//                 poll, up to ~6 minutes) held POST /open for minutes, so it
//                 was removed. Completion authority is the agent-host's
//                 completeRestore() persisting READY on the shared row;
//                 clients poll GET /v1/workspaces/:id, and a STARTING /
//                 RESTORING row older than STALE_STARTING_THRESHOLD_MS
//                 (handlers.ts, 案A) reads as RESTORE_FAILED. The last live
//                 URL is resolved on demand by instanceUrlProvider below, so
//                 message forwarding self-heals without the poll's row write.
//   clone/checkout/        NO-OP: executed INSIDE the instance by the
//   restore/sandbox/       agent-host restart recovery (実装手順書 section 30).
//   restoreHarness         The control plane never observes their completion —
//                          the agent-host persists READY itself when done.
//
// Issue #60 案C: the control plane owns ONLY the instance lifecycle and the
// health observation above. Its WorkspaceRuntime runs openInstance()
// (STOPPED -> STARTING, start, health poll) and deliberately NEVER the
// RESTORING -> READY transitions — those belong to the agent-host's
// completeRestore() on the same row. Running the full open() here (even with
// the no-op steps above) is exactly the state-machine half of the #60
// collision: the agent-host would find STARTING and fail with
// "open is not allowed in state STARTING".
//   runLifecycleCheckpoint REMOTE (issue #72): POSTs the agent-host
//                          `prepare-stop` route via the #22 forwarder, so
//                          in-flight turns drain and the tar.gz workspace
//                          snapshot is written INSIDE the instance before this
//                          side stops it from the outside. The old comment
//                          here ("durable checkpoints are written continuously
//                          by the periodic scheduler") was wrong as a stop
//                          rationale: the scheduler skips clean trees, so a
//                          stop without this call could persist nothing while
//                          the instance stop discards everything. A remote
//                          failure THROWS, so WorkspaceRuntime.stop() records
//                          CHECKPOINT_FAILED and never calls the instance stop
//                          — that refusal is the whole point of this wiring.
//                          Skipped (NO-OP success) only when no instance URL
//                          is known: there is nothing alive left to preserve,
//                          and failing the stop then would strand STOPPING.
//   flushSessionPersistence NO-OP: session events are append-only at write
//                          time (same rationale as the agent-host steps).
//   deleteSandbox          NO-OP: stopping the Instance discards all of its
//                          local state; no separate sandbox resource exists
//                          from the control-plane side. (The agent-host runs
//                          the REAL delete inside prepare-stop above.)

import {
  CLOUD_SQL_MOUNT_PATH,
  CloudRunInstanceClient,
  InstanceAlreadyExistsError,
  InstanceNotFoundError,
  buildInstancesBasePath,
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
import { conflict } from "./errors.js";
import type { ForwardIdentity, MessageForwarder } from "./forwarding.js";

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
  /** Test override for the injected CONTROLLER_ID. Production callers pass the
   * open-established lease id per open() (issue #60 案B) and this hook is
   * only the fallback for paths that resolve no lease. Defaults to
   * crypto.randomUUID() per handle — which MUST match the lease the
   * agent-host adopts, otherwise the host refuses to boot (§26-8 fencing).
   */
  readonly controllerIdForWorkspace?: (workspace: Workspace) => string;
  /**
   * Forwards lifecycle calls to the agent-host gateway (issue #72 stop
   * preparation, issue #75 manual checkpoint). Production (main.ts) passes
   * the SAME HttpAgentHostForwarder the message handlers use — one
   * ID-token/timeout/409-vs-502 implementation, never a second copy.
   * Absent in unit tests: the remote steps fall back to NO-OP success and
   * the manual checkpoint writes only the GCS marker (both documented at
   * the call sites as test-only behavior, never the production path).
   */
  readonly messageForwarder?: MessageForwarder;
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
 * Fail-fast consistency check (issue #56, item 4): the `cloudSqlInstance`
 * volume serves `<connection-name>` at /cloudsql, while the agent-host's
 * `DATABASE_URL` dials `host=/cloudsql/<connection-name>`. Both values are
 * operator-supplied (`CLOUD_SQL_CONNECTION_NAME` vs. `AGENT_HOST_DATABASE_URL`
 * embedding the same `sql_connection_name` output), so changing one without
 * the other re-creates this incident exactly: the socket path the app dials
 * does not exist and the Instance crash-loops with
 * `ERR_POSTGRES_CONNECTION_REFUSED` under `restartPolicy: ON_FAILURE`.
 *
 * Throw here — at handle creation, before any Instances API call — with both
 * sides named and the fix spelled out. The connection name is not a secret;
 * the DATABASE_URL *value* is never echoed (only its decoded `host=`, which
 * carries no credentials).
 */
export function assertCloudSqlSocketConsistency(
  agentHostDatabaseUrl: string,
  cloudSqlConnectionName: string,
): void {
  const conn = cloudSqlConnectionName.trim();
  if (conn === "") {
    throw new Error(
      "cannot build instance client: CLOUD_SQL_CONNECTION_NAME is not configured — " +
        "set it to the `sql_connection_name` Terraform output (<project>:<region>:<instance>) " +
        "so created Instances get their cloudSqlInstance volume (refusing to create a " +
        "volumeless Instance that would crash-loop with ERR_POSTGRES_CONNECTION_REFUSED)",
    );
  }
  const expectedHost = `${CLOUD_SQL_MOUNT_PATH}/${conn}`;
  const actualHost = extractDatabaseUrlHostParam(agentHostDatabaseUrl);
  if (actualHost !== expectedHost) {
    const seen = actualHost === undefined ? "(no host= parameter)" : JSON.stringify(actualHost);
    throw new Error(
      `cannot build instance client: AGENT_HOST_DATABASE_URL host (${seen}) does not match ` +
        `CLOUD_SQL_CONNECTION_NAME (${JSON.stringify(conn)}; want host=${JSON.stringify(expectedHost)}). ` +
        "Derive both from the same `sql_connection_name` Terraform output " +
        "(`...?host=/cloudsql/<connection-name>`) — refusing to create an Instance whose " +
        "socket path would not exist",
    );
  }
}

/**
 * Reads the `host` query parameter of a Postgres DSN without a full URL
 * parse (passwords and placeholders in tests are not always URL-parseable;
 * only the query string matters here). Returns undefined when absent.
 */
function extractDatabaseUrlHostParam(dsn: string): string | undefined {
  const queryIndex = dsn.indexOf("?");
  if (queryIndex < 0) return undefined;
  for (const pair of dsn.slice(queryIndex + 1).split("&")) {
    const eq = pair.indexOf("=");
    if ((eq < 0 ? pair : pair.slice(0, eq)) !== "host") continue;
    const raw = eq < 0 ? "" : pair.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
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
    // Issue #109: the Instance's pool draws from the same 25-slot budget
    // (db-f1-micro), so the control plane dictates it — an Instance with
    // Bun defaults (max 10 eager, never reap) re-exhausts the tier alone.
    // The agent-host reads the same names (see its config.ts).
    DB_POOL_MAX: String(config.dbPoolMax),
    DB_POOL_IDLE_TIMEOUT: String(config.dbPoolIdleTimeout),
    DB_POOL_CONNECTION_TIMEOUT: String(config.dbPoolConnectionTimeout),
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

/**
 * Manual-checkpoint work for runManualCheckpoint (issue #75): FIRST takes a
 * real checkpoint on the agent-host via the `remote` trigger (which throws
 * when the durable snapshot was NOT written — so `checkpointed: true` is
 * never answered for an empty marker again), THEN records the durable,
 * timestamped request marker in the checkpoint bucket as the auditable
 * record of operator intent (now including whether the host had anything
 * new to write). The control plane has no workspace files (and no git) so
 * it cannot build a T5 bundle itself; the agent-host owns bundle creation.
 *
 * Without `remote` (unit tests only — production always wires it) only the
 * marker is written; that fallback is test-only behavior, never the
 * production path.
 */
export function buildManualCheckpointFn(
  storage: GcsCheckpointStorage,
  workspaceId: string,
  clock: ControlPlaneClock,
  remote?: () => Promise<{ skipped: boolean }>,
): () => Promise<{ skipped: boolean }> {
  return async () => {
    const skipped = remote ? (await remote()).skipped : undefined;
    const requestedAt = clock.now().toISOString();
    const key = `workspaces/${workspaceId}/manual-checkpoints/${requestedAt.replace(/[:.]/g, "-")}.json`;
    const marker = new TextEncoder().encode(
      JSON.stringify({
        kind: "manual-checkpoint-request",
        workspaceId,
        requestedAt,
        // How the workspace content was actually preserved. Absent only on
        // the test-only no-remote fallback above — never in production.
        ...(skipped !== undefined ? { checkpointSkipped: skipped } : {}),
      }),
    );
    await storage.put(key, marker);
    // The response flag mirrors the marker (issue #89). The no-remote
    // fallback consulted no host, so there is no skip to report — and the
    // marker write itself succeeded — hence `false`, never undefined.
    return { skipped: skipped ?? false };
  };
}

/** Builds the production RuntimeRegistry. Validates the clock first (pitfall guard). */
export function buildInstancesBasePathForConfig(
  config: Pick<ControlPlaneConfig, "gcpProjectId" | "gcpRegion" | "instancesApiBaseUrl">,
): string {
  // Issue #47: the Instances API basePath MUST be absolute
  // (https://run.googleapis.com/v2/projects/.../locations/...). A relative
  // "projects/.../locations/..." makes fetch() throw "URL is invalid", so
  // every open() failed. The origin+version stays configurable for
  // tests/emulators; production default is https://run.googleapis.com/v2.
  return buildInstancesBasePath({
    apiBaseUrl: config.instancesApiBaseUrl,
    projectId: config.gcpProjectId,
    region: config.gcpRegion,
  });
}

export function createProductionRuntimeRegistry(opts: ProductionRuntimeOptions): RuntimeRegistry {
  assertTwoMethodClock(opts.clock);
  const { config, repo, stateStore, clock } = opts;
  const basePath = buildInstancesBasePathForConfig(config);
  const checkpointStorage = new GcsCheckpointStorage(opts.gcsClient, config.checkpointBucket);

  // Issue #60 案B: the controllerId comes from the open-established lease
  // (handlers.openWorkspace resolves it via the lease service and passes it
  // through RuntimeRegistry.get). The hook/random fallback below only serves
  // paths that bypass open(); the agent-host adopts THIS id, so it must be
  // the lease id — a second random id here re-creates the #60 lease deadlock.
  const resolveControllerId = (workspace: Workspace, controllerId?: string): string =>
    controllerId ?? opts.controllerIdForWorkspace?.(workspace) ?? crypto.randomUUID();

  return new RuntimeRegistry((workspace: Workspace, controllerId?: string) => {
    const instanceName = defaultInstanceName(workspace);
    const resolvedControllerId = resolveControllerId(workspace, controllerId);
    // Issue #56: the volume's connection name and the DATABASE_URL socket
    // host must agree — fail here, before any Instances API call, not inside
    // the Instance with ERR_POSTGRES_CONNECTION_REFUSED.
    assertCloudSqlSocketConsistency(config.agentHostDatabaseUrl, config.cloudSqlConnectionName);
    const client = new CloudRunInstanceClient({
      transport: opts.instanceTransport,
      basePath,
      image: config.agentHostImage,
      serviceAccount: config.agentHostServiceAccount,
      cloudSqlConnectionName: config.cloudSqlConnectionName,
      env: buildInstanceEnv(config, workspace, instanceName, resolvedControllerId),
    });
    const instanceRuntime = new EnsureCreatedInstanceRuntime(client, workspace, repo);
    const idle = new IdleManager(clock);
    // Caller identity for the remote lifecycle calls below (issue #72
    // design note): the steps are built HERE at registry-construction time
    // when no caller exists yet, while the identity (handlers.stopWorkspace
    // / manualCheckpoint's ctx.user) arrives per call at the handle. The
    // adapter's identitySink fills this box just before delegating to the
    // runtime, so the steps read the REAL caller — a fabricated
    // service-account identity is never invented here.
    let pendingIdentity: ForwardIdentity | null = null;
    const identitySink = (identity: ForwardIdentity | undefined): void => {
      if (identity) pendingIdentity = identity;
    };
    // Last URL seen for this handle (seeded from the durable row). Updated
    // whenever the live API reports a (possibly recreated, changed) URL, and
    // persisted so #22 can also read workspaces.instance_url directly.
    let lastKnownUrl: string | null = workspace.instanceUrl;
    const messageForwarder = opts.messageForwarder;
    // Remote stop preparation (issue #72): the ONLY durable-checkpoint step
    // on the control-plane side. MUST throw on failure so
    // WorkspaceRuntime.stop() records CHECKPOINT_FAILED and never calls the
    // instance stop (see the header comment above).
    const runRemotePrepareStop = async (): Promise<void> => {
      // Test-only fallback (no forwarder wired): legacy NO-OP success.
      // Production always wires the forwarder (main.ts).
      if (!messageForwarder) return;
      const url = await instanceUrlProvider();
      // Boundary case: the instance is gone (or never opened) — there is
      // nothing alive left to preserve, so preparation trivially succeeds.
      // Attempting a remote call here would fail the whole stop for an
      // already-stopped workspace (the regression this guard prevents).
      if (!url) return;
      const identity = pendingIdentity;
      // Fail closed: without the real caller there is nothing truthful to
      // put in the forwarded identity headers, and inventing one would
      // forge the audit trail (issue #72 design note).
      if (!identity) {
        throw new Error(
          "control-plane stop requires the caller's identity to prepare the agent-host stop " +
            "(issue #72) — refusing to stop a potentially-dirty workspace faceless",
        );
      }
      await messageForwarder.forwardPrepareStop({
        instanceUrl: url,
        workspaceId: workspace.id,
        identity,
      });
    };
    // Remote manual checkpoint (issue #75): the durable snapshot itself.
    // Unlike the stop path above, a missing instance is a caller-visible
    // 409 (open first) — answering `checkpointed: true` with no snapshot
    // anywhere would be exactly the lie this issue removes.
    const runRemoteCheckpoint = async (): Promise<{ skipped: boolean }> => {
      if (!messageForwarder) return { skipped: false };
      const url = await instanceUrlProvider();
      if (!url) {
        throw conflict("workspace instance is not running — open the workspace first, then retry");
      }
      const identity = pendingIdentity;
      if (!identity) {
        throw new Error(
          "manual checkpoint requires the caller's identity (issue #75) — refusing a faceless checkpoint",
        );
      }
      const result = await messageForwarder.forwardCheckpoint({
        instanceUrl: url,
        workspaceId: workspace.id,
        identity,
      });
      return { skipped: result.skipped };
    };
    const steps: WorkspaceLifecycleSteps = {
      // Executed inside the Instance by agent-host restart recovery
      // (実装手順書 section 30). Issue #136: the control plane no longer
      // observes their completion — the agent-host persists READY itself.
      cloneRepository: async () => {},
      checkoutBase: async () => {},
      restoreCheckpoint: async () => {},
      createSandbox: async () => {},
      restoreHarness: async () => {},
      runLifecycleCheckpoint: runRemotePrepareStop,
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
    const checkpointFn = buildManualCheckpointFn(
      checkpointStorage,
      workspace.id,
      clock,
      // Issue #75: the real snapshot comes first via the agent-host; the
      // marker below is only the auditable record. Without a forwarder
      // (unit tests) the trigger is absent and only the marker is written.
      messageForwarder ? runRemoteCheckpoint : undefined,
    );
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
    // Issue #85: Instance deletion for the stopped-instance reaper and
    // DELETE /v1/workspaces/:id. Idempotent: a missing Instance resolves
    // successfully — the desired end state (no Instance) already holds, the
    // same rationale as EnsureCreatedInstanceRuntime.stop() above.
    const deleteInstance = async (): Promise<void> => {
      try {
        await client.delete(instanceName);
      } catch (e) {
        if (e instanceof InstanceNotFoundError) return;
        throw e;
      }
    };
    return new WorkspaceRuntimeHandleAdapter(
      runtime,
      checkpointFn,
      instanceUrlProvider,
      identitySink,
      deleteInstance,
    );
  });
}
