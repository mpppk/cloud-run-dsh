// Cloud Run Instance client adapter — GCP SDK / REST isolated to this package
// Spec sections 22, 23, 26 item 10; Implementation guide sections 5, 6
//
// REST surface: Cloud Run Instances API **v2** (verified against the live
// discovery document on 2026-09-03: `https://run.googleapis.com/$discovery/rest?version=v2`).
// v1 exposes `projects.locations.instances` with IAM methods only — no CRUD.
// The API version is decided by the caller via `basePath` (e.g.
// "projects/P/locations/L" is prefixed with the v2 host by the transport):
//   list   GET    {basePath}/instances            (create body name is IGNORED; id goes in ?instanceId=)
//   create POST   {basePath}/instances?instanceId=<id>[&validateOnly=true]
//   get    GET    {basePath}/instances/<id>
//   start  POST   {basePath}/instances/<id>:start
//   stop   POST   {basePath}/instances/<id>:stop
//   delete DELETE {basePath}/instances/<id>

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
}

export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
  cpu: 4,
  memory: "8Gi",
  restartPolicy: "on-failure",
  sandboxLauncher: true,
  port: 8080,
} as const;

export type InstanceProfileName = "Small" | "Standard" | "Large";

export const INSTANCE_PROFILES: Record<InstanceProfileName, InstanceConfig> = {
  Small: {
    cpu: 2,
    memory: "4Gi",
    restartPolicy: "on-failure",
    sandboxLauncher: true,
    port: 8080,
  },
  Standard: {
    cpu: 4,
    memory: "8Gi",
    restartPolicy: "on-failure",
    sandboxLauncher: true,
    port: 8080,
  },
  Large: {
    cpu: 8,
    memory: "16Gi",
    restartPolicy: "on-failure",
    sandboxLauncher: true,
    port: 8080,
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
  /** e.g. "projects/my-proj/locations/us-central1" — prefixed to instance paths */
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

  constructor(options: CloudRunInstanceClientOptions) {
    this.transport = options.transport;
    this.basePath = options.basePath.replace(/\/$/, "");
    this.image = options.image;
    this.serviceAccount = options.serviceAccount;

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

    this.config = resolved;
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
   * v2 GoogleCloudRunV2Instance create body (live discovery, 2026-09-03):
   *   - containers[]       (Required; exactly one container)
   *   - containers[].image (Required)
   *   - containers[].resources.limits.{cpu,memory}  — cpu/memory are limit
   *     STRINGS ("4"/"8Gi"), not a top-level `resources` object
   *   - containers[].sandboxLauncher — lives on the CONTAINER, not the instance
   *   - containers[].ports[].containerPort
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
    };
    if (this.config.sandboxLauncher) container["sandboxLauncher"] = this.config.sandboxLauncher;

    const body: Record<string, unknown> = {
      containers: [container],
      restartPolicy: toApiRestartPolicy(this.config.restartPolicy),
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
          throw new InstanceClientError(
            `create failed: ${String(err["message"] ?? JSON.stringify(err))}`,
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

    const message =
      res.body && typeof res.body === "object" && "message" in (res.body as Record<string, unknown>)
        ? String((res.body as Record<string, unknown>)["message"])
        : `request failed with status ${res.status}`;

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
