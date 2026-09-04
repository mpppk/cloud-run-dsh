// Tests for the shared Bun.SQL connection helper (issue #42).
//
// - The Cloud SQL socket DSN must resolve to the `{ path, username,
//   password, database }` options object (Bun rejects socket DSNs as URL
//   strings with `Invalid URL`).
// - TCP DSNs must pass through byte-identical (local dev / compose safety).
// - EVERY failure message must be password-free — even when the input
//   carries a password (this is the Cloud Logging leak).

import { describe, expect, test } from "bun:test";
import {
  BunSqlConnectionError,
  DatabaseUrlParseError,
  describeConnectionTarget,
  isSocketTarget,
  resolveBunSqlTarget,
  toBunSqlConnectionError,
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
