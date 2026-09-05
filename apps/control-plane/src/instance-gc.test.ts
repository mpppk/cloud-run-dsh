// Tests for the stopped-Instance GC (issue #85 案A).
// No real GCP: the repository is the shared InMemoryFakeExecutor, runtimes
// are recording stubs, the clock is manual.

import { describe, expect, test } from "bun:test";
import { InMemoryLogger } from "@cloud-run-dsh/observability";
import { PostgresSessionPersistenceRepository } from "@cloud-run-dsh/session-persistence-postgres";
import type {
  Workspace,
  WorkspaceRuntimeState,
} from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import type { ControlPlaneClock } from "./deps.js";
import {
  DEFAULT_STALE_AFTER_MS,
  isGcEligible,
  lastUsedAtMs,
  reapStaleStoppedInstances,
  startStoppedInstanceSweeper,
  type ReapDeps,
} from "./instance-gc.js";

const NOW_MS = new Date("2026-09-05T00:00:00Z").getTime();
const STALE_MS = 1_000;
const OLD_ISO = new Date(NOW_MS - 60_000).toISOString();
const FRESH_ISO = new Date(NOW_MS - 500).toISOString();

const clock: ControlPlaneClock = {
  now: () => new Date(NOW_MS),
  nowMs: () => NOW_MS,
};

function baseWorkspace(
  override: Partial<Workspace> = {},
): Pick<
  Workspace,
  "runtimeState" | "instanceName" | "lastActivityAt" | "updatedAt" | "createdAt"
> {
  return {
    runtimeState: "STOPPED",
    instanceName: "dsh-ws-1",
    lastActivityAt: null,
    updatedAt: OLD_ISO,
    createdAt: OLD_ISO,
    ...override,
  };
}

// ---------------------------------------------------------------------------
// lastUsedAtMs
// ---------------------------------------------------------------------------

describe("lastUsedAtMs", () => {
  test("takes the newest of lastActivityAt / updatedAt / createdAt", () => {
    expect(
      lastUsedAtMs({ lastActivityAt: FRESH_ISO, updatedAt: OLD_ISO, createdAt: OLD_ISO }),
    ).toBe(Date.parse(FRESH_ISO));
    expect(
      lastUsedAtMs({ lastActivityAt: null, updatedAt: OLD_ISO, createdAt: OLD_ISO }),
    ).toBe(Date.parse(OLD_ISO));
  });

  test("null when nothing parses", () => {
    expect(
      lastUsedAtMs({ lastActivityAt: null, updatedAt: "not-a-date", createdAt: "" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isGcEligible — the "never delete what must not be deleted" matrix
// ---------------------------------------------------------------------------

describe("isGcEligible", () => {
  const ALL_STATES: WorkspaceRuntimeState[] = [
    "STOPPED",
    "STARTING",
    "RESTORING",
    "READY",
    "BUSY",
    "CHECKPOINTING",
    "STOPPING",
    "ERROR",
    "RESTORE_FAILED",
    "CHECKPOINT_FAILED",
  ];

  test("only STOPPED is ever eligible, however stale", () => {
    for (const runtimeState of ALL_STATES) {
      const eligible = isGcEligible(
        baseWorkspace({ runtimeState }),
        NOW_MS,
        STALE_MS,
      );
      expect(eligible, `state ${runtimeState}`).toBe(runtimeState === "STOPPED");
    }
  });

  test("STOPPED but fresh is not eligible", () => {
    expect(
      isGcEligible(
        baseWorkspace({ updatedAt: FRESH_ISO, createdAt: FRESH_ISO }),
        NOW_MS,
        STALE_MS,
      ),
    ).toBe(false);
  });

  test("STOPPED and stale but without an instanceName is not eligible", () => {
    expect(isGcEligible(baseWorkspace({ instanceName: null }), NOW_MS, STALE_MS)).toBe(
      false,
    );
  });

  test("STOPPED and stale with an instanceName is eligible", () => {
    expect(isGcEligible(baseWorkspace(), NOW_MS, STALE_MS)).toBe(true);
  });

  test("unparseable timestamps are never eligible (fail closed)", () => {
    expect(
      isGcEligible(
        baseWorkspace({ lastActivityAt: null, updatedAt: "garbage", createdAt: "" }),
        NOW_MS,
        STALE_MS,
      ),
    ).toBe(false);
  });

  test("last-use in the future (clock skew) is not eligible", () => {
    const future = new Date(NOW_MS + 60_000).toISOString();
    expect(
      isGcEligible(
        baseWorkspace({ updatedAt: future, createdAt: future }),
        NOW_MS,
        STALE_MS,
      ),
    ).toBe(false);
  });

  test("recent activity protects an otherwise old STOPPED workspace", () => {
    expect(
      isGcEligible(
        baseWorkspace({ updatedAt: OLD_ISO, createdAt: OLD_ISO, lastActivityAt: FRESH_ISO }),
        NOW_MS,
        STALE_MS,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reapStaleStoppedInstances
// ---------------------------------------------------------------------------

class RecordingHandle {
  deleteCalls = 0;
  constructor(private readonly behavior: "ok" | "fail" = "ok") {}
  async deleteInstance(): Promise<void> {
    this.deleteCalls++;
    if (this.behavior === "fail") throw new Error("Instances API delete failed (boom)");
  }
}

interface ReapHarness {
  repo: PostgresSessionPersistenceRepository;
  executor: InMemoryFakeExecutor;
  handles: Map<string, RecordingHandle>;
  logger: InMemoryLogger;
  deps: ReapDeps;
  seed: (
    id: string,
    patch: {
      runtimeState?: WorkspaceRuntimeState;
      instanceName?: string | null;
      instanceUrl?: string | null;
      backdateMs?: number;
    },
  ) => Promise<Workspace>;
}

function startReapHarness(failIds: Set<string> = new Set()): ReapHarness {
  const executor = new InMemoryFakeExecutor();
  const repo = new PostgresSessionPersistenceRepository(executor);
  const handles = new Map<string, RecordingHandle>();
  const logger = new InMemoryLogger();
  const deps: ReapDeps = {
    repo,
    runtimes: {
      get: async (workspace: Workspace) => {
        let handle = handles.get(workspace.id);
        if (!handle) {
          handle = new RecordingHandle(failIds.has(workspace.id) ? "fail" : "ok");
          handles.set(workspace.id, handle);
        }
        return handle as unknown as import("./deps.js").WorkspaceRuntimeHandle;
      },
    },
    clock,
    logger,
    staleAfterMs: STALE_MS,
  };
  return {
    repo,
    executor,
    handles,
    logger,
    deps,
    seed: async (id, patch) => {
      await repo.createWorkspace({
        id,
        ownerId: "alice",
        repositoryOwner: "mpppk",
        repositoryName: "demo",
        baseBranch: "main",
        // Explicit null (never opened) must survive: ?? would replace it.
        instanceName: "instanceName" in patch ? patch.instanceName : `dsh-${id}`,
        instanceUrl: "instanceUrl" in patch ? patch.instanceUrl : `https://${id}.run.app`,
        runtimeState: patch.runtimeState ?? "STOPPED",
      });
      // Backdate the row: updatedAt is the stop-time signal, but the fake
      // stamps now() on every write, so reach into the fake to simulate age.
      // lastActivityAt stays null — updatedAt alone decides staleness here.
      if (patch.backdateMs !== undefined) {
        const row = executor.__getTables().workspaces.get(id);
        if (!row) throw new Error(`seed workspace missing: ${id}`);
        const backdated = new Date(NOW_MS - patch.backdateMs).toISOString();
        row.updatedAt = backdated;
        row.createdAt = backdated;
      }
      const reread = await repo.getWorkspace(id);
      if (!reread) throw new Error(`seed workspace missing after backdate: ${id}`);
      return reread;
    },
  };
}

describe("reapStaleStoppedInstances", () => {
  test("deletes ONLY the long-idle STOPPED workspace; running/fresh/nameless rows are untouched", async () => {
    const h = startReapHarness();
    await h.seed("ws-stale", { backdateMs: 60_000 });
    await h.seed("ws-fresh", {});
    await h.seed("ws-ready", { runtimeState: "READY", backdateMs: 60_000 });
    await h.seed("ws-stopping", { runtimeState: "STOPPING", backdateMs: 60_000 });
    await h.seed("ws-error", { runtimeState: "ERROR", backdateMs: 60_000 });
    await h.seed("ws-noname", { instanceName: null, instanceUrl: null, backdateMs: 60_000 });

    const result = await reapStaleStoppedInstances(h.deps);

    expect(result.checked).toBe(6);
    expect(result.eligible).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.failed).toBe(0);

    // Only the eligible workspace's handle saw a delete.
    expect(h.handles.get("ws-stale")?.deleteCalls).toBe(1);
    for (const id of ["ws-fresh", "ws-ready", "ws-stopping", "ws-error", "ws-noname"]) {
      expect(h.handles.get(id)?.deleteCalls ?? 0, id).toBe(0);
    }

    // The deleted workspace keeps its row + instanceName (next open()
    // recreates the same name) but the dead URL is cleared.
    const reread = await h.repo.getWorkspace("ws-stale");
    expect(reread?.instanceName).toBe("dsh-ws-stale");
    expect(reread?.instanceUrl).toBeNull();
    expect(reread?.runtimeState).toBe("STOPPED");

    // Untouched rows keep their URLs.
    expect((await h.repo.getWorkspace("ws-ready"))?.instanceUrl).toBe(
      "https://ws-ready.run.app",
    );

    // Structured log carries workspaceId + instanceName.
    const deleted = h.logger.parsed.find((e) => e["event"] === "control-plane.instance-gc.deleted");
    expect(deleted).toBeTruthy();
    expect(deleted!["workspaceId"]).toBe("ws-stale");
    expect(deleted!["instanceName"]).toBe("dsh-ws-stale");
  });

  test("one workspace's failure does not stop the sweep; failures are logged with ids", async () => {
    const h = startReapHarness(new Set(["ws-bad"]));
    await h.seed("ws-bad", { backdateMs: 60_000 });
    await h.seed("ws-good", { backdateMs: 60_000 });

    const result = await reapStaleStoppedInstances(h.deps);

    expect(result.eligible).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      workspaceId: "ws-bad",
      instanceName: "dsh-ws-bad",
    });
    expect(typeof result.failures[0]!.error).toBe("string");

    const failed = h.logger.parsed.find((e) => e["event"] === "control-plane.instance-gc.failed");
    expect(failed).toBeTruthy();
    expect(failed!["workspaceId"]).toBe("ws-bad");
    expect(failed!["instanceName"]).toBe("dsh-ws-bad");

    // The good workspace was still swept despite the earlier failure.
    expect(h.handles.get("ws-good")?.deleteCalls).toBe(1);
    expect((await h.repo.getWorkspace("ws-good"))?.instanceUrl).toBeNull();
    // The failed workspace keeps its (possibly dead) URL — a later sweep retries.
    expect((await h.repo.getWorkspace("ws-bad"))?.instanceUrl).toBe(
      "https://ws-bad.run.app",
    );
  });

  test("empty project sweeps cleanly", async () => {
    const h = startReapHarness();
    expect(await reapStaleStoppedInstances(h.deps)).toEqual({
      checked: 0,
      eligible: 0,
      deleted: 0,
      failed: 0,
      failures: [],
    });
  });
});

describe("startStoppedInstanceSweeper", () => {
  test("sweeps on the interval; stop() halts it", async () => {
    const h = startReapHarness();
    await h.seed("ws-stale", { backdateMs: 60_000 });
    const sweeper = startStoppedInstanceSweeper(h.deps, { intervalMs: 10 });
    try {
      const deadline = Date.now() + 2000;
      while (
        (await h.repo.getWorkspace("ws-stale"))?.instanceUrl !== null &&
        Date.now() < deadline
      ) {
        await Bun.sleep(10);
      }
      expect((await h.repo.getWorkspace("ws-stale"))?.instanceUrl).toBeNull();
      expect(h.handles.get("ws-stale")?.deleteCalls).toBe(1);
    } finally {
      sweeper.stop();
    }
    const callsAfterStop = h.handles.get("ws-stale")?.deleteCalls ?? 0;
    await Bun.sleep(50);
    expect(h.handles.get("ws-stale")?.deleteCalls).toBe(callsAfterStop);
  });
});
