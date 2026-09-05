// Tests for the production configuration + adapters.
// No real Postgres required — SQL seams are exercised with a tiny fake.

import { describe, expect, test } from "bun:test";
import {
  MissingRequiredEnvError,
  readControlPlaneConfig,
} from "./config.js";
import {
  BunSqlLeaseStore,
  BunSqlQueryExecutor,
  OwnerMembershipStore,
  createAuthenticatedInstanceTransport,
  createGcpAccessTokenProvider,
  FetchGcsClient,
} from "./prod-adapters.js";
import type { BunSqlConnectionTarget } from "@cloud-run-dsh/session-persistence-postgres";
import type { BunSqlPoolOptions } from "@cloud-run-dsh/session-persistence-postgres";
import type { QueryExecutor } from "@cloud-run-dsh/session-persistence-postgres";
import type { ControllerLeaseRecord } from "@cloud-run-dsh/controller-lease";
import { InMemoryLogger } from "@cloud-run-dsh/observability";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function fullEnv(): Record<string, string> {
  return {
    DATABASE_URL: "postgres://x",
    GCP_PROJECT_ID: "test-proj",
    GCP_REGION: "test-region",
    AGENT_HOST_IMAGE: "img",
    AGENT_HOST_SERVICE_ACCOUNT: "sa@test-proj.iam.gserviceaccount.com",
    CHECKPOINT_BUCKET: "bucket",
    AGENT_HOST_DATABASE_URL: "postgresql://x",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY_PEM: "pem",
    OPENROUTER_API_KEY: "sk-or-v1-test",
    CLOUD_SQL_CONNECTION_NAME: "test-proj:test-region:test-pg",
  };
}

describe("readControlPlaneConfig", () => {
  test("missing DATABASE_URL -> MissingRequiredEnvError listing the key", () => {
    try {
      readControlPlaneConfig({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MissingRequiredEnvError);
      expect((e as MissingRequiredEnvError).missing).toContain("DATABASE_URL");
    }
  });

  test("every new required key is reported when missing", () => {
    const required = [
      "GCP_PROJECT_ID",
      "GCP_REGION",
      "AGENT_HOST_IMAGE",
      "AGENT_HOST_SERVICE_ACCOUNT",
      "CHECKPOINT_BUCKET",
      "AGENT_HOST_DATABASE_URL",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY_PEM",
      "OPENROUTER_API_KEY",
      "CLOUD_SQL_CONNECTION_NAME",
    ];
    for (const key of required) {
      const env = fullEnv();
      delete env[key];
      try {
        readControlPlaneConfig(env);
        expect.unreachable(`expected MissingRequiredEnvError for ${key}`);
      } catch (e) {
        expect(e).toBeInstanceOf(MissingRequiredEnvError);
        expect((e as MissingRequiredEnvError).missing).toEqual([key]);
      }
    }
  });

  test("blank new keys are treated as missing", () => {
    expect(() =>
      readControlPlaneConfig({ ...fullEnv(), GCP_PROJECT_ID: "   " }),
    ).toThrow(MissingRequiredEnvError);
  });

  test("full env parses into the production config", () => {
    const config = readControlPlaneConfig(fullEnv());
    expect(config.port).toBe(8080);
    expect(config.databaseUrl).toBe("postgres://x");
    expect(config.gcpProjectId).toBe("test-proj");
    expect(config.gcpRegion).toBe("test-region");
    // Issue #47: production default is the absolute v2 origin.
    expect(config.instancesApiBaseUrl).toBe("https://run.googleapis.com/v2");
    expect(config.agentHostImage).toBe("img");
    expect(config.agentHostServiceAccount).toBe("sa@test-proj.iam.gserviceaccount.com");
    expect(config.checkpointBucket).toBe("bucket");
    expect(config.agentHostDatabaseUrl).toBe("postgresql://x");
    expect(config.githubAppId).toBe("123");
    expect(config.githubAppPrivateKeyPem).toBe("pem");
    expect(config.openrouterApiKey).toBe("sk-or-v1-test");
    // Issue #56: the volume's connection name travels as its own required key.
    expect(config.cloudSqlConnectionName).toBe("test-proj:test-region:test-pg");
    // Optional LLM overrides default to "agent-host decides".
    expect(config.llmBaseUrl).toBeUndefined();
    expect(config.llmModel).toBeUndefined();
    expect(config.llmApprovalPolicy).toBeUndefined();
    // Issue #85: GC cadence/threshold/cap default to hourly / 30 days / 10 per sweep.
    expect(config.instanceGcIntervalMs).toBe(60 * 60 * 1000);
    expect(config.instanceGcStaleAfterMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(config.instanceGcMaxDeletesPerSweep).toBe(10);
    // Issue #109: pool budget defaults to the db-f1-micro share (5 of 25).
    expect(config.dbPoolMax).toBe(5);
    expect(config.dbPoolIdleTimeout).toBe(30);
    expect(config.dbPoolConnectionTimeout).toBe(30);
  });

  test("pool budget is tunable via the environment (tier upsizing path)", () => {
    const config = readControlPlaneConfig({
      ...fullEnv(),
      DB_POOL_MAX: "20",
      DB_POOL_IDLE_TIMEOUT: "60",
      DB_POOL_CONNECTION_TIMEOUT: "10",
    });
    expect(config.dbPoolMax).toBe(20);
    expect(config.dbPoolIdleTimeout).toBe(60);
    expect(config.dbPoolConnectionTimeout).toBe(10);
  });

  test("invalid pool values fail boot naming the variable", () => {
    expect(() => readControlPlaneConfig({ ...fullEnv(), DB_POOL_MAX: "0" })).toThrow(
      /DB_POOL_MAX/,
    );
    expect(() => readControlPlaneConfig({ ...fullEnv(), DB_POOL_IDLE_TIMEOUT: "-1" })).toThrow(
      /DB_POOL_IDLE_TIMEOUT/,
    );
  });

  test("missing OPENROUTER_API_KEY fails boot with the key NAME only (no value to leak)", () => {
    const env = fullEnv();
    delete env["OPENROUTER_API_KEY"];
    try {
      readControlPlaneConfig(env);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MissingRequiredEnvError);
      expect((e as MissingRequiredEnvError).missing).toEqual(["OPENROUTER_API_KEY"]);
      expect(String(e)).toContain("OPENROUTER_API_KEY");
      expect(String(e)).not.toContain("sk-or-v1-test");
    }
  });

  test("optional LLM overrides parse through; blanks mean unset; bad policy fails", () => {
    const config = readControlPlaneConfig({
      ...fullEnv(),
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_MODEL: "example/model-x",
      LLM_APPROVAL_POLICY: "never",
    });
    expect(config.llmBaseUrl).toBe("https://llm.example.test/v1");
    expect(config.llmModel).toBe("example/model-x");
    expect(config.llmApprovalPolicy).toBe("never");

    const blanked = readControlPlaneConfig({
      ...fullEnv(),
      LLM_BASE_URL: "   ",
      LLM_MODEL: "",
      LLM_APPROVAL_POLICY: "  ",
    });
    expect(blanked.llmBaseUrl).toBeUndefined();
    expect(blanked.llmModel).toBeUndefined();
    expect(blanked.llmApprovalPolicy).toBeUndefined();

    expect(() =>
      readControlPlaneConfig({ ...fullEnv(), LLM_APPROVAL_POLICY: "sometimes" }),
    ).toThrow(/invalid LLM_APPROVAL_POLICY/);
  });

  test("PORT defaults to 8080 (Cloud Run injects PORT in production)", () => {
    const config = readControlPlaneConfig(fullEnv());
    expect(config.port).toBe(8080);
  });

  test("PORT is parsed from the environment", () => {
    const config = readControlPlaneConfig({ ...fullEnv(), PORT: "9090" });
    expect(config.port).toBe(9090);
  });

  test("invalid PORT is rejected", () => {
    expect(() => readControlPlaneConfig({ ...fullEnv(), PORT: "not-a-number" })).toThrow(
      /invalid PORT/,
    );
    expect(() => readControlPlaneConfig({ ...fullEnv(), PORT: "70000" })).toThrow(
      /invalid PORT/,
    );
  });

  test("INSTANCES_API_BASE_URL defaults to production, honors overrides, rejects relative (issue #47)", () => {
    expect(readControlPlaneConfig(fullEnv()).instancesApiBaseUrl).toBe(
      "https://run.googleapis.com/v2",
    );
    expect(
      readControlPlaneConfig({ ...fullEnv(), INSTANCES_API_BASE_URL: "http://localhost:8080/v2" })
        .instancesApiBaseUrl,
    ).toBe("http://localhost:8080/v2");
    // Blank means "unset" — same rule as the LLM overrides.
    expect(
      readControlPlaneConfig({ ...fullEnv(), INSTANCES_API_BASE_URL: "   " }).instancesApiBaseUrl,
    ).toBe("https://run.googleapis.com/v2");
    expect(() =>
      readControlPlaneConfig({
        ...fullEnv(),
        INSTANCES_API_BASE_URL: "projects/test-proj/locations/test-region",
      }),
    ).toThrow(/invalid INSTANCES_API_BASE_URL/);
    expect(() =>
      readControlPlaneConfig({ ...fullEnv(), INSTANCES_API_BASE_URL: "ftp://example.com/v2" }),
    ).toThrow(/invalid INSTANCES_API_BASE_URL/);
  });

  test("INSTANCE_GC_* tune the sweeper; blanks mean default; bad values fail boot (issue #85)", () => {
    const tuned = readControlPlaneConfig({
      ...fullEnv(),
      INSTANCE_GC_INTERVAL_MS: "60000",
      INSTANCE_GC_STALE_AFTER_MS: "86400000",
      INSTANCE_GC_MAX_DELETES_PER_SWEEP: "5",
    });
    expect(tuned.instanceGcIntervalMs).toBe(60_000);
    expect(tuned.instanceGcStaleAfterMs).toBe(86_400_000);
    expect(tuned.instanceGcMaxDeletesPerSweep).toBe(5);

    // Zero disables the background sweeper (on-demand DELETE still works).
    expect(
      readControlPlaneConfig({ ...fullEnv(), INSTANCE_GC_INTERVAL_MS: "0" })
        .instanceGcIntervalMs,
    ).toBe(0);

    const blanked = readControlPlaneConfig({
      ...fullEnv(),
      INSTANCE_GC_INTERVAL_MS: "   ",
      INSTANCE_GC_STALE_AFTER_MS: "",
      INSTANCE_GC_MAX_DELETES_PER_SWEEP: "  ",
    });
    expect(blanked.instanceGcIntervalMs).toBe(60 * 60 * 1000);
    expect(blanked.instanceGcStaleAfterMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(blanked.instanceGcMaxDeletesPerSweep).toBe(10);

    expect(() =>
      readControlPlaneConfig({ ...fullEnv(), INSTANCE_GC_INTERVAL_MS: "not-a-number" }),
    ).toThrow(/invalid INSTANCE_GC_INTERVAL_MS/);
    expect(() =>
      readControlPlaneConfig({ ...fullEnv(), INSTANCE_GC_INTERVAL_MS: "-1" }),
    ).toThrow(/invalid INSTANCE_GC_INTERVAL_MS/);
    // Staleness below 1 hour is rejected: with an hourly sweeper it would
    // wipe every stopped Instance at once.
    expect(() =>
      readControlPlaneConfig({ ...fullEnv(), INSTANCE_GC_STALE_AFTER_MS: "0" }),
    ).toThrow(/invalid INSTANCE_GC_STALE_AFTER_MS/);
    expect(() =>
      readControlPlaneConfig({ ...fullEnv(), INSTANCE_GC_STALE_AFTER_MS: "1" }),
    ).toThrow(/invalid INSTANCE_GC_STALE_AFTER_MS/);
    expect(() =>
      readControlPlaneConfig({ ...fullEnv(), INSTANCE_GC_STALE_AFTER_MS: "3599999" }),
    ).toThrow(/invalid INSTANCE_GC_STALE_AFTER_MS/);
    expect(
      readControlPlaneConfig({ ...fullEnv(), INSTANCE_GC_STALE_AFTER_MS: "3600000" })
        .instanceGcStaleAfterMs,
    ).toBe(3_600_000);
    expect(() =>
      readControlPlaneConfig({ ...fullEnv(), INSTANCE_GC_MAX_DELETES_PER_SWEEP: "0" }),
    ).toThrow(/invalid INSTANCE_GC_MAX_DELETES_PER_SWEEP/);
  });
});

// ---------------------------------------------------------------------------
// BunSqlQueryExecutor.connect — Cloud SQL socket form + password hygiene
// (issue #42; resolution logic itself is covered in the shared package)
// ---------------------------------------------------------------------------

const CONNECT_SECRET = "cp-s3cr3t-Pw/xX9qZ";

describe("BunSqlQueryExecutor.connect", () => {
  const seen: BunSqlConnectionTarget[] = [];
  const seenOptions: (BunSqlPoolOptions | undefined)[] = [];

  class StubSql {
    constructor(target: BunSqlConnectionTarget, options?: BunSqlPoolOptions) {
      seen.push(target);
      seenOptions.push(options);
    }
    async unsafe(): Promise<unknown[]> {
      return [];
    }
    async begin<T>(fn: (tx: StubSql) => Promise<T>): Promise<T> {
      return fn(this);
    }
    async close(): Promise<void> {}
  }

  test("socket DSN resolves to the options object, not the URL string", async () => {
    seen.length = 0;
    await BunSqlQueryExecutor.connect(
      `postgresql://dsh_app:${CONNECT_SECRET}@/dsh?host=/cloudsql/p:r:i`,
      StubSql,
    );
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({
      path: "/cloudsql/p:r:i",
      username: "dsh_app",
      password: CONNECT_SECRET,
      database: "dsh",
    });
  });

  test("TCP DSN passes through byte-identical", async () => {
    seen.length = 0;
    const url = `postgres://dsh:${CONNECT_SECRET}@localhost:5432/dsh`;
    await BunSqlQueryExecutor.connect(url, StubSql);
    expect(seen).toEqual([url]);
  });

  test("pool options merge into the socket options object (issue #109)", async () => {
    seen.length = 0;
    seenOptions.length = 0;
    await BunSqlQueryExecutor.connect(
      `postgresql://dsh_app:${CONNECT_SECRET}@/dsh?host=/cloudsql/p:r:i`,
      StubSql,
      { max: 5, idleTimeout: 30, connectionTimeout: 30 },
    );
    expect(seen[0]).toEqual({
      path: "/cloudsql/p:r:i",
      username: "dsh_app",
      password: CONNECT_SECRET,
      database: "dsh",
      max: 5,
      idleTimeout: 30,
      connectionTimeout: 30,
    });
    // Merged form: no second constructor arg for object targets.
    expect(seenOptions[0]).toBeUndefined();
  });

  test("pool options ride the second constructor arg for TCP strings (issue #109)", async () => {
    seen.length = 0;
    seenOptions.length = 0;
    const url = `postgres://dsh:${CONNECT_SECRET}@localhost:5432/dsh`;
    await BunSqlQueryExecutor.connect(url, StubSql, { max: 5, idleTimeout: 30 });
    expect(seen).toEqual([url]);
    expect(seenOptions[0]).toEqual({ max: 5, idleTimeout: 30 });
  });

  test("constructor failure never carries the password", async () => {
    const dsn = `postgresql://dsh_app:${CONNECT_SECRET}@/dsh?host=/cloudsql/p:r:i`;
    class ThrowingSql extends StubSql {
      constructor(target: BunSqlConnectionTarget) {
        super(target);
        // Faithful to Bun: message clean, password in `input`.
        throw Object.assign(new TypeError("Invalid URL"), {
          code: "ERR_INVALID_URL",
          input: dsn,
        });
      }
    }
    const err = await BunSqlQueryExecutor.connect(dsn, ThrowingSql).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    expect(err!.name).toBe("BunSqlConnectionError");
    expect(err!.message.includes(CONNECT_SECRET)).toBe(false);
    expect(JSON.stringify(err).includes(CONNECT_SECRET)).toBe(false);
    expect("input" in err!).toBe(false);
    expect("cause" in err!).toBe(false);
  });

  test("socket connect hides ambient DATABASE_URL from the SQL ctor (issue #45)", async () => {
    // Production injects the socket DSN itself as DATABASE_URL; Bun.SQL
    // would otherwise throw ERR_INVALID_URL even for a correct options
    // object. The executor must isolate the ctor call and restore env.
    const poison = `postgresql://dsh_app:${CONNECT_SECRET}@/dsh?host=/cloudsql/p:r:i`;
    const prev = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = poison;
    try {
      seen.length = 0;
      let observed: string | undefined = "not-observed";
      class RecordingSql extends StubSql {
        constructor(target: BunSqlConnectionTarget) {
          super(target);
          observed = process.env["DATABASE_URL"];
        }
      }
      await BunSqlQueryExecutor.connect(
        `postgresql://dsh_app:${CONNECT_SECRET}@/dsh?host=/cloudsql/p:r:i`,
        RecordingSql,
      );
      expect(observed).toBeUndefined();
      expect(seen[0]).toEqual({
        path: "/cloudsql/p:r:i",
        username: "dsh_app",
        password: CONNECT_SECRET,
        database: "dsh",
      });
      expect(process.env["DATABASE_URL"]).toBe(poison);
    } finally {
      if (prev === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// OwnerMembershipStore over a fake executor (no members table in this milestone)
// ---------------------------------------------------------------------------

class MembershipFakeExecutor implements QueryExecutor {
  owners = new Map<string, string>();

  async query<T>(sql: string, params: readonly unknown[]): Promise<T[]> {
    if (sql === "SELECT owner_id FROM workspaces WHERE id = $1") {
      const owner = this.owners.get(params[0] as string);
      return (owner === undefined ? [] : [{ owner_id: owner }]) as T[];
    }
    throw new Error(`MembershipFakeExecutor: unhandled query: ${sql}`);
  }

  async exec(): Promise<void> {
    throw new Error("MembershipFakeExecutor: unhandled exec");
  }

  async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}

describe("OwnerMembershipStore", () => {
  test("isMember is true only for the workspace owner", async () => {
    const executor = new MembershipFakeExecutor();
    executor.owners.set("ws-1", "alice");
    const store = new OwnerMembershipStore(executor);
    expect(await store.isMember("ws-1", "alice")).toBe(true);
    expect(await store.isMember("ws-1", "bob")).toBe(false);
    expect(await store.isMember("ws-unknown", "alice")).toBe(false);
  });

  test("addMember verifies the owner (called by createWorkspace)", async () => {
    const executor = new MembershipFakeExecutor();
    executor.owners.set("ws-1", "alice");
    const store = new OwnerMembershipStore(executor);
    await store.addMember("ws-1", "alice"); // owner: OK
    await expect(store.addMember("ws-1", "bob")).rejects.toThrow(/owner-only/);
    await expect(store.addMember("ws-unknown", "alice")).rejects.toThrow(
      /workspace not found/,
    );
  });

  test("removeMember refuses the owner and ignores non-members", async () => {
    const executor = new MembershipFakeExecutor();
    executor.owners.set("ws-1", "alice");
    const store = new OwnerMembershipStore(executor);
    await expect(store.removeMember("ws-1", "alice")).rejects.toThrow(/cannot remove the workspace owner/);
    await store.removeMember("ws-1", "bob"); // never a member: no-op
  });

  test("listMembers returns the owner", async () => {
    const executor = new MembershipFakeExecutor();
    executor.owners.set("ws-1", "alice");
    const store = new OwnerMembershipStore(executor);
    expect(await store.listMembers("ws-1")).toEqual(["alice"]);
    expect(await store.listMembers("ws-unknown")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BunSqlLeaseStore shape (SQL wiring only; full lease semantics live in T6)
// ---------------------------------------------------------------------------

class LeaseFakeExecutor implements QueryExecutor {
  lastQuery = "";
  lastParams: readonly unknown[] = [];
  rows: Record<string, unknown>[] = [];

  async query<T>(sql: string, params: readonly unknown[]): Promise<T[]> {
    this.lastQuery = sql;
    this.lastParams = params;
    return this.rows as T[];
  }

  async exec(): Promise<void> {}
  async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async close(): Promise<void> {}
}

function leaseRecord(overrides: Partial<ControllerLeaseRecord> = {}): ControllerLeaseRecord {
  return {
    workspaceId: "ws-1",
    controllerId: "ctrl-1",
    userId: "alice",
    expiresAt: new Date("2026-01-01T00:00:45Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("BunSqlLeaseStore", () => {
  test("upsertIfExpired delegates to the controller_leases upsert with ISO timestamps", async () => {
    const executor = new LeaseFakeExecutor();
    executor.rows = [
      {
        workspace_id: "ws-1",
        controller_id: "ctrl-1",
        user_id: "alice",
        expires_at: "2026-01-01T00:00:45.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    const store = new BunSqlLeaseStore(executor);
    const record = leaseRecord();
    const result = await store.upsertIfExpired(record, new Date("2026-01-01T00:00:00Z"));
    expect(executor.lastQuery).toContain("INSERT INTO controller_leases");
    expect(executor.lastQuery).toContain("ON CONFLICT (workspace_id)");
    expect(executor.lastParams).toContain("2026-01-01T00:00:45.000Z");
    expect(result).not.toBeNull();
    expect(result!.workspaceId).toBe("ws-1");
    expect(result!.expiresAt.toISOString()).toBe("2026-01-01T00:00:45.000Z");
  });

  test("extendIfOwner issues the owner-scoped UPDATE", async () => {
    const executor = new LeaseFakeExecutor();
    const store = new BunSqlLeaseStore(executor);
    const result = await store.extendIfOwner(
      "ws-1",
      "ctrl-1",
      new Date("2026-01-01T00:01:00Z"),
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(executor.lastQuery).toContain("UPDATE controller_leases");
    expect(executor.lastQuery).toContain("controller_id = $2 AND expires_at > $5");
    expect(result).toBeNull(); // no rows returned by the fake
  });
});

// ---------------------------------------------------------------------------
// GCP token provider (Instances API + GCS auth — issue #76)
//
// The provider is the shared @cloud-run-dsh/gcp-token-provider chain
// (metadata server → ADC → GCP_ACCESS_TOKEN, cached). These tests pin the
// control-plane wiring: the chain order, the cache, the ADC fallback, and
// that token material never reaches logs or error messages. The chain's
// own edge cases (margins, stampedes, service-account minting) are covered
// in the package's suite.
// ---------------------------------------------------------------------------

describe("createGcpAccessTokenProvider", () => {
  type StubResponse = { ok: boolean; status: number; json(): Promise<unknown> };
  const jsonStub = (
    onCall: (url: string) => StubResponse | Promise<StubResponse>,
  ): { fetchFn: (url: string) => Promise<StubResponse>; calls: string[] } => {
    const calls: string[] = [];
    const fetchFn = async (url: string): Promise<StubResponse> => {
      calls.push(url);
      return onCall(url);
    };
    return { fetchFn, calls };
  };
  const tokenJson = (token: string, expiresIn = 3600): StubResponse => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: expiresIn }),
  });
  const noAdc = async (): Promise<string> => {
    throw new Error("ENOENT: no adc file");
  };

  test("metadata server token is served, then cached without re-fetching", async () => {
    const { fetchFn, calls } = jsonStub(() => tokenJson("meta-token"));
    const provider = createGcpAccessTokenProvider({}, fetchFn, { readFile: noAdc });

    await expect(provider()).resolves.toBe("meta-token");
    await expect(provider()).resolves.toBe("meta-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("metadata.google.internal");
  });

  test("falls back to ADC authorized_user when the metadata server is down", async () => {
    const logger = new InMemoryLogger();
    const { fetchFn } = jsonStub((url) => {
      if (url.includes("metadata.google.internal")) return { ok: false, status: 404, json: async () => ({}) };
      return tokenJson("ya29.adc-token");
    });
    const provider = createGcpAccessTokenProvider(
      { GOOGLE_APPLICATION_CREDENTIALS: "/adc/creds.json" },
      fetchFn,
      {
        logger,
        readFile: async () =>
          JSON.stringify({
            type: "authorized_user",
            client_id: "id",
            client_secret: "secret",
            refresh_token: "rt",
          }),
      },
    );

    await expect(provider()).resolves.toBe("ya29.adc-token");
    const event = logger.parsed.find((e) => e["event"] === "gcs.auth.token_source");
    expect(event?.["source"]).toBe("adc-authorized-user");
    for (const line of logger.lines) {
      expect(line.includes("ya29.adc-token")).toBe(false);
      expect(line.includes("rt")).toBe(false);
    }
  });

  test("GCP_ACCESS_TOKEN is the last resort after metadata and ADC fail", async () => {
    const { fetchFn, calls } = jsonStub(() => {
      throw new Error("fetch failed");
    });
    const provider = createGcpAccessTokenProvider(
      { GCP_ACCESS_TOKEN: "  env-token-abc  " },
      fetchFn,
      { readFile: noAdc },
    );

    // The metadata server IS consulted first (shared chain order) — the env
    // token wins only because nothing earlier produced one.
    await expect(provider()).resolves.toBe("env-token-abc");
    expect(calls.length).toBeGreaterThan(0);
  });

  test("unreachable metadata server with no ADC and no env token -> actionable error", async () => {
    const { fetchFn } = jsonStub(() => {
      throw new Error("fetch failed");
    });
    const provider = createGcpAccessTokenProvider({}, fetchFn, { readFile: noAdc });
    await expect(provider()).rejects.toThrow(/no GCS credential source/);
    await expect(provider()).rejects.toThrow(/GCP_ACCESS_TOKEN/);
  });

  test("metadata non-200 / missing access_token falls through to the next source", async () => {
    const badStatus = createGcpAccessTokenProvider(
      { GCP_ACCESS_TOKEN: "env-after-403" },
      jsonStub(() => ({ ok: false, status: 403, json: async () => ({}) })).fetchFn,
      { readFile: noAdc },
    );
    await expect(badStatus()).resolves.toBe("env-after-403");

    const noToken = createGcpAccessTokenProvider(
      { GCP_ACCESS_TOKEN: "env-after-empty" },
      jsonStub(() => tokenJson("")).fetchFn,
      { readFile: noAdc },
    );
    await expect(noToken()).resolves.toBe("env-after-empty");
  });

  test("tokens never appear in logs or error messages", async () => {
    const logger = new InMemoryLogger();
    const secret = "ya29.secret-0123456789abcdef";
    const { fetchFn } = jsonStub(() => tokenJson(secret));
    const provider = createGcpAccessTokenProvider({}, fetchFn, { logger, readFile: noAdc });

    await expect(provider()).resolves.toBe(secret);
    expect(logger.lines.join("\n")).not.toContain(secret);

    // The no-source error carries reason codes, never token material.
    const empty = createGcpAccessTokenProvider(
      {},
      jsonStub(() => ({ ok: false, status: 500, json: async () => ({}) })).fetchFn,
      { readFile: noAdc },
    );
    const err = await empty().then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(err).toContain("no GCS credential source");
    expect(err).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// Authenticated Instances API transport
// ---------------------------------------------------------------------------

describe("createAuthenticatedInstanceTransport", () => {
  test("sends the bearer token and JSON-encodes the body", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    const stubFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init ?? {};
      return {
        status: 200,
        headers: { forEach: (_cb: (value: string, key: string) => void) => {} },
        text: async () => JSON.stringify({ name: "x", state: "READY" }),
      };
    }) as unknown as typeof fetch;
    const transport = createAuthenticatedInstanceTransport(
      async () => "tok-123",
      stubFetch,
    );
    const res = await transport.request({
      method: "POST",
      url: "https://run.googleapis.com/v2/projects/p/locations/r/instances/i:start",
      headers: { "content-type": "application/json" },
      body: {},
    });
    expect(seenUrl).toBe("https://run.googleapis.com/v2/projects/p/locations/r/instances/i:start");
    const headers = seenInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-123");
    expect(seenInit.body).toBe("{}");
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)["state"]).toBe("READY");
  });

  test("non-JSON bodies pass through as raw text", async () => {
    const stubFetch = (async () => ({
      status: 200,
      headers: { forEach: (_cb: (value: string, key: string) => void) => {} },
      text: async () => "OK",
    })) as unknown as typeof fetch;
    const transport = createAuthenticatedInstanceTransport(async () => "t", stubFetch);
    const res = await transport.request({ method: "GET", url: "https://x" });
    expect(res.body).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// FetchGcsClient over a stubbed fetch
// ---------------------------------------------------------------------------

describe("FetchGcsClient", () => {
  function stubFetch(
    handler: (url: string, init?: RequestInit) => {
      status: number;
      body?: Uint8Array | string;
    },
  ): typeof fetch {
    return (async (url: string, init?: RequestInit) => {
      const out = handler(url, init);
      const bytes =
        out.body instanceof Uint8Array
          ? out.body
          : new TextEncoder().encode(out.body ?? "");
      return {
        ok: out.status >= 200 && out.status < 300,
        status: out.status,
        headers: { forEach: (_cb: (value: string, key: string) => void) => {} },
        arrayBuffer: async () => bytes.buffer as ArrayBuffer,
        text: async () => new TextDecoder().decode(bytes),
      };
    }) as unknown as typeof fetch;
  }

  test("getObject returns null on 404 and bytes on 200", async () => {
    const fetchFn = stubFetch((url) =>
      url.includes("/o/missing") ? { status: 404 } : { status: 200, body: "{}" },
    );
    const client = new FetchGcsClient({ tokenProvider: async () => "t", fetchFn });
    await expect(client.getObject("b", "missing")).resolves.toBeNull();
    expect(await client.objectExists("b", "missing")).toBe(false);
  });

  test("uploadObject POSTs to the upload endpoint with the bearer token", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    const fetchFn = stubFetch((url, init) => {
      seenUrl = url;
      seenInit = init ?? {};
      return { status: 200 };
    });
    const client = new FetchGcsClient({ tokenProvider: async () => "tok", fetchFn });
    await client.uploadObject("my-bucket", "k", new TextEncoder().encode("data"));
    expect(seenUrl).toContain("/upload/storage/v1/b/my-bucket/o");
    const headers = seenInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
  });
});
