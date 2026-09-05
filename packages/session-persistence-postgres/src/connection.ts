// Shared Bun.SQL connection-target resolution (issue #42).
//
// BACKGROUND: Bun.SQL does NOT accept a Unix-socket DSN as a URL string.
// `new SQL("postgresql://user:pass@/dsh?host=/cloudsql/<conn>")` throws
// `TypeError: Invalid URL` (and `?host=` / `?socket=` query parameters are
// silently ignored even when the URL parses, so the client dials TCP and
// fails with `Failed to connect`). The ONLY working socket form is the
// options object: `new SQL({ path, username, password, database })`.
//
// WORSE, the parse error carries the full DSN — password included — in its
// `input` property, which Bun prints as `input: "<dsn>"` on any uncaught
// throw. That is how the DB password reached Cloud Logging: the observability
// redactor never sees runtime-internal error output. This module is the fix:
// every `BunSqlQueryExecutor.connect()` (control-plane AND agent-host)
// resolves the configured string through `resolveBunSqlTarget()` and wraps
// constructor failures in `toBunSqlConnectionError()`, so a password can
// never reach an exception message, a log line, or an error `cause` chain.
//
// CONTRACT:
// - Cloud SQL socket form: a `postgresql://` / `postgres://` URL whose
//   `host` (or `socket`) query parameter is an ABSOLUTE path
//   (`?host=/cloudsql/<conn>`). Userinfo (`user:pass@`) or, when absent,
//   the `user`/`password` query parameters supply credentials; the first
//   path segment (or `dbname`) supplies the database. Resolves to the
//   options object Bun actually dials as a Unix socket.
// - Anything else (TCP `postgresql://user:pass@host:port/db`, with or
//   without extra query parameters) is returned BYTE-IDENTICAL so local
//   development and docker compose keep working exactly as before. In
//   particular a non-absolute `host` parameter is NOT special-cased —
//   passing it through preserves historical behavior.
// - Callers MUST route `new SQL()` throws through
//   `toBunSqlConnectionError()` and MUST NOT attach the original error as
//   `cause` (it may carry the DSN in `input`).

/** Options object for a Unix-socket connection — the only socket form Bun.SQL dials. */
export interface BunSqlSocketOptions {
  /** Unix-socket directory, e.g. `/cloudsql/<project>:<region>:<instance>`. */
  readonly path: string;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

/**
 * What to hand to `new SQL()`: the original string for TCP (unchanged), or
 * the socket options object for the Cloud SQL socket form.
 */
export type BunSqlConnectionTarget = string | BunSqlSocketOptions;

export function isSocketTarget(target: BunSqlConnectionTarget): target is BunSqlSocketOptions {
  return typeof target !== "string";
}

// ---------------------------------------------------------------------------
// Bun.SQL pool budget (issue #109).
//
// MEASURED 2026-09-05: one control-plane container grew to 23 Cloud SQL
// backends and held them idle, exhausting db-f1-micro (`max_connections` is
// 25 — `psql` then fails with "remaining connection slots are reserved").
// No call site passed a pool cap, so every pool ran at Bun's default.
//
// Bun 1.4.0 pool facts (verified against oven-sh/bun tag `bun-v1.4.0`,
// `src/js/internal/sql/shared.ts` + `postgres.ts`, plus a live
// `new SQL(url, { max: 0 })` throw check with the vendored bun 1.4.0):
// - `max` defaults to 10, and the pool is EAGER: the first query opens all
//   `max` backends at once. Three pools existed (control-plane 1 +
//   agent-host 2 — its composition root connected twice), so the worst case
//   was 3 × 10 = 30 backends against a 25-slot database.
// - `idleTimeout` defaults to 0, meaning "never reap": idle backends are
//   held forever. That is the "does not shrink when idle" half of #109.
// - Over-cap queries WAIT in an unbounded in-memory queue — there is NO
//   queue-wait timeout in Bun 1.4.0. `connectionTimeout` (default 30s) only
//   budgets connect-failure RETRIES, and `idleTimeout` only reaps idle
//   connections. So a too-small `max` does not fail fast: requests pile up
//   behind the pool until the caller's own timeout (Cloud Run request
//   timeout) kills them. Size `max` for peak concurrent in-flight queries,
//   not for the average.
//
// BUDGET for db-f1-micro (25 slots, measured): control-plane 5 + agent-host
// 5 (one shared pool — the host's double connect is removed) = 10 steady
// state, leaving ~15 for operator `psql` (teardown's DROP OWNED needs a
// slot; #73/#109 each blocked teardown for lack of one), Cloud SQL
// internals, and headroom. A bigger tier raises `max_connections` — raise
// these caps through the environment at the same time (see docs/cost.md).
// ---------------------------------------------------------------------------

/** Bun.SQL pool knobs, in Bun-native names and units (timeouts are seconds). */
export interface BunSqlPoolOptions {
  /** Maximum backends in the pool (Bun default when absent: 10). */
  readonly max?: number;
  /** Seconds an idle backend is kept before it is closed (Bun default: 0 = never). */
  readonly idleTimeout?: number;
  /**
   * Seconds of connect-failure retry budget per slot (Bun default: 30).
   * NOT a queue-wait cap: over-cap queries still wait unboundedly (see above).
   */
  readonly connectionTimeout?: number;
}

/** Default pool cap per process (issue #109 budget: 5 + 5 = 10 of 25). */
export const DEFAULT_DB_POOL_MAX = 5;
/** Default idle reap in seconds (issue #109: the leak never released idle backends). */
export const DEFAULT_DB_POOL_IDLE_TIMEOUT = 30;

function readPoolInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`invalid ${name}: ${JSON.stringify(raw)} (want an integer >= ${min})`);
  }
  return parsed;
}

/**
 * Reads the pool budget from the environment (issue #109). Both apps share
 * these names so one tier change retunes every pool; the control plane also
 * injects the same values into the Instances it creates.
 * - `DB_POOL_MAX` (default 5): per-process backend cap.
 * - `DB_POOL_IDLE_TIMEOUT` (default 30): idle reap in seconds; 0 disables.
 * - `DB_POOL_CONNECTION_TIMEOUT` (default 30): connect-retry budget in
 *   seconds. This does NOT cap queue waits — see the module note above.
 */
export function resolveBunSqlPoolOptions(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Required<BunSqlPoolOptions> {
  return {
    max: readPoolInt(env["DB_POOL_MAX"], "DB_POOL_MAX", DEFAULT_DB_POOL_MAX, 1),
    idleTimeout: readPoolInt(
      env["DB_POOL_IDLE_TIMEOUT"],
      "DB_POOL_IDLE_TIMEOUT",
      DEFAULT_DB_POOL_IDLE_TIMEOUT,
      0,
    ),
    connectionTimeout: readPoolInt(
      env["DB_POOL_CONNECTION_TIMEOUT"],
      "DB_POOL_CONNECTION_TIMEOUT",
      30,
      0,
    ),
  };
}

/** Drops unset keys; undefined means "no pool knobs — historical single-arg call". */
function poolArgs(poolOptions?: BunSqlPoolOptions): BunSqlPoolOptions | undefined {
  if (poolOptions === undefined) return undefined;
  const out: { max?: number; idleTimeout?: number; connectionTimeout?: number } = {};
  if (poolOptions.max !== undefined) out.max = poolOptions.max;
  if (poolOptions.idleTimeout !== undefined) out.idleTimeout = poolOptions.idleTimeout;
  if (poolOptions.connectionTimeout !== undefined) out.connectionTimeout = poolOptions.connectionTimeout;
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Thrown when the configured value is not a usable connection string.
 * Messages NEVER contain the password (see the module header). Values that
 * are safe to show (socket path, database, username, scheme) may appear;
 * anything that could carry a secret never does.
 */
export class DatabaseUrlParseError extends Error {
  readonly name = "DatabaseUrlParseError";
}

/**
 * Thrown when `new SQL()` rejects the resolved target. The original error is
 * deliberately NOT chained as `cause`: Bun's parse error carries the full
 * DSN (password included) in its `input` property, and any structured log of
 * the chain would persist it. Only the error `code` (e.g.
 * `ERR_INVALID_URL`) is carried over — codes never contain secrets.
 */
export class BunSqlConnectionError extends Error {
  readonly name = "BunSqlConnectionError";
  /** The underlying error code when it was a safe short string (else undefined). */
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

const SOCKET_DSN_EXAMPLE =
  "postgresql://<user>:<password>@/<database>?host=/cloudsql/<project>:<region>:<instance>";

function safeDecode(component: string, what: string): string {
  try {
    return decodeURIComponent(component);
  } catch {
    throw new DatabaseUrlParseError(
      `invalid DATABASE_URL: ${what} is not valid percent-encoding`,
    );
  }
}

/**
 * Parses a `a=1&b=2` query string WITHOUT `URLSearchParams` (which translates
 * `+` to a space — wrong for DSN components; only `%2B` may mean `+`).
 * Returns first-occurrence-wins decoded pairs. Never throws on shape, only
 * on bad percent-encoding (via `safeDecode`).
 */
function parseQueryPairs(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    const key = safeDecode(rawKey, "query parameter name");
    if (out.has(key)) continue;
    out.set(key, safeDecode(rawValue, `query parameter ${JSON.stringify(key)}`));
  }
  return out;
}

/**
 * Resolves a configured database URL to what `new SQL()` must receive.
 * Pure (no I/O); throws `DatabaseUrlParseError` with password-free messages.
 */
export function resolveBunSqlTarget(databaseUrl: string): BunSqlConnectionTarget {
  const raw = databaseUrl.trim();
  if (raw === "") {
    throw new DatabaseUrlParseError(
      "invalid DATABASE_URL: must be a non-empty connection string " +
        `(${SOCKET_DSN_EXAMPLE} for Cloud SQL sockets)`,
    );
  }
  const schemeMatch = /^(postgres(?:ql)?:\/\/)/i.exec(raw);
  if (!schemeMatch) {
    // Only the scheme (the part before "://") is echoed: it cannot contain
    // the password, which always follows "://".
    const schemeEnd = raw.indexOf("://");
    const schemeHint =
      schemeEnd === -1
        ? "missing scheme"
        : `unsupported scheme ${JSON.stringify(raw.slice(0, schemeEnd))}`;
    throw new DatabaseUrlParseError(
      `invalid DATABASE_URL: ${schemeHint} (want postgresql:// or postgres://)`,
    );
  }
  const afterScheme = raw.slice(schemeMatch[0]!.length);

  // A literal "#" starts the fragment (a "#" inside the password must be
  // percent-encoded as %23 — same rule as every URL parser).
  const fragmentStripped = afterScheme.split("#", 1)[0]!;
  // Split off the query at the FIRST "?". (A literal "?" inside the password
  // must be percent-encoded as %3F — same rule as every URL parser.)
  const queryIndex = fragmentStripped.indexOf("?");
  const beforeQuery =
    queryIndex === -1 ? fragmentStripped : fragmentStripped.slice(0, queryIndex);
  const queryString =
    queryIndex === -1 ? "" : fragmentStripped.slice(queryIndex + 1);
  const params = parseQueryPairs(queryString);

  const socketPath = params.get("host") ?? params.get("socket") ?? "";
  if (!socketPath.startsWith("/")) {
    // TCP (or a non-socket query): pass through BYTE-IDENTICAL. `databaseUrl`
    // (not the trimmed copy) is returned so historical inputs behave exactly
    // as before this change.
    return databaseUrl;
  }

  // --- Cloud SQL socket form -------------------------------------------
  // The userinfo/host/path split must tolerate a "/" inside the password
  // (base64 secrets from `openssl rand -base64` contain "/" ~40% of the
  // time): in the socket form the host part is empty or a plain hostname,
  // so the userinfo ends at the LAST "@" that is immediately followed by
  // the path's leading "/" (e.g. `user:ab/cd@/dsh`). Only when no such
  // "@/" exists (a `user:pass@host/db` shape with a real host) is the
  // authority split at the first "/" instead.
  //
  // One genuinely ambiguous shape remains: `u:ab/cd@` with an empty path
  // (slash-password AND no database in the path). The standard reading says
  // userinfo `u:ab` + database `cd@…`; the slash-password reading says
  // password `ab/cd` + database from `dbname`. The standard reading wins
  // whenever it yields complete fields; the slash-password rejoin below is
  // only a fallback for when it does not (a "@" inside a database name is
  // vanishingly rarer than a "/" inside a generated password).
  const candidates: Array<{ userinfo: string; pathPart: string }> = [];
  const atSlashIndex = beforeQuery.lastIndexOf("@/");
  if (atSlashIndex !== -1) {
    candidates.push({
      userinfo: beforeQuery.slice(0, atSlashIndex),
      pathPart: beforeQuery.slice(atSlashIndex + 1),
    });
  } else {
    const slashIndex = beforeQuery.indexOf("/");
    const authority = slashIndex === -1 ? beforeQuery : beforeQuery.slice(0, slashIndex);
    const pathPart = slashIndex === -1 ? "" : beforeQuery.slice(slashIndex);
    const atIndex = authority.lastIndexOf("@");
    candidates.push({
      userinfo: atIndex === -1 ? "" : authority.slice(0, atIndex),
      pathPart,
    });
    // Slash-password rejoin: no "@" in the authority but one in the path
    // means the password itself holds the "/" (see above). Only accept the
    // rejoin when it looks like userinfo (contains ":") so an "@" inside a
    // path segment (e.g. `/db@x` with no userinfo at all) is not hijacked.
    // The text after the "@" is host + path (`user:pw@host/db`); only the
    // path part carries the database.
    const rejoinAt = pathPart.lastIndexOf("@");
    if (atIndex === -1 && rejoinAt !== -1) {
      const rejoined = authority + pathPart.slice(0, rejoinAt);
      if (rejoined.includes(":")) {
        const remainder = pathPart.slice(rejoinAt + 1);
        const hostEnd = remainder.indexOf("/");
        candidates.push({
          userinfo: rejoined,
          pathPart: hostEnd === -1 ? "" : remainder.slice(hostEnd),
        });
      }
    }
  }

  for (const candidate of candidates) {
    const fields = socketFields(candidate.userinfo, candidate.pathPart, params);
    if (fields !== null) {
      return { path: socketPath, ...fields };
    }
  }
  // All readings incomplete: report the first missing field. (Username is
  // checked first because without it nothing else matters.)
  const first = socketFields(candidates[0]!.userinfo, candidates[0]!.pathPart, params, true);
  if (first === null || first.username === "") {
    throw new DatabaseUrlParseError(
      "invalid DATABASE_URL: Cloud SQL socket form requires a username " +
        `(${SOCKET_DSN_EXAMPLE})`,
    );
  }
  throw new DatabaseUrlParseError(
    "invalid DATABASE_URL: Cloud SQL socket form requires a database name " +
      `(${SOCKET_DSN_EXAMPLE})`,
  );
}

/**
 * Extracts socket credentials from one (userinfo, path) reading. Returns
 * null when username or database is missing (lets the caller try the next
 * reading); `partial` returns the incomplete fields for error reporting.
 */
function socketFields(
  userinfo: string,
  pathPart: string,
  params: Map<string, string>,
  partial = false,
): { username: string; password: string; database: string } | null {
  let username = "";
  let password = "";
  if (userinfo !== "") {
    const colonIndex = userinfo.indexOf(":");
    if (colonIndex === -1) {
      username = safeDecode(userinfo, "username");
    } else {
      username = safeDecode(userinfo.slice(0, colonIndex), "username");
      password = safeDecode(userinfo.slice(colonIndex + 1), "password");
    }
  }
  if (username === "") {
    username = params.get("user") ?? params.get("username") ?? "";
  }
  if (password === "") {
    password = params.get("password") ?? "";
  }

  // Database: first path segment, else the dbname/database parameter.
  const pathSegments = pathPart.split("/").filter((s) => s !== "");
  let database = pathSegments.length > 0 ? safeDecode(pathSegments[0]!, "database name") : "";
  if (database === "") {
    database = params.get("dbname") ?? params.get("database") ?? "";
  }

  if (username === "" || database === "") {
    return partial ? { username, password, database } : null;
  }
  return { username, password, database };
}

/**
 * Password-free one-line description of a resolved target, for error
 * messages and operator logs. Usernames, hosts, socket paths, and database
 * names are not secrets; the password is always `[REDACTED]`.
 */
export function describeConnectionTarget(target: BunSqlConnectionTarget): string {
  if (isSocketTarget(target)) {
    return (
      `postgresql://${target.username}:[REDACTED]@/${target.database}` +
      `?host=${target.path}`
    );
  }
  // TCP string: rebuild a redacted display from parsed parts so a password
  // containing "@", "&", or "?" cannot defeat a regex-based redactor.
  try {
    const parsed = new URL(target);
    const user = parsed.username === "" ? "" : `${parsed.username}:[REDACTED]@`;
    return `${parsed.protocol}//${user}${parsed.host}${parsed.pathname}`;
  } catch {
    return "the configured database URL";
  }
}

function safeErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && code !== "" && code.length <= 64 ? code : undefined;
}

/**
 * Wraps a `new SQL(target)` throw in a password-free `BunSqlConnectionError`.
 * The original error is NOT chained (see `BunSqlConnectionError`).
 */
export function toBunSqlConnectionError(err: unknown, target: BunSqlConnectionTarget): BunSqlConnectionError {
  const code = safeErrorCode(err);
  const where = describeConnectionTarget(target);
  const hint = isSocketTarget(target)
    ? ` check that the Cloud SQL socket exists at ${target.path} (cloudSqlInstance volume mounted?)`
    : " check that the database host is reachable and the URL is valid";
  const codePart = code === undefined ? "" : ` (${code})`;
  return new BunSqlConnectionError(
    `failed to initialize the database client for ${where}${codePart}.${hint}`,
    code,
  );
}

// ---------------------------------------------------------------------------
// Bun.SQL environment isolation (issue #45).
//
// BACKGROUND: `new SQL(optionsObject)` still reads connection URLs from the
// process environment FIRST. In `parseConnectionDetailsFromOptionsOrEnvironment`
// (`src/js/internal/sql/shared.ts`) an options-object call resolves its URL
// via `getConnectionDetailsFromEnvironment(options.adapter)`; with no explicit
// `adapter` (our socket form never sets one) that means "every known URL key".
// An unparseable value — notably the Cloud SQL socket DSN from #42, which is
// exactly what Cloud Run injects as `DATABASE_URL` in production — throws
// `ERR_INVALID_URL` before the explicit `{ path, username, password,
// database }` options are even considered. Local tests never set
// `DATABASE_URL`, so the bug only surfaced in production.
//
// FIX: delete the URL-discovery keys for the duration of the synchronous
// `new SQL()` call and restore them in `finally`. Callers MUST construct via
// `createBunSqlClient()` below so the key list stays in one place.
//
// KEY LIST (verified against oven-sh/bun tags `bun-v1.4.0` AND `bun-v1.4.1`,
// `getConnectionDetailsFromEnvironment` — identical in both; the duplicate
// `PGURL` in Bun's own `POSTGRES_URL || PGURL || PG_URL || PGURL` chain is
// listed once here):
//   generic:  DATABASE_URL, DATABASEURL, TLS_DATABASE_URL
//   postgres: POSTGRES_URL, PGURL, PG_URL, TLS_POSTGRES_DATABASE_URL
//   mysql:    MYSQL_URL, MYSQLURL, TLS_MYSQL_DATABASE_URL
//   mariadb:  MARIADB_URL, MARIADBURL, TLS_MARIADB_DATABASE_URL
//   sqlite:   SQLITE_URL, SQLITEURL
// Per-field keys (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE, ...)
// are deliberately NOT cleared: explicit options already outrank them, they
// cannot throw `ERR_INVALID_URL`, and our socket form passes
// username/password/database explicitly (hostname falls back to localhost and
// is ignored by the native driver whenever `path` is set).
// Likewise `POSTGRES_CONNECTION_STRING` / `DATABASE_URL_UNPOOLED` (seen in
// the issue's "delete everything" experiment) are NOT read by Bun 1.4.0/1.4.1
// and are therefore NOT listed — clearing them would only hide the true set.
// ---------------------------------------------------------------------------

/**
 * Every environment key Bun.SQL 1.4.0/1.4.1 consults for URL discovery.
 * Keep in sync with `getConnectionDetailsFromEnvironment` if Bun is upgraded.
 */
export const BUN_SQL_ENV_URL_KEYS = [
  "DATABASE_URL",
  "DATABASEURL",
  "TLS_DATABASE_URL",
  "POSTGRES_URL",
  "PGURL",
  "PG_URL",
  "TLS_POSTGRES_DATABASE_URL",
  "MYSQL_URL",
  "MYSQLURL",
  "TLS_MYSQL_DATABASE_URL",
  "MARIADB_URL",
  "MARIADBURL",
  "TLS_MARIADB_DATABASE_URL",
  "SQLITE_URL",
  "SQLITEURL",
] as const;

/**
 * Runs `fn` with Bun.SQL's URL-discovery environment keys hidden.
 * The function MUST be synchronous (the `new SQL()` constructor is): an
 * async callback could outlive the `finally` restore and observe either the
 * stripped or the restored environment depending on timing.
 * Restoration is exact — keys present before are restored byte-identical,
 * keys absent before are absent after (even if `fn` created them), and a
 * throw inside `fn` still restores via `finally`.
 */
export function withIsolatedBunSqlEnv<T>(fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of BUN_SQL_ENV_URL_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Constructs a Bun.SQL-compatible client with the environment isolated.
 * This is the ONLY approved way to call `new SQL(target)`: it guarantees
 * the explicit `target` (socket options object or TCP string) cannot be
 * overridden, polluted, or rejected because of ambient `*_URL` variables.
 *
 * `poolOptions` (issue #109) caps the pool: a TCP string target is passed
 * as `new SQL(url, pool)` (two-arg form, verified on bun 1.4.0), while a
 * socket options object is spread into one (`{ path, ..., ...pool }`) —
 * both shapes flow through the same Bun defaults parsing. Omitted (or
 * all-unset) means the historical single-arg call with Bun defaults
 * (`max: 10`, `idleTimeout: 0` = never reap).
 */
export function createBunSqlClient<TClient>(
  target: BunSqlConnectionTarget,
  ctor: new (target: BunSqlConnectionTarget, options?: BunSqlPoolOptions) => TClient,
  poolOptions?: BunSqlPoolOptions,
): TClient {
  return withIsolatedBunSqlEnv(() => {
    const pool = poolArgs(poolOptions);
    if (pool === undefined) return new ctor(target);
    if (typeof target === "string") return new ctor(target, pool);
    return new ctor({ ...target, ...pool });
  });
}
