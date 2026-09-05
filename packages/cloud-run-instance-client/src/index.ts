// Cloud Run Instance client adapter — GCP SDK / REST isolated to this package
// Spec sections 22, 23, 26 item 10; Implementation guide sections 5, 6
//
// REST surface: Cloud Run Instances API **v2** (verified against the live
// discovery document on 2026-09-03: `https://run.googleapis.com/$discovery/rest?version=v2`).
// v1 exposes `projects.locations.instances` with IAM methods only — no CRUD.
// `basePath` MUST be an absolute URL including the API host + version, e.g.
// "https://run.googleapis.com/v2/projects/P/locations/L" (issue #47: a
// relative "projects/P/locations/L" makes fetch() throw "URL is invalid").
// The API version is decided by the caller via the `basePath` host+version
// prefix (use `buildInstancesBasePath()` or pass an emulator origin):
//   list   GET    {basePath}/instances            (create body name is IGNORED; id goes in ?instanceId=)
//   create POST   {basePath}/instances?instanceId=<id>[&validateOnly=true]
//   get    GET    {basePath}/instances/<id>
//   start  POST   {basePath}/instances/<id>:start
//   stop   POST   {basePath}/instances/<id>:stop
//   delete DELETE {basePath}/instances/<id>

/**
 * Production Cloud Run Instances API origin + version. Callers build their
 * `basePath` as `${apiBaseUrl}/projects/<id>/locations/<region>`; the value
 * is configurable (env `INSTANCES_API_BASE_URL`, emulator origins) so tests
 * and emulators never hard-code the production host.
 */
export const DEFAULT_INSTANCES_API_BASE_URL = "https://run.googleapis.com/v2";

/**
 * Assembles an absolute Instances API `basePath` from an API origin and a
 * project/region pair. Trailing slashes on the origin are ignored so both
 * "https://run.googleapis.com/v2" and ".../v2/" produce the same basePath.
 */
export function buildInstancesBasePath(args: {
  readonly apiBaseUrl: string;
  readonly projectId: string;
  readonly region: string;
}): string {
  const origin = args.apiBaseUrl.replace(/\/+$/, "");
  return `${origin}/projects/${args.projectId}/locations/${args.region}`;
}

/** Thrown when `basePath` is not an absolute http(s) URL (issue #47). */
export class InvalidBasePathError extends Error {
  readonly name = "InvalidBasePathError";
  constructor(public readonly basePath: string) {
    super(
      `CloudRunInstanceClient basePath must be an absolute URL including the API host and version, ` +
        `e.g. "https://run.googleapis.com/v2/projects/<project>/locations/<region>" (got ${JSON.stringify(basePath)}). ` +
        `A relative "projects/<project>/locations/<region>" cannot be fetched — ` +
        `build it with buildInstancesBasePath() or set INSTANCES_API_BASE_URL (issue #47).`,
    );
  }
}

/**
 * Fail-fast guard (issue #47): relative basePaths used to travel all the way
 * to `fetch()` before failing as "URL is invalid". Reject them here, in the
 * constructor, with the fix spelled out. `http://` origins are accepted so
 * emulators (e.g. http://localhost:8080/v2/...) keep working.
 */
export function assertAbsoluteBasePath(basePath: string): void {
  let parsed: URL;
  try {
    parsed = new URL(basePath);
  } catch {
    throw new InvalidBasePathError(basePath);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new InvalidBasePathError(basePath);
  }
}

// ---------------------------------------------------------------------------
// InstanceRuntime interface (implementation guide section 5 — exact shape)
// ---------------------------------------------------------------------------

export interface Workspace {
  readonly id: string;
  readonly instanceName?: string;
  // additional fields may be present but are not required by the runtime
}

export interface InstanceInfo {
  readonly name: string;
  readonly url?: string;
  readonly state: string;
}

export interface InstanceRuntime {
  create(workspace: Workspace): Promise<InstanceInfo>;
  start(instanceName: string): Promise<void>;
  stop(instanceName: string): Promise<void>;
  get(instanceName: string): Promise<InstanceInfo>;
  delete(instanceName: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Instance configuration (implementation guide section 6 + spec section 22)
// ---------------------------------------------------------------------------

export type RestartPolicy = "on-failure" | "never" | "always";

/**
 * Maps the client's RestartPolicy to the v2 API enum
 * (`GoogleCloudRunV2Instance.restartPolicy`: RESTART_POLICY_UNSPECIFIED |
 * ALWAYS | ON_FAILURE | NEVER). `always` is rejected before this mapping ever
 * runs (spec section 23 — known Preview issue).
 */
export function toApiRestartPolicy(policy: RestartPolicy): "ON_FAILURE" | "NEVER" | "ALWAYS" {
  switch (policy) {
    case "on-failure":
      return "ON_FAILURE";
    case "never":
      return "NEVER";
    case "always":
      return "ALWAYS";
  }
}

export interface InstanceConfig {
  /** vCPU count */
  readonly cpu: number;
  /** Memory string, e.g. "8Gi" */
  readonly memory: string;
  readonly restartPolicy: RestartPolicy;
  readonly sandboxLauncher: boolean;
  readonly port: number;
  /**
   * v2 top-level `launchStage` (issue #53). `containers[].sandboxLauncher`
   * ("Instant sandboxes") requires at least BETA — without it the live API
   * rejects every create with 400 FAILED_PRECONDITION ("The feature 'Instant
   * sandboxes' is not supported in the declared launch stage ..."). Optional:
   * when omitted the client defaults to BETA (validated against the live API
   * with `validateOnly=true` on 2026-09-05).
   */
  readonly launchStage?: InstanceLaunchStage;
}

/**
 * v2 `GoogleCloudRunV2Instance.launchStage` stages relevant to Instances.
 * Maturity order is ALPHA < BETA < GA.
 */
export type InstanceLaunchStage = "ALPHA" | "BETA" | "GA";

/**
 * Default launch stage (issue #53). BETA is the proven value: the live API
 * accepted `validateOnly=true` creates with `"launchStage": "BETA"` while the
 * undeclared (GA-default) stage rejected `sandboxLauncher` with 400.
 */
export const DEFAULT_INSTANCE_LAUNCH_STAGE: InstanceLaunchStage = "BETA";

const LAUNCH_STAGE_RANK: Record<InstanceLaunchStage, number> = {
  ALPHA: 1,
  BETA: 2,
  GA: 3,
};

/**
 * Issue #53 floor check: `sandboxLauncher` needs at least BETA.
 * NOTE (live-API nuance): maturity order says GA is "newer" than BETA, but the
 * sandbox feature itself is a BETA feature — the API rejected the undeclared
 * stage and accepted an explicit "BETA". Keep the default at BETA; an explicit
 * override is the caller's responsibility.
 */
export function meetsSandboxLaunchStageRequirement(stage: InstanceLaunchStage): boolean {
  return (LAUNCH_STAGE_RANK[stage] ?? 0) >= LAUNCH_STAGE_RANK["BETA"];
}

export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
  cpu: 4,
  memory: "8Gi",
  restartPolicy: "on-failure",
  sandboxLauncher: true,
  port: 8080,
  launchStage: DEFAULT_INSTANCE_LAUNCH_STAGE,
} as const;

/**
 * Cloud SQL socket integration (issue #56). A Cloud Run Instance has no VPC
 * connectivity of any kind, so the ONLY path to Cloud SQL is the built-in
 * `cloudSqlInstance` volume mounted at /cloudsql (see
 * infra/terraform/cloudsql.tf and docs/architecture.md). Both constants are
 * exported so the control plane's consistency check (runtime-factory.ts:
 * DATABASE_URL `host=` vs. volume instance) and tests share one source of
 * truth — changing one side without the other re-creates this incident.
 */
export const CLOUD_SQL_VOLUME_NAME = "cloudsql";
export const CLOUD_SQL_MOUNT_PATH = "/cloudsql";

export type InstanceProfileName = "Small" | "Standard" | "Large";

export const INSTANCE_PROFILES: Record<InstanceProfileName, InstanceConfig> = {
  Small: {
    cpu: 2,
    memory: "4Gi",
    restartPolicy: "on-failure",
    sandboxLauncher: true,
    port: 8080,
    launchStage: DEFAULT_INSTANCE_LAUNCH_STAGE,
  },
  Standard: {
    cpu: 4,
    memory: "8Gi",
    restartPolicy: "on-failure",
    sandboxLauncher: true,
    port: 8080,
    launchStage: DEFAULT_INSTANCE_LAUNCH_STAGE,
  },
  Large: {
    cpu: 8,
    memory: "16Gi",
    restartPolicy: "on-failure",
    sandboxLauncher: true,
    port: 8080,
    launchStage: DEFAULT_INSTANCE_LAUNCH_STAGE,
  },
} as const;

/**
 * v1 exposes Standard only (spec section 22).
 */
export const AVAILABLE_PROFILES: readonly InstanceProfileName[] = ["Standard"] as const;

export function configForProfile(profile: InstanceProfileName): InstanceConfig {
  const cfg = INSTANCE_PROFILES[profile];
  if (!cfg) throw new Error(`unknown profile: ${profile}`);
  // Enforce v1 scope: only Standard is available
  if (!(AVAILABLE_PROFILES as readonly string[]).includes(profile)) {
    throw new ProfileNotAvailableError(profile);
  }
  return cfg;
}

export class ProfileNotAvailableError extends Error {
  readonly name = "ProfileNotAvailableError";
  constructor(public readonly profile: string) {
    super(`profile ${profile} is not available in v1 (only Standard)`);
  }
}

// ---------------------------------------------------------------------------
// Errors — typed, with comment for "always" rejection
// ---------------------------------------------------------------------------

export class InvalidRestartPolicyError extends Error {
  readonly name = "InvalidRestartPolicyError";
  constructor(public readonly restartPolicy: string) {
    // Spec section 23: Preview時点で `always` に既知問題があるため採用しない
    super(
      `restartPolicy "always" is not allowed — known Preview issue (spec section 23); use "on-failure" or "never"`,
    );
  }
}

export class InstanceNotFoundError extends Error {
  readonly name = "InstanceNotFoundError";
  constructor(public readonly instanceName: string) {
    super(`instance not found: ${instanceName}`);
  }
}

/**
 * Thrown by `create()` when no Cloud SQL connection name is configured
 * (issue #56). Without the `cloudSqlInstance` volume the Instance boots with
 * no `/cloudsql` socket, so the agent-host dies with
 * `ERR_POSTGRES_CONNECTION_REFUSED` and `restartPolicy: ON_FAILURE` restarts
 * it in a loop — a billable crash loop that is only visible in container
 * logs. Fail here, before any Instances API call, with the fix spelled out
 * (same "fail before create" principle as issue #41's OPENROUTER_API_KEY
 * guard). The connection name itself is not a secret, so echoing the
 * *expected source* (never a credential) in the message is safe.
 */
export class MissingCloudSqlConnectionNameError extends Error {
  readonly name = "MissingCloudSqlConnectionNameError";
  constructor() {
    super(
      `create requires a Cloud SQL connection name (<project>:<region>:<instance>) — ` +
        `supply \`cloudSqlConnectionName\` when constructing CloudRunInstanceClient ` +
        `(the control plane reads it from CLOUD_SQL_CONNECTION_NAME, sourced from the ` +
        `\`sql_connection_name\` Terraform output). Without it the Instance would boot ` +
        `with no /cloudsql socket and crash-loop with ERR_POSTGRES_CONNECTION_REFUSED (issue #56).`,
    );
  }
}

export class InstanceAlreadyExistsError extends Error {
  readonly name = "InstanceAlreadyExistsError";
  constructor(public readonly instanceName: string) {
    super(`instance already exists: ${instanceName}`);
  }
}

export class PermissionDeniedError extends Error {
  readonly name = "PermissionDeniedError";
  constructor(message: string) {
    super(message);
  }
}

export class InstanceClientError extends Error {
  readonly name = "InstanceClientError";
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// HTTP transport — injected, so no direct GCP SDK dependency outside this package
// ---------------------------------------------------------------------------

export interface HttpRequest {
  readonly method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

// ---------------------------------------------------------------------------
// CloudRunInstanceClient — concrete InstanceRuntime
// ---------------------------------------------------------------------------

export interface CloudRunInstanceClientOptions {
  transport: HttpTransport;
  /**
   * Absolute Instances API base, e.g.
   * "https://run.googleapis.com/v2/projects/my-proj/locations/us-central1".
   * Relative "projects/.../locations/..." values are rejected in the
   * constructor (InvalidBasePathError, issue #47) — use
   * `buildInstancesBasePath()` to assemble this.
   */
  basePath: string;
  config?: InstanceConfig;
  profile?: InstanceProfileName;
  /**
   * Container image (v2 `containers[].image` — Required by the create API).
   * e.g. "us-docker.pkg.dev/my-proj/agent-host/agent-host:v1".
   * Optional here because some call sites only ever get/start/stop an
   * existing instance (e.g. agent-host recovery); `create()` throws a typed
   * error when it is missing.
   */
  image?: string;
  /** v2 top-level `serviceAccount` — the SA the instance runs as. */
  serviceAccount?: string;
  /**
   * Cloud SQL connection name (`<project>:<region>:<instance>`, the
   * `sql_connection_name` Terraform output) for the `cloudSqlInstance` volume
   * (issue #56). Required for `create()` — the Instance's only path to Cloud
   * SQL is this volume mounted at /cloudsql (no VPC connectivity exists), so
   * a missing name fails `create()` with MissingCloudSqlConnectionNameError
   * before any API call instead of crash-looping inside the Instance.
   * Optional here because some call sites only ever get/start/stop an
   * existing instance (e.g. agent-host recovery); like `image`, `create()`
   * throws a typed error when it is missing.
   */
  cloudSqlConnectionName?: string;
  /**
   * Container environment variables (v2 `containers[].env`, a list of
   * `{name, value}` pairs). The control plane passes the agent-host's
   * required keys (WORKSPACE_ID, CHECKPOINT_BUCKET, DATABASE_URL, ...) here
   * when it creates an instance; call sites that only get/start/stop an
   * existing instance omit it. Entries are emitted sorted by name so request
   * shapes are stable across runs.
   */
  env?: Record<string, string>;
}

export interface CreateOptions {
  /**
   * v2 create `validateOnly` query parameter: the request is validated and
   * default values are filled in, but nothing is persisted or created.
   * Free dry-run — use it before spending money on a real create.
   */
  readonly validateOnly?: boolean;
}

export class CloudRunInstanceClient implements InstanceRuntime {
  private readonly transport: HttpTransport;
  private readonly basePath: string;
  private readonly config: InstanceConfig;
  private readonly image: string | undefined;
  private readonly serviceAccount?: string;
  private readonly cloudSqlConnectionName?: string;
  private readonly env: Record<string, string>;

  constructor(options: CloudRunInstanceClientOptions) {
    this.transport = options.transport;
    // Issue #47: fail here on a relative basePath — never let it reach fetch().
    assertAbsoluteBasePath(options.basePath);
    this.basePath = options.basePath.replace(/\/$/, "");
    this.image = options.image;
    this.serviceAccount = options.serviceAccount;
    this.cloudSqlConnectionName = options.cloudSqlConnectionName?.trim() || undefined;
    this.env = { ...(options.env ?? {}) };

    // Resolve config: profile takes precedence, else explicit config, else default
    let resolved: InstanceConfig;
    if (options.profile) {
      resolved = configForProfile(options.profile);
    } else if (options.config) {
      resolved = options.config;
    } else {
      resolved = DEFAULT_INSTANCE_CONFIG;
    }

    // Spec section 23: `always` must be rejected with a typed error.
    // Known Preview issue — do not use `always`.
    if (resolved.restartPolicy === "always") {
      throw new InvalidRestartPolicyError(resolved.restartPolicy);
    }

    // Issue #53: `sandboxLauncher` requires launchStage >= BETA on the live
    // API (400 FAILED_PRECONDITION otherwise). Default an omitted stage to
    // BETA and promote a weaker explicit stage (e.g. ALPHA) so the default
    // path always works; an explicit BETA-or-newer choice is honored as-is.
    let launchStage = resolved.launchStage ?? DEFAULT_INSTANCE_LAUNCH_STAGE;
    if (resolved.sandboxLauncher && !meetsSandboxLaunchStageRequirement(launchStage)) {
      launchStage = DEFAULT_INSTANCE_LAUNCH_STAGE;
    }

    this.config = { ...resolved, launchStage };
  }

  getConfig(): InstanceConfig {
    return this.config;
  }

  async create(workspace: Workspace, options?: CreateOptions): Promise<InstanceInfo> {
    if (!this.image || this.image.trim() === "") {
      throw new InstanceClientError(
        "create requires an image (v2 containers[].image) — supply `image` when constructing CloudRunInstanceClient",
        400,
      );
    }
    // Issue #56: fail here — before any Instances API call — when the
    // connection name is missing. A volumeless create bills a crash loop.
    if (!this.cloudSqlConnectionName) {
      throw new MissingCloudSqlConnectionNameError();
    }
    const instanceName = workspace.instanceName ?? `dsh-${workspace.id}`;
    // v2 create: the instance id is a query parameter, not a body field
    // (GoogleCloudRunV2Instance.name is IGNORED in CreateInstanceRequest).
    const query = new URLSearchParams({ instanceId: instanceName });
    if (options?.validateOnly) query.set("validateOnly", "true");
    const url = `${this.basePath}/instances?${query.toString()}`;
    const body = this.buildCreateBody(workspace, instanceName);

    const res = await this.transport.request({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      body,
    });

    this.handleErrorStatus(res, instanceName);

    return this.parseCreateResponse(res.body, instanceName);
  }

  async start(instanceName: string): Promise<void> {
    const url = `${this.basePath}/instances/${encodeURIComponent(instanceName)}:start`;
    const res = await this.transport.request({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      body: {},
    });
    this.handleErrorStatus(res, instanceName);
  }

  async stop(instanceName: string): Promise<void> {
    const url = `${this.basePath}/instances/${encodeURIComponent(instanceName)}:stop`;
    const res = await this.transport.request({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      body: {},
    });
    this.handleErrorStatus(res, instanceName);
  }

  async get(instanceName: string): Promise<InstanceInfo> {
    const url = `${this.basePath}/instances/${encodeURIComponent(instanceName)}`;
    const res = await this.transport.request({
      method: "GET",
      url,
    });
    this.handleErrorStatus(res, instanceName);
    return this.parseInstanceInfo(res.body);
  }

  async delete(instanceName: string): Promise<void> {
    const url = `${this.basePath}/instances/${encodeURIComponent(instanceName)}`;
    const res = await this.transport.request({
      method: "DELETE",
      url,
    });
    this.handleErrorStatus(res, instanceName);
  }

  /**
   * v2 GoogleCloudRunV2Instance create body (live discovery 2026-09-03; shape
   * re-validated with `validateOnly=true` on 2026-09-05 — see the launchStage
   * and volumes notes below):
   *   - launchStage        (top-level; issue #53 — BETA is required when
   *     `containers[].sandboxLauncher` is set, the API default rejects it)
   *   - containers[]       (Required; exactly one container)
   *   - containers[].image (Required)
   *   - containers[].resources.limits.{cpu,memory}  — cpu/memory are limit
   *     STRINGS ("4"/"8Gi"), not a top-level `resources` object
   *   - containers[].sandboxLauncher — lives on the CONTAINER, not the instance
   *   - containers[].ports[].containerPort
   *   - containers[].env    (optional; `{name, value}` pairs sorted by name)
   *   - containers[].volumeMounts — the `cloudSqlInstance` volume mounted at
   *     /cloudsql (issue #56; the Instance's ONLY path to Cloud SQL — without
   *     it the agent-host crash-loops with ERR_POSTGRES_CONNECTION_REFUSED)
   *   - volumes[]          (top-level; `cloudSqlInstance.instances` holds the
   *     `<project>:<region>:<instance>` connection name; object form validated
   *     against the live API with `validateOnly=true` on 2026-09-05)
   *   - restartPolicy      (top-level; API enum ON_FAILURE/NEVER/ALWAYS)
   *   - serviceAccount     (top-level)
   * There is no `template` wrapper on Instances (that is the Services/Revisions
   * shape) and no readOnly fields are ever sent.
   */
  private buildCreateBody(
    _workspace: Workspace,
    _instanceName: string,
  ): Record<string, unknown> {
    const container: Record<string, unknown> = {
      image: this.image,
      resources: {
        limits: {
          cpu: String(this.config.cpu),
          memory: this.config.memory,
        },
      },
      ports: [{ containerPort: this.config.port }],
      // Issue #56: mount the Cloud SQL socket volume. The name MUST match the
      // top-level `volumes[]` entry below (asserted in tests).
      volumeMounts: [{ name: CLOUD_SQL_VOLUME_NAME, mountPath: CLOUD_SQL_MOUNT_PATH }],
    };
    if (this.config.sandboxLauncher) container["sandboxLauncher"] = this.config.sandboxLauncher;
    const envNames = Object.keys(this.env).sort();
    if (envNames.length > 0) {
      container["env"] = envNames.map((name) => ({ name, value: this.env[name] }));
    }

    const body: Record<string, unknown> = {
      containers: [container],
      restartPolicy: toApiRestartPolicy(this.config.restartPolicy),
      launchStage: this.config.launchStage ?? DEFAULT_INSTANCE_LAUNCH_STAGE,
      // Issue #56: the Cloud SQL socket volume. `create()` guarantees
      // `cloudSqlConnectionName` is set before this ever runs.
      volumes: [
        {
          name: CLOUD_SQL_VOLUME_NAME,
          cloudSqlInstance: { instances: [this.cloudSqlConnectionName] },
        },
      ],
    };
    if (this.serviceAccount) body["serviceAccount"] = this.serviceAccount;
    return body;
  }

  /**
   * v2 create returns a GoogleLongrunningOperation, not the Instance. A
   * pending operation has no instance payload, so the fully-qualified name is
   * composed from basePath + instanceId (same rule the API uses). When the
   * operation has completed, the instance is read from `response`.
   */
  private parseCreateResponse(body: unknown, instanceName: string): InstanceInfo {
    if (body && typeof body === "object" && "done" in (body as Record<string, unknown>)) {
      const op = body as Record<string, unknown>;
      if (op["done"] === true) {
        if (op["error"] && typeof op["error"] === "object") {
          const err = op["error"] as Record<string, unknown>;
          const raw = String(err["message"] ?? JSON.stringify(err));
          const qualifier = formatErrorQualifier(err);
          throw new InstanceClientError(
            `create failed: ${raw}${qualifier ? ` (${qualifier})` : ""}`,
            500,
          );
        }
        return this.parseInstanceInfo(op["response"]);
      }
      return {
        name: `${this.basePath}/instances/${instanceName}`,
        state: "PENDING",
      };
    }
    return this.parseInstanceInfo(body);
  }

  private parseInstanceInfo(body: unknown): InstanceInfo {
    if (!body || typeof body !== "object") {
      throw new InstanceClientError("invalid instance response", 500);
    }
    const obj = body as Record<string, unknown>;
    const name = typeof obj["name"] === "string" ? (obj["name"] as string) : "";
    // v2 exposes traffic URLs as `urls` (string array, readOnly); a literal
    // `url` string is still honored for test fakes.
    let url: string | undefined;
    if (Array.isArray(obj["urls"]) && typeof obj["urls"][0] === "string") {
      url = obj["urls"][0] as string;
    } else if (typeof obj["url"] === "string") {
      url = obj["url"] as string;
    }
    const state = this.parseInstanceState(obj);
    if (!name) throw new InstanceClientError("missing instance name in response", 500);
    return { name, url, state };
  }

  /**
   * v2 GoogleCloudRunV2Instance has no top-level `state` field; readiness
   * lives in `terminalCondition.state` (CONDITION_SUCCEEDED | CONDITION_FAILED |
   * CONDITION_PENDING | CONDITION_RECONCILING). A literal `state` string is
   * still honored when present (test fakes / future API additions).
   */
  private parseInstanceState(obj: Record<string, unknown>): string {
    const literal = obj["state"];
    if (typeof literal === "string") return literal;
    const terminal = obj["terminalCondition"];
    if (terminal && typeof terminal === "object") {
      const condState = (terminal as Record<string, unknown>)["state"];
      if (condState === "CONDITION_SUCCEEDED") return "READY";
      if (condState === "CONDITION_FAILED") return "FAILED";
      if (condState === "CONDITION_PENDING" || condState === "CONDITION_RECONCILING") {
        return "PENDING";
      }
    }
    return "UNKNOWN";
  }

  private handleErrorStatus(res: HttpResponse, instanceName: string): void {
    if (res.status >= 200 && res.status < 300) return;

    const message = extractApiErrorMessage(res.body) ?? `request failed with status ${res.status}`;

    if (res.status === 404) {
      throw new InstanceNotFoundError(instanceName);
    }
    if (res.status === 409) {
      throw new InstanceAlreadyExistsError(instanceName);
    }
    if (res.status === 403) {
      throw new PermissionDeniedError(message);
    }
    throw new InstanceClientError(message, res.status);
  }
}

/**
 * `status`/`code` qualifier for error messages (e.g.
 * "status: FAILED_PRECONDITION, code: 400"). Carries the machine-readable
 * triage signal alongside the human-readable message.
 */
function formatErrorQualifier(err: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof err["status"] === "string") parts.push(`status: ${err["status"]}`);
  if (typeof err["code"] === "number") parts.push(`code: ${err["code"]}`);
  return parts.join(", ");
}

/**
 * Issue #53: Google APIs report failures as
 * `{ "error": { "code": 400, "message": "...", "status": "FAILED_PRECONDITION" } }`.
 * The old code read a top-level `body.message`, so the real message was
 * discarded and every failure surfaced as "request failed with status 400".
 * Prefer `error.message` (with the `error.status`/`code` qualifier appended
 * for triage); keep the legacy top-level `message` and plain-string bodies as
 * fallbacks for older fakes.
 */
function extractApiErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const nested = obj["error"];
    if (nested && typeof nested === "object") {
      const err = nested as Record<string, unknown>;
      if (typeof err["message"] === "string") {
        const qualifier = formatErrorQualifier(err);
        return qualifier ? `${err["message"]} (${qualifier})` : (err["message"] as string);
      }
    }
    if (typeof obj["message"] === "string") return obj["message"];
  }
  if (typeof body === "string" && body.length > 0) return body;
  return undefined;
}
