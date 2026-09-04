// Postgres-backed DSH session persistence (issue #39): the `ctx.sessionPersistence`
// service AgentLoop.resume() requires, implemented over the shared
// SessionPersistenceRepository both sides already use.
//
// Why this exists: the host keeps NO local disk across a Cloud Run Instance
// recreation, so the JSONL backend (local files) cannot be the resume source.
// The durable log IS the shared Postgres event table — turn.ts already
// persists every DSH `session/event` there (verbatim type/data, `user/message`
// excluded because the control plane owns `user_message`). This service reads
// those rows back into DSH SessionEvents so a fresh process can resume agents
// for existing sessions instead of starting empty ones.
//
// Mapping (replay, not 1:1 — stored seqs are NOT DSH seqs):
//
// The stored table and the live DSH log number differently, and stored
// citations (sourceEventSeqs) live in TRUE (DSH) space:
//   - turn.ts persists every DSH event except `user/message`, but the control
//     plane's `user_message` row occupies stored seqs without a DSH
//     counterpart, and each live turn contains user/message events the table
//     never sees: the consumed user text plus plugin runtime-context
//     snapshots (measured: a 2-step text turn holds 27 live events vs 25
//     stored rows — and the snapshot count VARIES per step: a tool turn's
//     second step carries none). Replaying rows in stored order, or assuming
//     a fixed per-step skip count, breaks citations.
//   - Reconstruction therefore avoids true-numbering entirely:
//     * Order: verbatim rows in stored order; each stored `user_message`
//       becomes ONE converted text placed after the first step/start
//       following the latest turn/start (its consuming step — measured:
//       turn/start … step/start … text … snapshot … request/header);
//       messages with no later step (never consumed — e.g. the forward
//       failed) trail at the end as the pending history they are.
//       `approval`/`cancel` rows never entered the DSH log and are dropped
//       (the table keeps them as the SSE audit source). Snapshots are
//       runtime context the live plugin regenerates — replaying stale policy
//       text as history would be wrong.
//     * Citations: each stored citation run is resolved by RANK, not by
//       value — the k cited seqs correspond to the k verbatim replay rows
//       immediately preceding the citer (measured: a message cites its
//       step's chunk run, a tool/result cites its call, always adjacent).
//       Rank resolution is immune to however many snapshots the live log
//       held. The mapping is self-validating: citations must ascend, every
//       target must precede the citer, and known citer kinds must cite
//       known target kinds (message->chunks, result->call) — anything else
//       fails loud instead of resuming a corrupt session.
//   - Converted texts carry deterministic ids (`resumed-<sessionId>-<seq>`)
//     and `surfaceOp: 'append'` (surface-eligible events require a placement
//     marker on restore).
//
// Write discipline: the live write path stays EXACTLY where #21 put it
// (turn.ts's session/event subscription -> repository.append). This service
// performs no background writes — `append` below exists only to honor the
// Service contract and applies the same `user/message` single-writer filter.
// Nothing in-process calls it today; the coordinator that would call it is
// deliberately NOT mounted (its adopt-on-create path rejects a live session
// whose seed does not cover the control-plane-first rows).

import type { Context } from "@deepseek-ai/cordis";
import { MessageId } from "@deepseek-ai/dsh-llm";
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from "@deepseek-ai/dsh-session";
import type {
  SessionEvent,
  SessionHeader,
} from "@deepseek-ai/dsh-session";
import {
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
} from "@deepseek-ai/dsh-session-persistence";
import type {
  BorrowedSessionSource,
  SessionEventSuffix,
  SessionInspection,
  SessionLocation,
  SessionPersistenceSnapshot,
} from "@deepseek-ai/dsh-session-persistence";
import type { Logger } from "@cloud-run-dsh/observability";
import type {
  Session,
  SessionEvent as StoredEvent,
  SessionPersistenceRepository,
} from "@cloud-run-dsh/session-persistence-postgres";

export interface PostgresSessionPersistenceOptions {
  readonly repository: SessionPersistenceRepository;
  /** The single workspace this host serves (cross-workspace reads are refused). */
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly logger: Logger;
}

/** Stored log change token: session + length + last row identity. */
function revisionFor(sessionId: string, rows: readonly StoredEvent[]): ReturnType<typeof SessionPersistenceRevision> {
  const last = rows.length === 0 ? "empty" : `${rows[rows.length - 1]!.seq}:${rows[rows.length - 1]!.eventTime}`;
  return SessionPersistenceRevision(`${sessionId}:${rows.length}:${last}`);
}

export class PostgresSessionPersistence extends SessionPersistence {
  readonly name = "session-persistence-postgres";
  /** No per-session local artifact: the log lives in the shared Postgres table. */
  readonly supportsRawArtifacts = false as const;
  private readonly repository: SessionPersistenceRepository;
  private readonly workspaceId: string;
  private readonly workspaceRoot: string;
  private readonly logger: Logger;

  constructor(ctx: Context, opts: PostgresSessionPersistenceOptions) {
    super(ctx);
    this.repository = opts.repository;
    this.workspaceId = opts.workspaceId;
    this.workspaceRoot = opts.workspaceRoot;
    this.logger = opts.logger;
  }

  /** No per-session local artifact: the log lives in the shared Postgres table. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined;
  }

  /**
   * Sessions are control-plane-owned: the row must already exist (same
   * fail-loud rule as HarnessTurnStarter.startTurn). Never invents one here —
   * a host-side create would orphan the loop's events. Fork lineage is not
   * tracked in the row, so an inherited count is accepted and ignored.
   */
  async create(meta: SessionHeader, _inheritedEventCount?: SessionLogOffset): Promise<void> {
    const row = await this.repository.getSession(meta.id as string);
    if (!row) {
      throw new SessionPersistenceNotFoundError(meta.id);
    }
    if (row.workspaceId !== this.workspaceId) {
      throw new Error(
        `cannot persist session ${meta.id as string}: belongs to workspace ${row.workspaceId}`,
      );
    }
  }

  /**
   * Durably persist one batch, honoring the #22 single-writer invariant: the
   * control plane owns `user_message`, so `user/message` copies are filtered
   * here exactly as in turn.ts's live subscription.
   */
  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const rows = events
      .filter((e) => e.type !== "user/message")
      .map((e) => {
        const record = e as unknown as Record<string, unknown>;
        return {
          eventType: e.type,
          eventTime: e.time,
          data: e.data as unknown,
          ...("sourceEventSeqs" in record && record["sourceEventSeqs"] !== undefined
            ? { sourceEventSeqs: record["sourceEventSeqs"] }
            : {}),
          ...("surfaceOp" in record && record["surfaceOp"] !== undefined
            ? { surfaceOp: record["surfaceOp"] }
            : {}),
        };
      });
    if (rows.length === 0) return;
    await this.repository.append(id as string, rows);
  }

  /**
   * Load the immutable stored view for resume. Fails loud (never empty):
   * a missing row, a foreign workspace, a corrupt timestamp, a gapped log,
   * or an unconvertible row must surface — silently resuming an empty agent
   * would look like deleted history (issue #39).
   */
  async load(id: SessionId): Promise<SessionInspection> {
    const { row, stored } = await this.readStored(id);
    const meta = toHeader(row, this.workspaceRoot);
    const events = toDshEvents(row.id, stored);
    this.logger.info("persistence.session.loaded", {
      sessionId: row.id,
      eventCount: events.length,
    });
    return { meta, inheritedEventCount: SessionLogOffset(0), events };
  }

  /** No recovery to commit — the stored view IS the logical view. */
  async inspect(id: SessionId): Promise<SessionInspection> {
    return this.load(id);
  }

  /**
   * Borrow an exact unpublished Session for one observation. No preparation
   * cache is kept (each call builds a fresh unpublished session from the
   * stored rows), so disposal releases nothing — the session was never
   * entered into the store.
   */
  async borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    signal?.throwIfAborted();
    const loaded = await this.load(id);
    signal?.throwIfAborted();
    const sessions = this.ctx.sessions;
    if (sessions === undefined) {
      throw new Error("cannot borrow a session: SessionStore is not configured");
    }
    const preparedSession = sessions.prepare(id, {
      seed: loaded.events.map((event) => structuredClone(event)),
      meta: structuredClone(loaded.meta),
      inheritedEventCount: SessionLogOffset(loaded.inheritedEventCount),
      seedSource: "persistence",
    });
    const { row, stored } = await this.readStored(id);
    void row;
    return {
      source: "prepared",
      inspection: loaded,
      revision: revisionFor(id as string, stored),
      preparedSession,
      [Symbol.dispose]() {},
    };
  }

  async readFrom(id: SessionId, fromSeq: SessionLogOffset): Promise<SessionEventSuffix> {
    const offset = fromSeq as number;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(
        `readFrom fromSeq must be a non-negative safe integer, got ${String(offset)}`,
      );
    }
    const loaded = await this.load(id);
    return {
      meta: loaded.meta,
      inheritedEventCount: loaded.inheritedEventCount,
      fromSeq: SessionLogOffset(offset),
      events: loaded.events.slice(offset),
    };
  }

  async list(): Promise<SessionHeader[]> {
    const sessions = await this.repository.listSessions(this.workspaceId);
    return sessions.map((s) => toHeader(s, this.workspaceRoot));
  }

  async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    const sessions = await this.repository.listSessions(this.workspaceId);
    const snapshots: SessionPersistenceSnapshot[] = [];
    for (const s of sessions) {
      const stored = await this.repository.readEvents(s.id);
      snapshots.push({ header: toHeader(s, this.workspaceRoot), revision: revisionFor(s.id, stored) });
    }
    return snapshots;
  }

  private async readStored(id: SessionId): Promise<{ row: Session; stored: StoredEvent[] }> {
    const sessionId = id as string;
    const row = await this.repository.getSession(sessionId);
    if (!row) {
      throw new SessionPersistenceNotFoundError(id);
    }
    if (row.workspaceId !== this.workspaceId) {
      throw new Error(
        `cannot resume session ${sessionId}: belongs to workspace ${row.workspaceId}`,
      );
    }
    const stored = await this.repository.readEvents(sessionId);
    assertContiguous(sessionId, stored);
    return { row, stored };
  }
}

function toHeader(row: Session, workspaceRoot: string): SessionHeader {
  const createdAt = Date.parse(row.createdAt);
  if (!Number.isFinite(createdAt)) {
    throw new Error(`cannot resume session ${row.id}: corrupt createdAt ${row.createdAt}`);
  }
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(row.id),
    createdAt,
    cwd: workspaceRoot,
    isSeeded: false,
  };
}

function assertContiguous(sessionId: string, rows: readonly StoredEvent[]): void {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.seq !== i) {
      throw new Error(
        `cannot resume session ${sessionId}: gap in stored log (expected seq ${i}, found ${rows[i]!.seq})`,
      );
    }
  }
}

/**
 * Converts stored rows to DSH events in replay order (see module doc).
 * Throws on rows it cannot faithfully convert — the caller (load) surfaces
 * the failure instead of resuming a gutted session.
 */
export function toDshEvents(sessionId: string, rows: readonly StoredEvent[]): SessionEvent[] {
  // Replay order: verbatim rows in stored order; each consumed user_message
  // becomes one text after the first step/start following the latest
  // turn/start; never-consumed tails trail at the end; approval/cancel drop.
  type Item = { readonly kind: "verbatim"; readonly row: StoredEvent } | {
    readonly kind: "user";
    readonly row: StoredEvent;
  };
  const ordered: Item[] = [];
  const pendingReplay: StoredEvent[] = [];
  let stepSeenReplay = true;
  for (const row of rows) {
    if (row.eventType === "user_message") {
      pendingReplay.push(row);
      continue;
    }
    if (row.eventType === "approval" || row.eventType === "cancel") {
      continue;
    }
    if (row.eventType === "turn/start") {
      ordered.push({ kind: "verbatim", row });
      stepSeenReplay = false;
      continue;
    }
    if (row.eventType === "step/start") {
      ordered.push({ kind: "verbatim", row });
      if (!stepSeenReplay) {
        for (const queued of pendingReplay.splice(0)) {
          ordered.push({ kind: "user", row: queued });
        }
        stepSeenReplay = true;
      }
      continue;
    }
    ordered.push({ kind: "verbatim", row });
  }
  for (const queued of pendingReplay.splice(0)) {
    ordered.push({ kind: "user", row: queued });
  }

  // Citation bridge by rank: the k cited seqs correspond to the k citable
  // replay rows immediately preceding the citer. Values are only checked for
  // shape (integers, ascending) — positions do the resolving. Approval audit
  // rows (asked/decided) are skipped in the walk: they interleave between a
  // tool/call and its tool/result in the log but are never cited themselves
  // (measured live: result cites the call across the audit pair).
  const NEVER_CITED_AUDIT = new Set(["approval/asked", "approval/decided"]);
  const remapCitations = (
    rowSeq: number,
    citerType: string,
    citations: unknown,
  ): number[] => {
    if (!Array.isArray(citations) || citations.length === 0) {
      throw new Error(
        `cannot resume session ${sessionId}: corrupt sourceEventSeqs at seq ${rowSeq}`,
      );
    }
    for (const c of citations) {
      if (typeof c !== "number" || !Number.isInteger(c)) {
        throw new Error(
          `cannot resume session ${sessionId}: corrupt seq citation ${String(c)}`,
        );
      }
    }
    const ascending = (citations as number[]).every(
      (c, i, arr) => i === 0 || (arr[i - 1] as number) < c,
    );
    if (!ascending) {
      throw new Error(
        `cannot resume session ${sessionId}: non-ascending citations at seq ${rowSeq}`,
      );
    }
    const citerIndex = ordered.findIndex(
      (item) => item.kind === "verbatim" && item.row.seq === rowSeq,
    );
    const predecessors: number[] = [];
    for (let i = citerIndex - 1; i >= 0 && predecessors.length < citations.length; i--) {
      const item = ordered[i]!;
      if (item.kind !== "verbatim") continue;
      if (NEVER_CITED_AUDIT.has(item.row.eventType)) continue;
      predecessors.unshift(i);
    }
    if (predecessors.length < citations.length) {
      throw new Error(
        `cannot resume session ${sessionId}: dangling seq citation at seq ${rowSeq}`,
      );
    }
    assertCitationKinds(sessionId, rowSeq, citerType, predecessors);
    return predecessors;
  };

  return ordered.map((item, index) => {
    const seq = SessionSeq(index);
    if (item.kind === "user") {
      return convertedUserMessage(sessionId, item.row, seq);
    }
    const row = item.row;
    const base: Record<string, unknown> = {
      type: row.eventType,
      seq,
      time: row.eventTime,
      data: row.data,
    };
    if (row.sourceEventSeqs !== undefined && row.sourceEventSeqs !== null) {
      base["sourceEventSeqs"] = remapCitations(row.seq, row.eventType, row.sourceEventSeqs);
    }
    if (row.surfaceOp !== undefined && row.surfaceOp !== null) {
      base["surfaceOp"] = remapSurfaceOp(sessionId, row.seq, row.surfaceOp);
    }
    // Any other non-DSH vocabulary stays out: only control-plane rows use
    // foreign types and they were dropped above. An unknown survivor fails
    // the restore validation instead of being silently skipped.
    return base as unknown as SessionEvent;
  });

  /** Known citer->target shapes; anything else fails loud (never mis-cited). */
  function assertCitationKinds(
    sessionId: string,
    rowSeq: number,
    citerType: string,
    predecessors: readonly number[],
  ): void {
    const types = predecessors.map(
      (i) => (ordered[i]!.row.eventType),
    );
    if (citerType === "assistant/message") {
      if (!types.every((t) => t === "assistant/chunk")) {
        throw new Error(
          `cannot resume session ${sessionId}: assistant/message at seq ${rowSeq} cites non-chunk events (${types.join(",")})`,
        );
      }
      return;
    }
    if (citerType === "tool/result") {
      if (types.length !== 1 || types[0] !== "tool/call") {
        throw new Error(
          `cannot resume session ${sessionId}: tool/result at seq ${rowSeq} does not cite its call (${types.join(",")})`,
        );
      }
      return;
    }
    throw new Error(
      `cannot resume session ${sessionId}: unsupported citing event ${citerType} at seq ${rowSeq}`,
    );
  }
}

function convertedUserMessage(
  sessionId: string,
  row: StoredEvent,
  seq: ReturnType<typeof SessionSeq>,
): SessionEvent {
  const content =
    typeof row.data === "object" && row.data !== null
      ? (row.data as Record<string, unknown>)["content"]
      : undefined;
  if (typeof content !== "string") {
    throw new Error(
      `cannot resume session ${sessionId}: corrupt user_message at seq ${row.seq}`,
    );
  }
  return {
    type: "user/message",
    seq,
    time: row.eventTime,
    data: {
      id: MessageId(`resumed-${sessionId}-${row.seq}`),
      role: "user",
      content: [{ type: "text", text: content }],
      source: { kind: "user" },
    },
    // Surface-eligible events require a placement marker on restore.
    // The live loop appends user messages to the tail ('append'); the
    // control-plane row carries no marker, so it is restored here.
    surfaceOp: "append",
  } as unknown as SessionEvent;
}

/** SurfaceOp passthrough — replace bounds need true seqs this replay does not
 * keep, so a replace op (compaction history, which this host never produces)
 * fails loud instead of being mis-numbered. */
function remapSurfaceOp(
  sessionId: string,
  rowSeq: number,
  surfaceOp: unknown,
): unknown {
  if (typeof surfaceOp === "string") return surfaceOp;
  if (typeof surfaceOp === "object" && surfaceOp !== null) {
    const op = (surfaceOp as Record<string, unknown>)["op"];
    if (op === "replace") {
      throw new Error(
        `cannot resume session ${sessionId}: compaction replace ops are not supported at seq ${rowSeq}`,
      );
    }
    return surfaceOp;
  }
  throw new Error(
    `cannot resume session ${sessionId}: corrupt surfaceOp at seq ${rowSeq}`,
  );
}
