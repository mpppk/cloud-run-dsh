// Server-Sent Events streaming (仕様書 section 24).
//
// GET /v1/sessions/:id/events replays persisted events from the client-supplied
// `seq` cursor (events with seq >= cursor, matching T4 readEvents semantics)
// and then streams newly appended events. When idle, a `: ping` comment is
// sent every `sseHeartbeatMs`.
//
// SSE heartbeats, the SSE connection and status polling are NOT meaningful
// activity (仕様書 section 11) — nothing here calls recordActivity.
//
// All timing (heartbeat cadence, last-emit tracking) comes from the injected
// two-method clock (`deps.clock`, see ControlPlaneClock in deps.ts) — never
// from a bare `Date.now()` — so cadence is deterministically testable with a
// fake clock.

import type { ControlPlaneDeps } from "./deps.js";
import { loadSessionForMember } from "./handlers.js";
import { requireSegment } from "./validate.js";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_HEARTBEAT_MS = 15_000;

interface SseEvent {
  readonly seq: number;
  readonly eventType: string;
  readonly eventTime: number;
  readonly data: unknown;
}

function formatSseEvent(event: SseEvent): string {
  const data = JSON.stringify(event.data);
  return `id: ${event.seq}\nevent: ${event.eventType}\ndata: ${data}\n\n`;
}

export async function handleSessionEvents(
  request: Request,
  params: Record<string, string>,
  url: URL,
  deps: ControlPlaneDeps,
  userId: string,
): Promise<Response> {
  const sessionId = requireSegment(params.id, "id");
  // Membership is required for the session stream (observer operations,
  // 仕様書 section 20) — controller status is not needed to observe.
  await loadSessionForMember(deps, sessionId, userId);

  const rawSeq = url.searchParams.get("seq");
  let cursor = 0;
  if (rawSeq !== null) {
    const parsed = Number(rawSeq);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return new Response(
        JSON.stringify({ error: { code: "bad_request", message: "query parameter 'seq' must be a non-negative integer" } }),
        { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    cursor = parsed;
  }

  const pollIntervalMs = deps.ssePollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatMs = deps.sseHeartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const clock = deps.clock;

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const encoder = new TextEncoder();
      let closed = false;
      let lastEmitMs = clock.nowMs();

      const write = (chunk: string): void => {
        if (closed) return;
        try {
          streamController.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          streamController.close();
        } catch {
          // already closed
        }
      };

      request.signal.addEventListener("abort", close);

      // `seq` cursor: replay events with seq >= cursor, then stream (polling
      // uses lastSeq + 1). Matches T4 readEvents(sessionId, fromSeq) semantics.
      let lastSeq = cursor - 1;

      const poll = async (): Promise<void> => {
        const events = await deps.repo.readEvents(sessionId, lastSeq + 1);
        for (const event of events) {
          write(formatSseEvent(event));
          lastSeq = event.seq;
          lastEmitMs = clock.nowMs();
        }
      };

      try {
        // Replay from the cursor (実装手順書 section 24: SSE replay + stream).
        await poll();
        write(": stream open\n\n");
        while (!closed) {
          await Bun.sleep(pollIntervalMs);
          if (closed) break;
          // Heartbeat cadence is derived from the injected clock (MINOR-2/3),
          // never from a bare Date.now(), so fake clocks control it in tests.
          if (clock.nowMs() - lastEmitMs >= heartbeatMs) {
            // Heartbeat comment: NOT meaningful activity (仕様書 section 11).
            write(": ping\n\n");
            lastEmitMs = clock.nowMs();
          }
          await poll();
        }
      } catch {
        // Persistence errors end the stream; the client reconnects with its cursor.
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
