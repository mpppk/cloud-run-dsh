// Shared SSE wire-format parser (issue #138).
//
// The event stream is read with fetch + ReadableStream (NOT the built-in
// browser SSE client, which cannot attach custom headers), so both the debug
// UI (`/ui/app.js`, issue #128) and the product UI (`/app/app.js`, issue
// #138) parse the same wire format through this module instead of keeping
// two copies. Tested from bun test via static.test.ts.
//
// Pure: no DOM, no fetch. `seq` bookkeeping (resume cursor, gap and
// duplicate detection) lives here; WHAT the screen shows for a gap is each
// page's own decision (the product UI keeps it internal, the debug UI shows
// a banner).

export function createSseParser() {
  return {
    buffer: "",
    pending: { id: null, event: null, dataLines: [] },
    // Highest seq dispatched so far. Seed with (resumeFrom - 1) before a
    // resumed connection so the first replayed event is not flagged as a gap.
    lastSeq: -1,
  };
}

function freshPending() {
  return { id: null, event: null, dataLines: [] };
}

function dispatchPending(parser, out) {
  const p = parser.pending;
  parser.pending = freshPending();
  // A blank line with nothing accumulated (e.g. right after connect) is
  // not an event.
  if (p.id === null && p.event === null && p.dataLines.length === 0) return;
  let seq = null;
  if (p.id !== null && p.id !== "") {
    const n = Number(p.id);
    if (Number.isInteger(n) && n >= 0) seq = n;
  }
  const rawData = p.dataLines.join("\n");
  let data = rawData;
  if (rawData !== "") {
    try {
      data = JSON.parse(rawData);
    } catch {
      // keep the raw string
    }
  }
  if (seq !== null) {
    if (seq <= parser.lastSeq) {
      out.duplicates += 1;
      return;
    }
    if (parser.lastSeq !== -1 && seq !== parser.lastSeq + 1) {
      out.gaps.push({ expected: parser.lastSeq + 1, got: seq });
    }
    parser.lastSeq = seq;
  }
  out.events.push({ seq, eventType: p.event, data, rawData });
}

/**
 * Feeds one text chunk into the parser. Returns newly completed events plus
 * gap/duplicate bookkeeping for this chunk. Events split across chunks are
 * reassembled via parser state; `: comment` lines are ignored.
 */
export function parseSseChunks(parser, chunk) {
  const out = { events: [], gaps: [], duplicates: 0 };
  parser.buffer += chunk;
  const parts = parser.buffer.split("\n");
  // The last fragment has no line terminator yet — hold it for next time.
  parser.buffer = parts.pop();
  for (let rawLine of parts) {
    if (rawLine.endsWith("\r")) rawLine = rawLine.slice(0, -1);
    if (rawLine === "") {
      dispatchPending(parser, out);
      continue;
    }
    if (rawLine.startsWith(":")) continue; // comment / heartbeat (: ping)
    const colon = rawLine.indexOf(":");
    let field;
    let value;
    if (colon === -1) {
      field = rawLine;
      value = "";
    } else {
      field = rawLine.slice(0, colon);
      value = rawLine.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    if (field === "id") parser.pending.id = value;
    else if (field === "event") parser.pending.event = value;
    else if (field === "data") parser.pending.dataLines.push(value);
    // Unknown fields are ignored per the SSE spec.
  }
  return out;
}
