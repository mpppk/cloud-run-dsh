// Unit tests for the issue #155 E2E verifier's pure helpers.
// Network-touching verifyE2E runs against real deployments only (runbook);
// these pin the no-secret-leak contract and report shaping instead.

import { describe, expect, test } from "bun:test";
import {
  checkResult,
  formatReport,
  redact,
  sessionCookieHeader,
} from "./verify-issue155-e2e.js";

describe("verify-issue155-e2e helpers", () => {
  test("redact masks every secret occurrence, keeps the rest", () => {
    expect(redact("session abc123 then abc123 again", ["abc123"])).toBe(
      "session [REDACTED] then [REDACTED] again",
    );
    expect(redact("nothing secret here", ["abc123"])).toBe("nothing secret here");
    expect(redact("empty secret list is a no-op", [])).toBe("empty secret list is a no-op");
    expect(redact("blank secret is a no-op", [""])).toBe("blank secret is a no-op");
  });

  test("sessionCookieHeader pins the __Host- cookie name", () => {
    expect(sessionCookieHeader("tok")).toEqual({ cookie: "__Host-dsh_session=tok" });
  });

  test("formatReport counts and preserves order", () => {
    const out = formatReport([
      checkResult("a", true, "ok"),
      checkResult("b", false, "boom"),
    ]);
    expect(out).toBe("PASS  a — ok\nFAIL  b — boom\nsummary: 1/2 checks passed");
  });

  test("report lines never carry raw secret values when callers redact", () => {
    const session = "ghu_super-secret-session";
    const detail = redact(`GET /auth/session -> 200 id=github:1 (cookie ${session})`, [session]);
    expect(detail).not.toContain(session);
    expect(detail).toContain("[REDACTED]");
  });
});
