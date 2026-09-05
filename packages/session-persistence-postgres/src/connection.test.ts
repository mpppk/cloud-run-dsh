// Tests for the shared Bun.SQL connection helper (issue #42).
//
// - The Cloud SQL socket DSN must resolve to the `{ path, username,
//   password, database }` options object (Bun rejects socket DSNs as URL
//   strings with `Invalid URL`).
// - TCP DSNs must pass through byte-identical (local dev / compose safety).
// - EVERY failure message must be password-free — even when the input
//   carries a password (this is the Cloud Logging leak).

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import {
  BUN_SQL_ENV_URL_KEYS,
  BunSqlConnectionError,
  DEFAULT_DB_POOL_IDLE_TIMEOUT,
  DEFAULT_DB_POOL_MAX,
  createBunSqlClient,
  DatabaseUrlParseError,
  describeConnectionTarget,
  isSocketTarget,
  resolveBunSqlPoolOptions,
  resolveBunSqlTarget,
  toBunSqlConnectionError,
  withIsolatedBunSqlEnv,
} from "./connection.js";

// A stand-in secret: every redaction assertion below checks THIS value never
// appears in a message. Deliberately nasty (mixed classes, high entropy) so
// a regex that only catches simple passwords cannot pass by accident.
const SECRET = "s3cR3t-Pw/xX9qZ+aB=CdEfGh";

function expectPasswordFree(text: string): void {
  expect(text.includes(SECRET)).toBe(false);
  expect(text.includes(encodeURIComponent(SECRET))).toBe(false);
}

describe("resolveBunSqlTarget — Cloud SQL socket form", () => {
  test("runbook form resolves to the socket options object", () => {
    const target = resolveBunSqlTarget(
      `postgresql://dsh_app:${SECRET}@/dsh?host=/cloudsql/proj:region:inst`,
    );
    expect(isSocketTarget(target)).toBe(true);
    expect(target).toEqual({
      path: "/cloudsql/proj:region:inst",
      username: "dsh_app",
      password: SECRET,
      database: "dsh",
    });
  });

  test("postgres:// scheme with localhost + socket= parameter", () => {
    const target = resolveBunSqlTarget(
      `postgres://u:${SECRET}@localhost/sockdb?socket=/cloudsql/conn`,
    );
    expect(target).toEqual({
      path: "/cloudsql/conn",
      username: "u",
      password: SECRET,
      database: "sockdb",
    });
  });

  test("credentials via user/password query parameters (no userinfo)", () => {
    const target = resolveBunSqlTarget(
      `postgresql:///dsh?host=/cloudsql/conn&user=u&password=${SECRET}`,
    );
    expect(target).toEqual({
      path: "/cloudsql/conn",
      username: "u",
      password: SECRET,
      database: "dsh",
    });
  });

  test("percent-encoded userinfo decodes (userinfo metacharacters)", () => {
    const target = resolveBunSqlTarget(
      "postgresql://us%40er:p%40ss%3Aw0rd@/%64b?host=/cloudsql/conn",
    );
    expect(target).toEqual({
      path: "/cloudsql/conn",
      username: "us@er",
      password: "p@ss:w0rd",
      database: "db",
    });
  });

  test("raw slash inside the password survives (base64 secrets contain /)", () => {
    const target = resolveBunSqlTarget(
      "postgresql://dsh_app:ab/cd+ef=@/dsh?host=/cloudsql/conn",
    );
    expect(target).toEqual({
      path: "/cloudsql/conn",
      username: "dsh_app",
      password: "ab/cd+ef=",
      database: "dsh",
    });
  });

  test("percent-encoded absolute host parameter is a socket", () => {
    const target = resolveBunSqlTarget(
      `postgresql://dsh_app:${SECRET}@/dsh?host=%2Fcloudsql%2Fproj%3Aregion%3Ainst`,
    );
    expect(isSocketTarget(target)).toBe(true);
    if (isSocketTarget(target)) {
      expect(target.path).toBe("/cloudsql/proj:region:inst");
      expect(target.password).toBe(SECRET);
    }
  });

  test("socket= form with a slash in the password and a real host", () => {
    const target = resolveBunSqlTarget(
      "postgres://u:ab/cd@localhost/sockdb?socket=/cloudsql/conn",
    );
    expect(target).toEqual({
      path: "/cloudsql/conn",
      username: "u",
      password: "ab/cd",
      database: "sockdb",
    });
  });

  test("slash-password with database via dbname parameter", () => {
    const target = resolveBunSqlTarget(
      "postgresql://u:ab/cd@?host=/cloudsql/conn&dbname=mydb",
    );
    expect(target).toEqual({
      path: "/cloudsql/conn",
      username: "u",
      password: "ab/cd",
      database: "mydb",
    });
  });

  test("ambiguous @-in-path input fails loudly instead of misconnecting", () => {
    try {
      resolveBunSqlTarget("postgresql://u:p/d@x?host=/cloudsql/conn");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DatabaseUrlParseError);
    }
  });
});

describe("resolveBunSqlTarget — TCP passthrough", () => {
  test("plain TCP URL passes through byte-identical", () => {
    const url = `postgres://dsh:${SECRET}@localhost:5432/dsh`;
    expect(resolveBunSqlTarget(url)).toBe(url);
  });

  test("TCP URL with query parameters passes through untouched", () => {
    const url = `postgresql://u:${SECRET}@db.internal:5432/app?sslmode=require&connect_timeout=10`;
    expect(resolveBunSqlTarget(url)).toBe(url);
  });

  test("non-absolute host parameter is NOT a socket (historical passthrough)", () => {
    const url = `postgresql://u:${SECRET}@localhost/dsh?host=db.internal`;
    expect(resolveBunSqlTarget(url)).toBe(url);
  });
});

describe("resolveBunSqlTarget — password-free failures", () => {
  test("empty value", () => {
    try {
      resolveBunSqlTarget("   ");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DatabaseUrlParseError);
      expectPasswordFree((e as Error).message);
    }
  });

  test("unsupported scheme echoes only the scheme, never the password", () => {
    const input = `mysql://u:${SECRET}@host/db`;
    try {
      resolveBunSqlTarget(input);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DatabaseUrlParseError);
      const message = (e as Error).message;
      expect(message).toContain("mysql");
      expectPasswordFree(message);
    }
  });

  test("socket form without a database", () => {
    const input = `postgresql://u:${SECRET}@?host=/cloudsql/conn`;
    try {
      resolveBunSqlTarget(input);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DatabaseUrlParseError);
      expectPasswordFree((e as Error).message);
    }
  });

  test("socket form without a username", () => {
    const input = `postgresql://:${SECRET}@/dsh?host=/cloudsql/conn`;
    try {
      resolveBunSqlTarget(input);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DatabaseUrlParseError);
      expectPasswordFree((e as Error).message);
    }
  });

  test("malformed percent-encoding", () => {
    const input = `postgresql://u:${SECRET}%ZZ@/dsh?host=/cloudsql/conn`;
    try {
      resolveBunSqlTarget(input);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DatabaseUrlParseError);
      expectPasswordFree((e as Error).message);
    }
  });
});

describe("describeConnectionTarget + toBunSqlConnectionError", () => {
  test("socket target description redacts the password but keeps the path", () => {
    const text = describeConnectionTarget({
      path: "/cloudsql/proj:region:inst",
      username: "dsh_app",
      password: SECRET,
      database: "dsh",
    });
    expectPasswordFree(text);
    expect(text).toContain("/cloudsql/proj:region:inst");
  });

  test("TCP target description redacts an @-containing password", () => {
    const tricky = "p@ss:w?rd&x=1";
    const text = describeConnectionTarget(
      `postgresql://dsh_app:${encodeURIComponent(tricky)}@db.internal:5432/dsh`,
    );
    expect(text.includes(tricky)).toBe(false);
    expect(text.includes(encodeURIComponent(tricky))).toBe(false);
    expect(text).toContain("db.internal");
  });

  test("Bun-style parse error (input = full DSN) becomes password-free", () => {
    const dsn = `postgresql://dsh_app:${SECRET}@/dsh?host=/cloudsql/proj:region:inst`;
    // Faithful simulation of what `new SQL(badString)` throws: the message
    // is clean but `input` carries the password (see issue #42).
    const bunError = Object.assign(new TypeError("Invalid URL"), {
      code: "ERR_INVALID_URL",
      input: dsn,
    });
    const target = resolveBunSqlTarget(dsn);
    const wrapped = toBunSqlConnectionError(bunError, target);
    expect(wrapped).toBeInstanceOf(BunSqlConnectionError);
    expect(wrapped.code).toBe("ERR_INVALID_URL");
    // The wrapped error must be safe to log whole: message, name, code,
    // stack, and any own properties (notably: NO `cause` carrying `input`).
    const { stack, ...rest } = wrapped as unknown as Record<string, unknown>;
    expectPasswordFree(JSON.stringify({ ...rest, stack }));
    expect("cause" in wrapped).toBe(false);
    expect("input" in wrapped).toBe(false);
  });

  test("TCP constructor failure is password-free and keeps the code", () => {
    const url = "postgres://dsh:pl4in-pw-no-slash@localhost:5432/dsh";
    const target = resolveBunSqlTarget(url);
    const wrapped = toBunSqlConnectionError(
      Object.assign(new Error("boom"), { code: "ERR_X", input: url }),
      target,
    );
    expectPasswordFree(wrapped.message);
    expect(wrapped.message).toContain("ERR_X");
    expect(wrapped.message).toContain("localhost");
  });

  test("TCP description with an unparseable password shape stays generic (still safe)", () => {
    // A raw "/" in the password defeats even WHATWG URL parsing, so no
    // redacted host display can be built — the fallback must stay silent
    // rather than echo anything.
    const url = `postgres://dsh:${SECRET}@localhost:5432/dsh`;
    const text = describeConnectionTarget(url);
    expectPasswordFree(text);
  });
});

describe("Bun.SQL environment isolation (issue #45)", () => {
  // Production shape: Cloud Run injects the socket DSN itself as
  // DATABASE_URL. Bun parses env URLs even for options-object calls, and
  // this exact string is unparseable as a WHATWG URL (empty host), so
  // `new SQL({ path, ... })` throws ERR_INVALID_URL unless the env is
  // hidden. Every test below sets this (or an equivalent poison value) and
  // requires construction to succeed — without the test env, the bug is
  // invisible, which is why #45 escaped to production.
  const PROD_SOCKET_DSN = `postgresql://dsh_app:${SECRET}@/dsh?host=/cloudsql/proj:region:inst`;

  function snapshotEnv(): Map<string, string | undefined> {
    const m = new Map<string, string | undefined>();
    for (const key of BUN_SQL_ENV_URL_KEYS) m.set(key, process.env[key]);
    return m;
  }

  function restoreEnv(snap: Map<string, string | undefined>): void {
    for (const [key, value] of snap) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  function clearAllUrlKeys(): void {
    for (const key of BUN_SQL_ENV_URL_KEYS) delete process.env[key];
  }

  async function closeQuietly(client: unknown): Promise<void> {
    try {
      await (client as { close: () => Promise<unknown> }).close();
    } catch {
      // Construction is what under test; close failures are irrelevant.
    }
  }

  test("socket options construct with DATABASE_URL set to the production socket DSN", async () => {
    const snap = snapshotEnv();
    const socketDir = mkdtempSync(join(tmpdir(), "bunsql-sock-"));
    try {
      clearAllUrlKeys();
      process.env["DATABASE_URL"] = PROD_SOCKET_DSN;
      const target = resolveBunSqlTarget(PROD_SOCKET_DSN);
      if (!isSocketTarget(target)) expect.unreachable();
      const client = createBunSqlClient(
        { ...target, path: socketDir },
        SQL as unknown as new (
          target: string | Record<string, unknown>,
        ) => Record<string, unknown>,
      ) as unknown as { options: Record<string, unknown> };
      expect((client.options as Record<string, unknown>)["path"]).toBe(socketDir);
      expect((client.options as Record<string, unknown>)["database"]).toBe("dsh");
      expect((client.options as Record<string, unknown>)["username"]).toBe("dsh_app");
      await closeQuietly(client);
      // Restored even on success.
      expect(process.env["DATABASE_URL"]).toBe(PROD_SOCKET_DSN);
    } finally {
      restoreEnv(snap);
    }
  });

  test("every known URL key is isolated (one poisoned key at a time)", async () => {
    const snap = snapshotEnv();
    const socketDir = mkdtempSync(join(tmpdir(), "bunsql-sock-all-"));
    try {
      for (const key of BUN_SQL_ENV_URL_KEYS) {
        clearAllUrlKeys();
        // The socket DSN is unparseable as a URL (throws); a bare token
        // pollutes/hijacks silently (hostname/adapter). Either poison must
        // be invisible inside the isolated constructor.
        process.env[key] = PROD_SOCKET_DSN;
        const client = createBunSqlClient(
          { path: socketDir, username: "u", password: "p", database: "d" },
          SQL as unknown as new (
            target: string | Record<string, unknown>,
          ) => Record<string, unknown>,
        ) as unknown as { options: Record<string, unknown> };
        expect((client.options as Record<string, unknown>)["path"]).toBe(socketDir);
        await closeQuietly(client);
        expect(process.env[key]).toBe(PROD_SOCKET_DSN);
      }
    } finally {
      restoreEnv(snap);
    }
  });

  test("fake ctor observes a stripped environment (version-independent proof)", () => {
    const snap = snapshotEnv();
    try {
      clearAllUrlKeys();
      process.env["DATABASE_URL"] = PROD_SOCKET_DSN;
      process.env["POSTGRES_URL"] = "postgres://poison/poison";
      process.env["MYSQL_URL"] = "mysql://poison/poison";
      process.env["SQLITE_URL"] = "file:///poison.db";
      const seen: Record<string, string | undefined> = {};
      class RecordingSql {
        constructor(_target: unknown) {
          for (const key of BUN_SQL_ENV_URL_KEYS) seen[key] = process.env[key];
        }
      }
      createBunSqlClient({ path: "/x", username: "u", password: "p", database: "d" }, RecordingSql);
      for (const key of BUN_SQL_ENV_URL_KEYS) expect(seen[key]).toBeUndefined();
      // ...and the outer environment is untouched.
      expect(process.env["DATABASE_URL"]).toBe(PROD_SOCKET_DSN);
      expect(process.env["POSTGRES_URL"]).toBe("postgres://poison/poison");
    } finally {
      restoreEnv(snap);
    }
  });

  test("environment is restored even when construction throws", () => {
    const snap = snapshotEnv();
    try {
      clearAllUrlKeys();
      process.env["DATABASE_URL"] = "sentinel-before";
      delete process.env["SQLITE_URL"];
      class ThrowingSql {
        constructor(_target: unknown) {
          // Keys must already be hidden when the ctor body runs...
          expect(process.env["DATABASE_URL"]).toBeUndefined();
          // ...including keys the caller never set (fn-created keys must
          // not leak out either).
          process.env["SQLITE_URL"] = "created-inside";
          throw new Error("ctor boom");
        }
      }
      expect(() =>
        createBunSqlClient({ path: "/x", username: "u", password: "p", database: "d" }, ThrowingSql),
      ).toThrow("ctor boom");
      expect(process.env["DATABASE_URL"]).toBe("sentinel-before");
      expect(process.env["SQLITE_URL"]).toBeUndefined();
    } finally {
      restoreEnv(snap);
    }
  });

  test("withIsolatedBunSqlEnv restores after a throwing callback", () => {
    const snap = snapshotEnv();
    try {
      clearAllUrlKeys();
      process.env["DATABASE_URL"] = "keep-me";
      expect(() =>
        withIsolatedBunSqlEnv(() => {
          expect(process.env["DATABASE_URL"]).toBeUndefined();
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(process.env["DATABASE_URL"]).toBe("keep-me");
    } finally {
      restoreEnv(snap);
    }
  });

  test("TCP string still constructs with DATABASE_URL set (local / compose safety)", async () => {
    const snap = snapshotEnv();
    try {
      clearAllUrlKeys();
      process.env["DATABASE_URL"] = PROD_SOCKET_DSN;
      const tcp = "postgres://dsh:pw-no-slash@localhost:5432/dsh";
      const target = resolveBunSqlTarget(tcp);
      expect(target).toBe(tcp);
      const client = createBunSqlClient(
        target,
        SQL as unknown as new (
          target: string | Record<string, unknown>,
        ) => Record<string, unknown>,
      ) as unknown as { options: Record<string, unknown> };
      expect((client.options as Record<string, unknown>)["hostname"]).toBe("localhost");
      await closeQuietly(client);
      expect(process.env["DATABASE_URL"]).toBe(PROD_SOCKET_DSN);
    } finally {
      restoreEnv(snap);
    }
  });
});

// ---------------------------------------------------------------------------
// Pool budget (issue #109): explicit caps instead of Bun defaults
// (max 10 eager + idleTimeout 0 = never reap), which exhausted db-f1-micro.
// ---------------------------------------------------------------------------

describe("resolveBunSqlPoolOptions", () => {
  test("defaults encode the db-f1-micro budget (5 + 5 of 25)", () => {
    expect(DEFAULT_DB_POOL_MAX).toBe(5);
    expect(DEFAULT_DB_POOL_IDLE_TIMEOUT).toBe(30);
    expect(resolveBunSqlPoolOptions({})).toEqual({
      max: 5,
      idleTimeout: 30,
      connectionTimeout: 30,
    });
  });

  test("blank values fall back to defaults", () => {
    expect(
      resolveBunSqlPoolOptions({
        DB_POOL_MAX: "   ",
        DB_POOL_IDLE_TIMEOUT: "",
        DB_POOL_CONNECTION_TIMEOUT: undefined,
      }),
    ).toEqual({ max: 5, idleTimeout: 30, connectionTimeout: 30 });
  });

  test("explicit values are honoured (tier upsizing path)", () => {
    expect(
      resolveBunSqlPoolOptions({
        DB_POOL_MAX: "20",
        DB_POOL_IDLE_TIMEOUT: "60",
        DB_POOL_CONNECTION_TIMEOUT: "10",
      }),
    ).toEqual({ max: 20, idleTimeout: 60, connectionTimeout: 10 });
  });

  test("idleTimeout 0 explicitly disables reaping", () => {
    expect(resolveBunSqlPoolOptions({ DB_POOL_IDLE_TIMEOUT: "0" }).idleTimeout).toBe(0);
  });

  test("invalid values fail fast naming the variable", () => {
    expect(() => resolveBunSqlPoolOptions({ DB_POOL_MAX: "0" })).toThrow(/DB_POOL_MAX/);
    expect(() => resolveBunSqlPoolOptions({ DB_POOL_MAX: "nope" })).toThrow(/DB_POOL_MAX/);
    expect(() => resolveBunSqlPoolOptions({ DB_POOL_IDLE_TIMEOUT: "-1" })).toThrow(
      /DB_POOL_IDLE_TIMEOUT/,
    );
    expect(() => resolveBunSqlPoolOptions({ DB_POOL_CONNECTION_TIMEOUT: "nope" })).toThrow(
      /DB_POOL_CONNECTION_TIMEOUT/,
    );
  });
});

describe("createBunSqlClient — pool options plumbing", () => {
  test("socket target merges pool knobs into the options object", () => {
    const seen: unknown[] = [];
    class RecordingSql {
      constructor(target: unknown) {
        seen.push(target);
      }
    }
    createBunSqlClient(
      { path: "/x", username: "u", password: "p", database: "d" },
      RecordingSql,
      { max: 5, idleTimeout: 30, connectionTimeout: 30 },
    );
    expect(seen).toEqual([
      { path: "/x", username: "u", password: "p", database: "d", max: 5, idleTimeout: 30, connectionTimeout: 30 },
    ]);
  });

  test("TCP string target passes pool knobs as the second constructor arg", () => {
    const seen: unknown[][] = [];
    class RecordingSql {
      constructor(...args: unknown[]) {
        seen.push(args);
      }
    }
    createBunSqlClient("postgres://u:p@localhost:5432/d", RecordingSql, {
      max: 5,
      idleTimeout: 30,
    });
    expect(seen.length).toBe(1);
    expect(seen[0]![0]).toBe("postgres://u:p@localhost:5432/d");
    expect(seen[0]![1]).toEqual({ max: 5, idleTimeout: 30 });
  });

  test("absent pool options keep the historical single-arg call", () => {
    const seen: unknown[][] = [];
    class RecordingSql {
      constructor(...args: unknown[]) {
        seen.push(args);
      }
    }
    createBunSqlClient({ path: "/x", username: "u", password: "p", database: "d" }, RecordingSql);
    expect(seen[0]!.length).toBe(1);
    createBunSqlClient("postgres://u:p@localhost:5432/d", RecordingSql, {});
    expect(seen[1]!.length).toBe(1);
  });

  test("partial pool options pass only the set keys", () => {
    const seen: unknown[] = [];
    class RecordingSql {
      constructor(target: unknown) {
        seen.push(target);
      }
    }
    createBunSqlClient(
      { path: "/x", username: "u", password: "p", database: "d" },
      RecordingSql,
      { max: 3 },
    );
    expect(seen).toEqual([{ path: "/x", username: "u", password: "p", database: "d", max: 3 }]);
  });
});
