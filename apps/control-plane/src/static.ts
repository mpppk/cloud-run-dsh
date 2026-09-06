// Static delivery for the debug Web UI (issue #128).
//
// Serves exactly three files from `apps/control-plane/public/` over an
// explicit allowlist — NOT a catch-all fallback. A catch-all would answer
// unknown `/v1/...` paths (and typos like `/nope`) with HTML, breaking the
// existing 404/401 behavior that clients and tests rely on.
//
// The UI carries no data — it is an empty screen whose API calls go to the
// same origin. It is served BEFORE authentication (see server.ts) so a
// browser navigation, which cannot attach custom headers, can load it
// locally. In production IAP protects the HTML itself. The API (`/v1/*`)
// is unchanged and still requires IAP headers.
//
// Path traversal is impossible by construction: the file is chosen from a
// fixed map keyed by the exact pathname — the request string is never used
// to build a filesystem path.
//
// Nothing here touches runtime handles, so serving these files never calls
// recordActivity and never extends the idle timer (仕様書 section 11).

import { join } from "node:path";

interface StaticEntry {
  /** Fixed file name inside `public/`. Never derived from the request. */
  readonly file: "index.html" | "app.js" | "app.css";
  readonly contentType: string;
}

const STATIC_ALLOWLIST: Readonly<Record<string, StaticEntry>> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/ui": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/ui/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/ui/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/ui/app.css": { file: "app.css", contentType: "text/css; charset=utf-8" },
};

/**
 * Serves an allowlisted static UI file, or returns null when this request
 * is not for one. Null means "not mine" — the caller falls through to the
 * normal authenticated routing (which 401s/404s as before).
 *
 * Only GET and HEAD are served; every other method returns null so e.g.
 * `POST /` keeps its existing 404.
 */
export async function serveStaticFile(method: string, pathname: string): Promise<Response | null> {
  if (method !== "GET" && method !== "HEAD") return null;
  const entry = STATIC_ALLOWLIST[pathname];
  if (!entry) return null;
  const absolute = join(import.meta.dir, "..", "public", entry.file);
  const file = Bun.file(absolute);
  if (!(await file.exists())) return null;
  const headers = {
    "content-type": entry.contentType,
    "content-length": String(file.size),
  };
  // HEAD answers with headers only; Bun must not send a body.
  if (method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(file, { status: 200, headers });
}
