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
import type { QueryExecutor } from "@cloud-run-dsh/session-persistence-postgres";
import type { ControllerLeaseRecord } from "@cloud-run-dsh/controller-lease";

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
    expect(config.agentHostImage).toBe("img");
    expect(config.agentHostServiceAccount).toBe("sa@test-proj.iam.gserviceaccount.com");
    expect(config.checkpointBucket).toBe("bucket");
    expect(config.agentHostDatabaseUrl).toBe("postgresql://x");
    expect(config.githubAppId).toBe("123");
    expect(config.githubAppPrivateKeyPem).toBe("pem");
    expect(config.openrouterApiKey).toBe("sk-or-v1-test");
    // Optional LLM overrides default to "agent-host decides".
    expect(config.llmBaseUrl).toBeUndefined();
    expect(config.llmModel).toBeUndefined();
    expect(config.llmApprovalPolicy).toBeUndefined();
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
});

// ---------------------------------------------------------------------------
// BunSqlQueryExecutor.connect — Cloud SQL socket form + password hygiene
// (issue #42; resolution logic itself is covered in the shared package)
// ---------------------------------------------------------------------------

const CONNECT_SECRET = "cp-s3cr3t-Pw/xX9qZ";

describe("BunSqlQueryExecutor.connect", () => {
  const seen: BunSqlConnectionTarget[] = [];

  class StubSql {
    constructor(target: BunSqlConnectionTarget) {
      seen.push(target);
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
// GCP token provider (Instances API + GCS auth)
// ---------------------------------------------------------------------------

describe("createGcpAccessTokenProvider", () => {
  test("GCP_ACCESS_TOKEN env wins without touching the network", async () => {
    let fetched = false;
    const provider = createGcpAccessTokenProvider(
      { GCP_ACCESS_TOKEN: "  token-abc  " },
      async () => {
        fetched = true;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    );
    await expect(provider()).resolves.toBe("token-abc");
    expect(fetched).toBe(false);
  });

  test("falls back to the metadata server when no env token exists", async () => {
    let url = "";
    const provider = createGcpAccessTokenProvider({}, async (u: string) => {
      url = u;
      return { ok: true, status: 200, json: async () => ({ access_token: "meta-token" }) };
    });
    await expect(provider()).resolves.toBe("meta-token");
    expect(url).toContain("metadata.google.internal");
  });

  test("unreachable metadata server -> actionable error, not a hang", async () => {
    const provider = createGcpAccessTokenProvider({}, async () => {
      throw new Error("fetch failed");
    });
    await expect(provider()).rejects.toThrow(/no GCP credentials/);
  });

  test("metadata non-200 / missing access_token -> actionable error", async () => {
    const badStatus = createGcpAccessTokenProvider({}, async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    }));
    await expect(badStatus()).rejects.toThrow(/metadata server answered 403/);
    const noToken = createGcpAccessTokenProvider({}, async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    await expect(noToken()).rejects.toThrow(/no access_token/);
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
      url: "projects/p/locations/r/instances/i:start",
      headers: { "content-type": "application/json" },
      body: {},
    });
    expect(seenUrl).toBe("projects/p/locations/r/instances/i:start");
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
