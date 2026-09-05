// Stopped-Instance GC (issue #85 案A).
//
// Stopped Instances cost nothing (no storage/disk SKU — see #85) but the
// Instance OBJECTS accumulate: EnsureCreatedInstanceRuntime only ever
// creates/starts, and nothing ever deleted. The region quota is 100
// Instances per project and region, and whether stopped Instances consume it
// is UNCONFIRMED (docs/stopped-instance-gc.md) — so accumulation must stop.
//
// What this module does: periodically delete the Cloud Run Instance objects
// of workspaces that have been STOPPED and untouched for longer than
// `staleAfterMs` (default 30 days). The workspace ROW (Cloud SQL) and its
// GCS checkpoints stay: the next open() recreates the Instance from scratch
// and restores from the checkpoint. Deleting is safe to do aggressively
// because stopping already discarded all in-memory state — the only thing a
// kept Instance saves over a recreated one is a single `create` call.
//
// Safety rules (violating any of these is a bug):
// - ONLY `STOPPED` workspaces are eligible. READY/BUSY/CHECKPOINTING/
//   STOPPING/STARTING/RESTORING and the failure states (ERROR,
//   RESTORE_FAILED, CHECKPOINT_FAILED) are NEVER touched, no matter how stale.
// - A workspace with no `instanceName` is skipped (never opened — nothing to delete).
// - One workspace's delete failure never stops the sweep of the rest.
// - Every deletion (and every failure) is a structured log line carrying
//   workspaceId + instanceName.

import type { Logger } from "@cloud-run-dsh/observability";
import type {
  SessionPersistenceRepository,
  Workspace,
} from "@cloud-run-dsh/session-persistence-postgres";
import type { ControlPlaneClock, RuntimeRegistry, WorkspaceRuntimeHandle } from "./deps.js";

/** Default staleness threshold: 30 days without use. */
export const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Default sweep cadence: once an hour. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Default per-sweep delete cap. A sweep deletes at most this many Instances
 * (oldest-first); the rest wait for the next sweep. Bounds the blast radius
 * of a future eligibility bug or an operator error such as an absurdly small
 * `staleAfterMs`.
 */
export const DEFAULT_MAX_DELETES_PER_SWEEP = 10;

/**
 * The workspace's last-use instant: the newest of lastActivityAt,
 * updatedAt (bumped by every state transition — for a STOPPED workspace
 * this IS the stop time) and createdAt. Null when none of the three parses
 * (defensive: such rows are never GC-eligible).
 *
 * NOTE: as of #85, NOTHING in production writes `lastActivityAt` (only
 * tests do) — the effective max is over updatedAt/createdAt. lastActivityAt
 * stays in the max so a future writer is honored without a GC change.
 */
export function lastUsedAtMs(
  workspace: Pick<Workspace, "lastActivityAt" | "updatedAt" | "createdAt">,
): number | null {
  const candidates = [workspace.lastActivityAt, workspace.updatedAt, workspace.createdAt]
    .map((v) => (v == null ? NaN : Date.parse(v)))
    .filter((n) => Number.isFinite(n));
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

/**
 * GC eligibility (issue #85 案A). Pure — unit-test the matrix here, not
 * against GCP. Deliberately conservative: anything that is not provably a
 * long-idle STOPPED workspace with a known Instance name is ineligible.
 */
export function isGcEligible(
  workspace: Pick<
    Workspace,
    "runtimeState" | "instanceName" | "lastActivityAt" | "updatedAt" | "createdAt"
  >,
  nowMs: number,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): boolean {
  // Running or transitional states are NEVER eligible, however stale.
  if (workspace.runtimeState !== "STOPPED") return false;
  if (!workspace.instanceName) return false;
  const lastUsed = lastUsedAtMs(workspace);
  if (lastUsed === null) return false;
  return nowMs - lastUsed >= staleAfterMs;
}

export interface ReapDeps {
  readonly repo: SessionPersistenceRepository;
  /** Resolves the per-workspace handle whose deleteInstance() removes the Instance. */
  readonly runtimes: Pick<RuntimeRegistry, "get">;
  readonly clock: ControlPlaneClock;
  readonly logger?: Logger;
  readonly staleAfterMs?: number;
  readonly maxDeletesPerSweep?: number;
}

export interface ReapFailure {
  readonly workspaceId: string;
  readonly instanceName: string;
  readonly error: string;
}

export interface ReapResult {
  readonly checked: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly failed: number;
  /** Snapshot-eligible but skipped by the pre-delete re-read (state/name changed). */
  readonly skipped: number;
  /** Snapshot-eligible but left for a later sweep by the per-sweep cap. */
  readonly deferred: number;
  readonly failures: ReapFailure[];
}

/**
 * One sweep: deletes the Instances of every GC-eligible workspace.
 *
 * Two guards bound the damage a single sweep can do:
 * - Per-sweep cap: at most `maxDeletesPerSweep` Instances are deleted,
 *   oldest-first; the remainder is deferred to the next sweep and logged.
 * - Pre-delete re-read (TOCTOU): the snapshot from `listWorkspaces` only
 *   decides CANDIDACY. Just before deleting, the row is re-read and the
 *   delete proceeds only while the workspace is still STOPPED under the SAME
 *   `instanceName`. A concurrent open (READY + live Instance) or a rename
 *   between the list and the delete is skipped with a log line instead of
 *   deleting a live Instance. This is not full fencing (no CAS token exists
 *   on the row — adding one would mean a schema migration plus open-path
 *   changes for a 1/hour background job), but it shrinks the race window to
 *   a single API round-trip.
 *
 * Per-workspace isolation: a failure (Instances API error, DB error) is
 * recorded in the result + a structured ERROR log and the sweep continues
 * with the next workspace. After a successful delete the dead
 * `instanceUrl` is cleared so #22 forwarding never targets it; the
 * `instanceName` is kept so the next open() recreates the SAME name
 * (EnsureCreatedInstanceRuntime treats a missing Instance as create).
 */
export async function reapStaleStoppedInstances(deps: ReapDeps): Promise<ReapResult> {
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const maxDeletes = deps.maxDeletesPerSweep ?? DEFAULT_MAX_DELETES_PER_SWEEP;
  const nowMs = deps.clock.nowMs();
  const workspaces = await deps.repo.listWorkspaces();
  // Oldest-first so the cap always spares the most recently used workspaces.
  const candidates = workspaces
    .filter((workspace) => isGcEligible(workspace, nowMs, staleAfterMs))
    .sort((a, b) => lastUsedAtMs(a)! - lastUsedAtMs(b)!);
  const eligible = candidates.length;
  const batch = candidates.slice(0, Math.max(0, maxDeletes));
  const deferred = eligible - batch.length;
  if (deferred > 0) {
    deps.logger?.info("control-plane.instance-gc.deferred", {
      deferred,
      maxDeletesPerSweep: maxDeletes,
    });
  }
  const failures: ReapFailure[] = [];
  let deleted = 0;
  let skipped = 0;
  for (const workspace of batch) {
    // isGcEligible guarantees a non-empty instanceName; re-read it here so
    // TypeScript (and a defensive runtime) sees the same guard.
    const instanceName = workspace.instanceName;
    if (!instanceName) continue;
    try {
      const fresh = await deps.repo.getWorkspace(workspace.id);
      if (!fresh) {
        skipped++;
        deps.logger?.info("control-plane.instance-gc.skipped", {
          workspaceId: workspace.id,
          instanceName,
          reason: "workspace-gone",
        });
        continue;
      }
      if (fresh.runtimeState !== "STOPPED") {
        skipped++;
        deps.logger?.info("control-plane.instance-gc.skipped", {
          workspaceId: workspace.id,
          instanceName,
          // NOTE: the state travels as its own short field — a combined
          // `state-changed-to-READY` token would be masked by the
          // observability entropy redactor (20+ char run).
          reason: "state-changed",
          runtimeState: fresh.runtimeState,
        });
        continue;
      }
      if (fresh.instanceName !== instanceName) {
        skipped++;
        deps.logger?.info("control-plane.instance-gc.skipped", {
          workspaceId: workspace.id,
          instanceName,
          reason: "instance-renamed",
        });
        continue;
      }
      const handle: WorkspaceRuntimeHandle = await deps.runtimes.get(fresh);
      await handle.deleteInstance();
      await deps.repo.updateWorkspace(workspace.id, { instanceUrl: null });
      deleted++;
      deps.logger?.info("control-plane.instance-gc.deleted", {
        workspaceId: workspace.id,
        instanceName,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failures.push({ workspaceId: workspace.id, instanceName, error });
      deps.logger?.error("control-plane.instance-gc.failed", {
        workspaceId: workspace.id,
        instanceName,
        error,
      });
    }
  }
  return {
    checked: workspaces.length,
    eligible,
    deleted,
    failed: failures.length,
    skipped,
    deferred,
    failures,
  };
}

export interface SweeperOptions {
  /** Sweep cadence in ms. */
  readonly intervalMs: number;
}

/**
 * Background sweeper for the production composition root (main.ts): runs
 * reapStaleStoppedInstances on an interval. A failed SWEEP (e.g.
 * listWorkspaces itself threw — no per-workspace accounting exists then) is
 * logged and the next tick still runs. The timer is unref'd so it never
 * keeps the process alive on its own.
 */
export function startStoppedInstanceSweeper(
  deps: ReapDeps,
  opts: SweeperOptions,
): { stop(): void } {
  const sweep = (): void => {
    void reapStaleStoppedInstances(deps).catch((e: unknown) => {
      deps.logger?.error("control-plane.instance-gc.sweep-failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  };
  const timer = setInterval(sweep, opts.intervalMs);
  const unrefable = timer as unknown as { unref?: () => void };
  if (typeof unrefable.unref === "function") unrefable.unref();
  return { stop: () => clearInterval(timer) };
}
