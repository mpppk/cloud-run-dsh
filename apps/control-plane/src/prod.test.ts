// Tests for the production configuration + adapters (P3 Dockerfile task).
// No real Postgres required — SQL seams are exercised with a tiny fake.

import { describe, expect, test } from "bun:test";
import {
  MissingRequiredEnvError,
  readControlPlaneConfig,
} from "./config.js";
import {
  BunSqlLeaseStore,
  createPlaceholderRuntimeRegistry,
  OwnerMembershipStore,
  RuntimeNotWiredError,
} from "./prod-adapters.js";
import type { QueryExecutor } from "@cloud-run-dsh/session-persistence-postgres";
import type { ControllerLeaseRecord } from "@cloud-run-dsh/controller-lease";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe("readControlPlaneConfig", () => {
  test("missing DATABASE_URL -> MissingRequiredEnvError listing the key", () => {
    try {
      readControlPlaneConfig({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MissingRequiredEnvError);
      expect((e as MissingRequiredEnvError).missing).toEqual(["DATABASE_URL"]);
    }
  });

  test("blank DATABASE_URL is treated as missing", () => {
    expect(() => readControlPlaneConfig({ DATABASE_URL: "   " })).toThrow(
      MissingRequiredEnvError,
    );
  });

  test("PORT defaults to 8080 (Cloud Run injects PORT in production)", () => {
    const config = readControlPlaneConfig({ DATABASE_URL: "postgres://x" });
    expect(config.port).toBe(8080);
  });

  test("PORT is parsed from the environment", () => {
    const config = readControlPlaneConfig({
      DATABASE_URL: "postgres://x",
      PORT: "9090",
    });
    expect(config.port).toBe(9090);
  });

  test("invalid PORT is rejected", () => {
    expect(() =>
      readControlPlaneConfig({ DATABASE_URL: "postgres://x", PORT: "not-a-number" }),
    ).toThrow(/invalid PORT/);
    expect(() =>
      readControlPlaneConfig({ DATABASE_URL: "postgres://x", PORT: "70000" }),
    ).toThrow(/invalid PORT/);
  });
});

// ---------------------------------------------------------------------------
// placeholder runtime registry
// ---------------------------------------------------------------------------

describe("placeholder runtime registry", () => {
  const workspace = {
    id: "ws-1",
    ownerId: "alice",
    repositoryOwner: "mpppk",
    repositoryName: "demo",
    baseBranch: "main",
    instanceName: null,
    instanceUrl: null,
    runtimeState: "STOPPED",
    lastActivityAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as const;

  test("factory rejects with the dedicated RuntimeNotWiredError, never a generic Error", async () => {
    const registry = createPlaceholderRuntimeRegistry();
    try {
      await registry.get(workspace);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RuntimeNotWiredError);
      const err = e as RuntimeNotWiredError;
      expect(err.status).toBe(503);
      expect(err.code).toBe("unavailable");
      expect(err.message).toContain("RuntimeRegistry is not wired yet");
      expect(err.message).toContain("P11a");
      expect(err.message).toContain("instance client");
      expect(err.message).toContain("checkpoint storage");
      expect(err.message).toContain("GCS");
    }
  });

  test("RuntimeNotWiredError is an ApiError so routes answer a typed 503", () => {
    const err = new RuntimeNotWiredError();
    expect(err.name).toBe("RuntimeNotWiredError");
    expect(err.status).toBe(503);
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
