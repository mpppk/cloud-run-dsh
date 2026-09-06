// Issue #141: summarizeRestoreError() must keep triage context while
// stripping everything secret-adjacent. Every test below pins a FIXED
// secret-bearing input and asserts the secret material is gone from the
// output — a regression here would persist secrets into workspaces.last_error.

import { describe, expect, test } from "bun:test";
import {
  RESTORE_ERROR_EMPTY_FALLBACK,
  RESTORE_ERROR_MAX_LENGTH,
  summarizeRestoreError,
} from "./restore-error.js";

describe("summarizeRestoreError (issue #141)", () => {
  test("keeps the failure context for triage", () => {
    // Plain Errors carry no prefix (the name adds nothing); typed errors
    // keep theirs so the class aids triage.
    expect(summarizeRestoreError(new Error("git clone failed: connection refused"))).toBe(
      "git clone failed: connection refused",
    );
    expect(
      summarizeRestoreError(
        Object.assign(new Error("bad transition"), { name: "IllegalTransitionError" }),
      ),
    ).toBe("IllegalTransitionError: bad transition");
  });

  test("single-lines multi-line messages", () => {
    const out = summarizeRestoreError(new Error("clone failed\nat foo (bar.ts:1)\nmore"));
    expect(out).not.toContain("\n");
    expect(out).toContain("clone failed");
  });

  test("redacts Bearer tokens", () => {
    const out = summarizeRestoreError(
      new Error("forward failed: Bearer ya29.cPaV1234567890abcdef pumped"),
    );
    expect(out).not.toContain("ya29.cPaV1234567890abcdef");
    expect(out).toContain("Bearer [redacted]");
  });

  test("redacts Postgres connection strings", () => {
    const dsn = "postgresql://dsh_app:s3cr3t-pw-9xQ2@/dsh?host=/cloudsql/p:r:i";
    const out = summarizeRestoreError(new Error(`dial failed for ${dsn} (timeout)`));
    expect(out).not.toContain("s3cr3t-pw-9xQ2");
    expect(out).not.toContain("host=/cloudsql");
    expect(out).toContain("[redacted-connection-string]");
  });

  test("redacts PEM private keys", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA7b8FAKEKEYMATERIAL9xQ2",
      "bW9yZWZha2VrZXltYXRlcmlhbDEyMw==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = summarizeRestoreError(new Error(`bad key: ${pem}`));
    expect(out).not.toContain("FAKEKEYMATERIAL");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(out).toContain("[redacted-pem]");
  });

  test("redacts OpenRouter-style API keys", () => {
    const out = summarizeRestoreError(
      new Error("llm call failed with key sk-or-v1-abcdef1234567890abcdef1234567890abcdef12"),
    );
    expect(out).not.toContain("sk-or-v1-abcdef1234567890abcdef1234567890abcdef12");
    expect(out).toContain("[redacted-api-key]");
  });

  test("redacts KEY=VALUE assignments but keeps the key name", () => {
    const out = summarizeRestoreError(
      new Error("boot failed: OPENROUTER_API_KEY=hunter2-secret-value dir=/tmp"),
    );
    expect(out).not.toContain("hunter2-secret-value");
    expect(out).toContain("OPENROUTER_API_KEY=[redacted]");
    expect(out).toContain("dir=/tmp");
  });

  test("strips internal URLs", () => {
    const out = summarizeRestoreError(
      new Error(
        "instance dsh-ws-1 is READY but its agent-host never became healthy (30 polls of https://dsh-ws-1-abc123-uc.a.run.app/readyz). Last failure: 503",
      ),
    );
    expect(out).not.toContain("https://dsh-ws-1-abc123-uc.a.run.app/readyz");
    expect(out).toContain("[url]");
    // The triage context (instance name, status code) survives.
    expect(out).toContain("dsh-ws-1");
    expect(out).toContain("503");
  });

  test("truncates long reasons with a marker", () => {
    const out = summarizeRestoreError(new Error("x".repeat(RESTORE_ERROR_MAX_LENGTH + 100)));
    expect(out.length).toBeLessThanOrEqual(RESTORE_ERROR_MAX_LENGTH + "…(truncated)".length);
    expect(out.endsWith("…(truncated)")).toBe(true);
  });

  test("empty messages fall back instead of storing an empty reason", () => {
    expect(summarizeRestoreError(new Error(""))).toBe(RESTORE_ERROR_EMPTY_FALLBACK);
    expect(summarizeRestoreError("")).toBe(RESTORE_ERROR_EMPTY_FALLBACK);
  });

  test("handles non-Error throwables", () => {
    expect(summarizeRestoreError("plain string failure")).toBe("plain string failure");
    expect(summarizeRestoreError(undefined)).toBe(RESTORE_ERROR_EMPTY_FALLBACK);
  });
});
