// Cloud Run Instance client adapter — GCP SDK / REST isolated to this package
// Spec sections 22, 23, 26 item 10; Implementation guide sections 5, 6

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
}

export class CloudRunInstanceClient implements InstanceRuntime {
  private readonly transport: HttpTransport;
  private readonly basePath: string;
  private readonly config: InstanceConfig;

  constructor(options: CloudRunInstanceClientOptions) {
    this.transport = options.transport;
    this.basePath = options.basePath.replace(/\/$/, "");

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

  async create(workspace: Workspace): Promise<InstanceInfo> {
    const instanceName = workspace.instanceName ?? `dsh-${workspace.id}`;
    const url = `${this.basePath}/instances`;
    const body = this.buildCreateBody(workspace, instanceName);

    const res = await this.transport.request({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      body,
    });

    this.handleErrorStatus(res, instanceName);

    return this.parseInstanceInfo(res.body);
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

  private buildCreateBody(
    workspace: Workspace,
    instanceName: string,
  ): Record<string, unknown> {
    return {
      name: instanceName,
      workspaceId: workspace.id,
      resources: {
        cpu: this.config.cpu,
        memory: this.config.memory,
      },
      restartPolicy: this.config.restartPolicy,
      sandboxLauncher: this.config.sandboxLauncher,
      containerPort: this.config.port,
    };
  }

  private parseInstanceInfo(body: unknown): InstanceInfo {
    if (!body || typeof body !== "object") {
      throw new InstanceClientError("invalid instance response", 500);
    }
    const obj = body as Record<string, unknown>;
    const name = typeof obj["name"] === "string" ? (obj["name"] as string) : "";
    const url = typeof obj["url"] === "string" ? (obj["url"] as string) : undefined;
    const state = typeof obj["state"] === "string" ? (obj["state"] as string) : "UNKNOWN";
    if (!name) throw new InstanceClientError("missing instance name in response", 500);
    return { name, url, state };
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

// ---------------------------------------------------------------------------
// Fake transport for tests
// ---------------------------------------------------------------------------

export class FakeTransport implements HttpTransport {
  requests: HttpRequest[] = [];
  private handler: (req: HttpRequest) => Promise<HttpResponse>;

  constructor(handler?: (req: HttpRequest) => Promise<HttpResponse>) {
    this.handler =
      handler ??
      (async () => ({
        status: 200,
        body: { name: "fake-instance", state: "READY", url: "https://fake.run.app" },
      }));
  }

  setHandler(handler: (req: HttpRequest) => Promise<HttpResponse>): void {
    this.handler = handler;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    return this.handler(req);
  }

  lastRequest(): HttpRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  clear(): void {
    this.requests = [];
  }
}
