import { describe, test, expect } from "bun:test";
import {
  PLACEHOLDER_KIND,
  createPlaceholder,
  createLogger,
  describeError,
  ERROR_ID_RE,
  InMemoryLogger,
  newErrorId,
  redactValue,
  redactLogFields,
  METRIC_NAMES,
  InMemoryMetrics,
  NoOpMetrics,
} from "./index.js";
import type { LogFields, MetricName } from "./index.js";

describe("observability", () => {
  test("placeholder smoke", () => {
    expect(PLACEHOLDER_KIND).toBe("observability");
    const p = createPlaceholder();
    expect(p.kind).toBe("observability");
  });

  // -----------------------------------------------------------------------
  // Logger: field set from implementation guide section 31
  // -----------------------------------------------------------------------

  test("logger emits required field set as JSON", () => {
    const logger = new InMemoryLogger();
    logger.info("workspace.start", {
      workspaceId: "ws-123",
      sessionId: "sess-456",
      sandboxId: "dsh-ws-123",
      toolCallId: "tc-1",
      argv0: "npm",
      durationMs: 1234,
      exitCode: 0,
      userId: "user-1",
      controllerId: "ctrl-1",
      processId: "proc-1",
      instanceName: "inst-1",
    });
    expect(logger.parsed.length).toBe(1);
    const fields = logger.parsed[0] as LogFields;
    expect(fields.severity).toBe("INFO");
    expect(fields.event).toBe("workspace.start");
    expect(fields.workspaceId).toBe("ws-123");
    expect(fields.sessionId).toBe("sess-456");
    expect(fields.sandboxId).toBe("dsh-ws-123");
    expect(fields.toolCallId).toBe("tc-1");
    expect(fields.argv0).toBe("npm");
    expect(fields.durationMs).toBe(1234);
    expect(fields.exitCode).toBe(0);
    expect(fields.userId).toBe("user-1");
    expect(fields.controllerId).toBe("ctrl-1");
    expect(fields.processId).toBe("proc-1");
    expect(fields.instanceName).toBe("inst-1");
    // Each line is valid JSON with timestamp
    const raw = JSON.parse(logger.lines[0]!) as Record<string, unknown>;
    expect(raw["timestamp"]).toBeDefined();
  });

  test("logger severity helpers", () => {
    const logger = new InMemoryLogger();
    logger.warn("sandbox.exec.completed", { argv0: "git" });
    logger.error("workspace.restore.failed", { exitCode: 1 });
    expect(logger.parsed[0]!.severity).toBe("WARNING");
    expect(logger.parsed[1]!.severity).toBe("ERROR");
  });

  // -----------------------------------------------------------------------
  // Redactor (spec section 26 item 12)
  // -----------------------------------------------------------------------

  test("redacts GitHub tokens (ghs_, ghp_, github_pat_)", () => {
    const input = "token ghs_abc123DEF456ghi789JKL012mno345pq is secret";
    expect(redactValue(input)).not.toContain("ghs_abc123");
    expect(redactValue(input) as string).toContain("[REDACTED]");

    const pat = "my pat github_pat_1234567890ABCDEFGHIJ_1234567890 is here";
    expect(redactValue(pat) as string).toContain("[REDACTED]");
    expect(redactValue(pat) as string).not.toContain("github_pat");

    const ghp = "ghp_1234567890abcdef1234567890abcdef1234";
    expect(redactValue(ghp) as string).toContain("[REDACTED]");
  });

  test("redacts private keys", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC...\n-----END PRIVATE KEY-----";
    const out = redactValue(`key: ${pem} end`) as string;
    expect(out).not.toContain("BEGIN PRIVATE KEY");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts Bearer headers", () => {
    const bearer = "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.signature";
    const out = redactValue(bearer) as string;
    expect(out).not.toContain("eyJhbGciOi");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts connection strings (postgres, mysql)", () => {
    const pg = "postgres://user:pass@db.example.com:5432/mydb?sslmode=require";
    expect(redactValue(pg) as string).toContain("[REDACTED]");
    expect(redactValue(pg) as string).not.toContain("postgres://");

    const pg2 = "postgresql://user:secret@host/db";
    expect(redactValue(pg2) as string).toContain("[REDACTED]");

    const mysql = "mysql://root:password@localhost:3306/test";
    expect(redactValue(mysql) as string).toContain("[REDACTED]");
  });

  test("redacts values for secret-like keys regardless of pattern", () => {
    const obj = {
      token: "some-random-value-123",
      private_key: "whatever",
      DATABASE_URL: "postgres://foo",
      normalField: "hello world",
    };
    const out = redactValue(obj) as Record<string, unknown>;
    expect(out["token"]).toBe("[REDACTED]");
    expect(out["private_key"]).toBe("[REDACTED]");
    expect(out["DATABASE_URL"]).toBe("[REDACTED]");
    expect(out["normalField"]).toBe("hello world");
  });

  test("redactor applied to every log value via logger", () => {
    const logger = new InMemoryLogger();
    logger.info("test.event", {
      workspaceId: "ws-1",
      // simulate a field that accidentally contains a token
      sandboxId: "token ghs_abc123DEF456ghi789JKL0123456789token",
    } as unknown as LogFields);
    const parsed = logger.parsed[0] as Record<string, unknown>;
    expect(parsed["sandboxId"] as string).toContain("[REDACTED]");
    expect(parsed["sandboxId"] as string).not.toContain("ghs_abc123");
  });

  test("redactor handles realistic secret shapes in nested objects and arrays", () => {
    const nested = {
      env: ["postgres://user:pass@host/db", "normal"],
      headers: { Authorization: "Bearer ghs_abc123DEF456ghi789JKL0123456789" },
    };
    const out = redactValue(nested) as Record<string, unknown>;
    // env key is considered secret-like, so whole value redacted as string? Actually we redact key-based
    // For key "env", it's not secret-like by our heuristic, so we recurse into array
    // But array elements containing postgres should be redacted
    // Let's test more precisely:
    const arr = (out["env"] as unknown[]) ?? [];
    // Since "env" is not in secret key list, array elements are redacted individually
    // But postgres pattern inside string will be redacted
    // However our redactValue for object with key "env" will recurse, not bulk redact
    // So check array element redaction
    const obj2 = { myToken: "ghs_abcdef1234567890XYZ1234567890" };
    const out2 = redactValue(obj2) as Record<string, unknown>;
    expect(out2["myToken"]).toBe("[REDACTED]");
  });

  test("i29: 20+ char technical identifiers are NOT redacted", () => {
    // Repro for #29: RuntimeNotWiredError (20 chars) was redacted as [REDACTED]
    expect(redactValue("RuntimeNotWiredError")).toBe("RuntimeNotWiredError");
    expect(redactValue("Error: RuntimeNotWiredError: unavailable") as string).toContain(
      "RuntimeNotWiredError",
    );
    // Other known-safe shapes: long PascalCase identifiers, snake_case event names
    expect(redactValue("PascalCaseIdentifierExample")).toBe("PascalCaseIdentifierExample");
    expect(redactValue("my_event_name_with_long_description")).toBe(
      "my_event_name_with_long_description",
    );
    // 40-hex commit SHA: indistinguishable from random hex by shape alone, must survive
    const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
    expect(redactValue(`commit ${sha} deployed`) as string).toContain(sha);
    // Via the logger as well: structured identifier fields must stay readable
    const logger = new InMemoryLogger();
    logger.error("runtime.unavailable", {
      errorName: "RuntimeNotWiredError",
    } as unknown as LogFields);
    expect((logger.parsed[0] as Record<string, unknown>)["errorName"]).toBe(
      "RuntimeNotWiredError",
    );
  });

  test("i29: real secrets are still redacted (position + specific shapes)", () => {
    // Shape-specific: PEM / Bearer / connection strings in free text
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC...\n-----END PRIVATE KEY-----";
    expect(redactValue(`key ${pem} end`) as string).toContain("[REDACTED]");
    expect(
      redactValue("Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.sig") as string,
    ).toContain("[REDACTED]");
    expect(redactValue("postgres://user:pass@host/db") as string).toContain("[REDACTED]");
    // Well-known vendor prefix anywhere (aligns with dsh-subprocess-cloud-run layer)
    expect(redactValue("key is sk-1234567890abcdefghij1234 ok") as string).toContain("[REDACTED]");
    // Position-based: secret-like object keys redact the whole value, even short ones
    const out = redactValue({
      password: "hunter2",
      apiKey: "sk-test-short",
      normalField: "hello world",
    }) as Record<string, unknown>;
    expect(out["password"]).toBe("[REDACTED]");
    expect(out["apiKey"]).toBe("[REDACTED]");
    expect(out["normalField"]).toBe("hello world");
    // Position-based in free text: KEY=VALUE assignments (short values shape-checks miss)
    expect(redactValue("API_KEY=short") as string).not.toContain("short");
    expect(redactValue("password: hunter2") as string).not.toContain("hunter2");
  });
  test("r36/BLOCKER-1: marker-less high-entropy secrets ARE redacted (exclusion-listed net)", () => {
    // Old impl caught these via entropy; the #29 rewrite dropped them.
    // The net is back with exclusions: only strict PascalCase / hex-only
    // 40-or-64 / lowercase snake_case survive (see next test).
    const bare = "xK9mPq3vT8rY2nZ5bJ7hL0cF4dW6aG1sE2qX9z";
    const out = redactValue(`token is ${bare} here`) as string;
    expect(out).not.toContain(bare);
    expect(out).toContain("[REDACTED]");

    // Bearer-less Google token in an error message
    const google = "Error: request failed with token ya29.a0AfH6SMBx9mPq3vT8rY2nZ5bJ7hL0cF4dW6aG1sE2qX9zAbCdEfGh";
    const outGoogle = redactValue(google) as string;
    expect(outGoogle).not.toContain("a0AfH6SMB");
    expect(outGoogle).toContain("[REDACTED]");

    // Secrets under unknown keys are still caught by shape, not by key name
    const outDbPw = redactValue({ db_pw: bare }) as Record<string, unknown>;
    expect(outDbPw["db_pw"]).toBe("[REDACTED]");
    const outPwd = redactValue({ pwd: bare }) as Record<string, unknown>;
    expect(outPwd["pwd"]).toBe("[REDACTED]");

    // JWT in free text (no Bearer marker)
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const outJwt = redactValue(`auth failed: ${jwt} rejected`) as string;
    expect(outJwt).not.toContain("eyJhbGciOi");
    expect(outJwt).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    expect(outJwt).toContain("[REDACTED]");

    // AWS access key ID in free text
    const outAkia = redactValue("saw key AKIAIOSFODNN7EXAMPLE in log") as string;
    expect(outAkia).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(outAkia).toContain("[REDACTED]");

    // Bounding: low-entropy 20-char repeated string must NOT be redacted
    const lowEntropy = "aaaaaaaaaaaaaaaaaaaa";
    expect(redactValue(lowEntropy) as string).toBe(lowEntropy);
    expect(redactValue("hello world") as string).toBe("hello world");
    expect(redactValue("ws-123") as string).toBe("ws-123");
  });

  test("r36/BLOCKER-1: identifier shapes survive the entropy net", () => {
    // Strict PascalCase identifiers
    expect(redactValue("RuntimeNotWiredError")).toBe("RuntimeNotWiredError");
    expect(redactValue("PascalCaseIdentifierExample")).toBe("PascalCaseIdentifierExample");
    // Commit SHAs: hex-only 40 / 64 chars
    const sha40 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
    expect(redactValue(`commit ${sha40} deployed`) as string).toContain(sha40);
    const sha64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(redactValue(`commit ${sha64} done`) as string).toContain(sha64);
    // Lowercase snake_case event names
    expect(redactValue("my_event_name_with_long_description")).toBe(
      "my_event_name_with_long_description",
    );
  });

  test("r36/BLOCKER-hex64: context-limited SHA rescue (real hex secrets redacted, commit SHAs survive)", () => {
    // Python secrets.token_hex(32) real output: 64-char hex in free text
    // MUST be redacted (was passing through via the unconditional hex-40/64 exclusion).
    const hex64 = "625636386d8d6cff17fd2c37ba055ae206d9b53f589f4f1311f19abac2bee5cf";
    const outFree = redactValue(`token is ${hex64} here`) as string;
    expect(outFree).not.toContain(hex64);
    expect(outFree).toContain("[REDACTED]");

    // Same secret under an unknown (non-secret-like) key: shape must catch it.
    const outObj = redactValue({ foo: hex64 }) as Record<string, unknown>;
    expect(outObj["foo"]).toBe("[REDACTED]");

    // token_hex(20) real output: 40-char hex (old-style GitHub token shape).
    const hex40 = "35bad8143c8813c45ca9841750209525f5177ab2";
    const out40 = redactValue(`token is ${hex40} here`) as string;
    expect(out40).not.toContain(hex40);
    expect(out40).toContain("[REDACTED]");

    // Boundary pinning: off-length hex was already redacted and must stay so
    // (only exact 40/64 ever reached the SHA rescue path).
    const hex32 = "625636386d8d6cff17fd2c37ba055ae";
    expect(redactValue(`token is ${hex32} here`) as string).toContain("[REDACTED]");

    // Commit context survives: the existing "commit <sha>" contract.
    const sha40 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
    expect(redactValue(`commit ${sha40} deployed`) as string).toContain(sha40);
    const sha64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(redactValue(`commit ${sha64} done`) as string).toContain(sha64);
  });

  test("r36/BLOCKER-2: OpenRouter sk-or-v1 keys are redacted", () => {
    const orKey = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef";
    const out = redactValue(`key ${orKey} leaked`) as string;
    expect(out).not.toContain("sk-or-v1");
    expect(out).not.toContain("0123456789abcdef");
    expect(out).toContain("[REDACTED]");
    // Marker-prefixed shapes are redacted regardless of entropy: a low-entropy
    // tail isolates the sk- pattern from the entropy net (which would miss it).
    // This case fails if the pattern regresses to /sk-[A-Za-z0-9]{20,}/.
    const lowEntropyOrKey = `sk-or-v1-${"a".repeat(48)}`;
    const outLow = redactValue(`key ${lowEntropyOrKey} leaked`) as string;
    expect(outLow).not.toContain("sk-or-v1");
    expect(outLow).toContain("[REDACTED]");
    // DeepSeek-style sk- keys keep working
    expect(redactValue("key is sk-1234567890abcdefghij1234 ok") as string).toContain("[REDACTED]");
  });

  test("r36/MINOR-1: compact JSON stays parseable after assignment redaction", () => {
    const out = redactValue('{"password":"hunter2","x":1}') as string;
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["password"]).toBe("[REDACTED]");
    expect(parsed["x"]).toBe(1);
  });

  test("r36/MINOR-2: pwd / pw count as secret-like keys", () => {
    const out = redactValue({ pwd: "hunter2", pw: "hunter2", db_pw: "x" }) as Record<
      string,
      unknown
    >;
    expect(out["pwd"]).toBe("[REDACTED]");
    expect(out["pw"]).toBe("[REDACTED]");
    expect(out["db_pw"]).toBe("[REDACTED]");
  });

  test("i51: RFC 4122 UUIDs survive redaction (spec section 25 correlation keys)", () => {
    // Repro for #51: UUIDs are identifiers, not secrets — but 36 chars /
    // 2 classes / entropy > 3 tripped the entropy net and wiped every §25
    // correlation key from structured logs.
    const uuid = "d7383605-d479-47f9-bfef-8d62f82b729c"; // v4 (version 4, variant b)
    expect(redactValue(uuid)).toBe(uuid);
    expect(redactValue(`opened workspace ${uuid} ok`) as string).toContain(uuid);
    // Case-insensitive: some producers emit uppercase UUIDs.
    expect(redactValue(uuid.toUpperCase())).toBe(uuid.toUpperCase());
    // A freshly generated ID (what the codebase actually logs) always passes:
    // crypto.randomUUID() is v4, which the strict shape requires.
    const fresh = crypto.randomUUID();
    expect(redactValue(fresh)).toBe(fresh);
    expect(redactValue(`dsh-${fresh}`)).toBe(`dsh-${fresh}`);
    // Composite: instance_name is `dsh-${workspaceId}` — one 40-char token to
    // the entropy net because `-` is in its character class.
    const inst = `dsh-${uuid}`;
    expect(redactValue(inst)).toBe(inst);
    expect(redactValue(`instance ${inst} started`) as string).toContain(inst);
    // The exact §25 field set from the issue report, via redactLogFields.
    const fields = redactLogFields({
      severity: "INFO",
      event: "workspace_open",
      workspace_id: uuid,
      session_id: uuid,
      user_id: "verify",
      controller_id: uuid,
      instance_name: inst,
    } as unknown as LogFields) as unknown as Record<string, unknown>;
    expect(fields["workspace_id"]).toBe(uuid);
    expect(fields["session_id"]).toBe(uuid);
    expect(fields["user_id"]).toBe("verify");
    expect(fields["controller_id"]).toBe(uuid);
    expect(fields["instance_name"]).toBe(inst);
    // camelCase LogFields keys (the typed interface) keep UUIDs too.
    const camel = redactLogFields({
      severity: "INFO",
      event: "workspace_open",
      workspaceId: uuid,
      sessionId: uuid,
      sandboxId: inst,
      toolCallId: uuid,
      controllerId: uuid,
      processId: uuid,
      instanceName: inst,
    });
    expect(camel.workspaceId).toBe(uuid);
    expect(camel.sessionId).toBe(uuid);
    expect(camel.sandboxId).toBe(inst);
    expect(camel.toolCallId).toBe(uuid);
    expect(camel.controllerId).toBe(uuid);
    expect(camel.processId).toBe(uuid);
    expect(camel.instanceName).toBe(inst);
  });

  test("i51: UUID exemption is strict (near-UUID secrets still redacted)", () => {
    // The exemption requires the version nibble (1-8) and variant nibble
    // (8/9/a/b) — a loose `[0-9a-f-]{36}` would let hyphenated hex secrets
    // through. Same 8-4-4-4-12 skeleton, bad version nibble (f), high entropy.
    const badVersion = "d7383605-d479-f47f9-bfef-8d62f82b729c";
    const outBadV = redactValue(`token ${badVersion} here`) as string;
    expect(outBadV).not.toContain(badVersion);
    expect(outBadV).toContain("[REDACTED]");
    // Same skeleton, bad variant nibble (c).
    const badVariant = "d7383605-d479-47f9-ceef-8d62f82b729c";
    const outBadVar = redactValue(`token ${badVariant} here`) as string;
    expect(outBadVar).not.toContain(badVariant);
    expect(outBadVar).toContain("[REDACTED]");
    // `dsh-` prefix does not blanket-exempt: high-entropy non-UUID content
    // after the prefix is still a secret.
    const outDsh = redactValue(`id dsh-${badVersion} end`) as string;
    expect(outDsh).not.toContain(badVersion);
    expect(outDsh).toContain("[REDACTED]");
    // A UUID glued to more hex is not a valid identifier — redact it
    // (hex-run boundaries in UUID_FIND_RE).
    const uuid = "d7383605-d479-47f9-bfef-8d62f82b729c";
    const glued = `${uuid}deadbeef`;
    const outGlued = redactValue(`x ${glued} y`) as string;
    expect(outGlued).not.toContain(glued);
    expect(outGlued).toContain("[REDACTED]");
    // A secret glued to a UUID redacts the whole token (remainder is itself
    // secret-shaped), it does not ride the UUID's exemption.
    const tail = "Xk9mPq3vT8RtY2wQ5sL7Zz";
    const gluedSecret = `${uuid}${tail}`;
    const outTail = redactValue(`x ${gluedSecret} y`) as string;
    expect(outTail).not.toContain(tail);
    expect(outTail).toContain("[REDACTED]");
    // Documented bounding (consistent with the pre-existing `a` x 20 case):
    // low-entropy repetition is not secret-shaped, exemption or not.
    const low = `dsh-${"a".repeat(36)}`;
    expect(redactValue(`id ${low} end`) as string).toContain(low);
  });

  test("i51: secret regression — every real shape still redacted after UUID exemption", () => {
    // OpenRouter, the key format this project actually uses (48-hex tail).
    const orKey = `sk-or-v1-${"0123456789abcdef".repeat(3)}`;
    const outOr = redactValue(`key ${orKey} leaked`) as string;
    expect(outOr).not.toContain("sk-or-v1");
    expect(outOr).toContain("[REDACTED]");
    // DeepSeek-style sk- keys.
    expect(redactValue("key is sk-1234567890abcdefghij1234 ok") as string).toContain(
      "[REDACTED]",
    );
    // PEM / Bearer / connection strings / GitHub prefixes / SA private_key.
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC...\n-----END PRIVATE KEY-----";
    expect(redactValue(`k ${pem} e`) as string).toContain("[REDACTED]");
    expect(
      redactValue("Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.sig") as string,
    ).toContain("[REDACTED]");
    expect(redactValue("postgres://user:pass@db.example.com:5432/mydb") as string).toContain(
      "[REDACTED]",
    );
    expect(redactValue("ghp_1234567890abcdef1234567890abcdef1234") as string).toContain(
      "[REDACTED]",
    );
    expect(
      redactValue("token ghs_abc123DEF456ghi789JKL012mno345pq end") as string,
    ).toContain("[REDACTED]");
    expect(
      redactValue("my pat github_pat_1234567890ABCDEFGHIJ_1234567890 here") as string,
    ).toContain("[REDACTED]");
    const sa = redactValue({
      type: "service_account",
      private_key: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCABCDEF1234567890abcdef",
    }) as Record<string, unknown>;
    expect(sa["private_key"]).toBe("[REDACTED]");
    // Bearer-less Google token / free-text JWT / AWS AKIA.
    const outYa = redactValue(
      "Error: request failed with token ya29.a0AfH6SMBx9mPq3vT8rY2nZ5bJ7hL0cF4dW6aG1sE2qX9zAbCdEfGh",
    ) as string;
    expect(outYa).not.toContain("a0AfH6SMB");
    expect(outYa).toContain("[REDACTED]");
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const outJwt = redactValue(`auth ${jwt} rejected`) as string;
    expect(outJwt).not.toContain("eyJhbGciOi");
    expect(outJwt).toContain("[REDACTED]");
    expect(redactValue("saw key AKIAIOSFODNN7EXAMPLE in log") as string).toContain(
      "[REDACTED]",
    );
    // High-entropy values under unknown keys.
    const hi36 = "xK9mPq3vT8rY2nZ5bJ7hL0cF4dW6aG1sE2qX9z";
    expect((redactValue({ db_pw: hi36 }) as Record<string, unknown>)["db_pw"]).toBe(
      "[REDACTED]",
    );
    expect((redactValue({ pwd: hi36 }) as Record<string, unknown>)["pwd"]).toBe("[REDACTED]");
    // secrets.token_hex(32) real output with NO commit context (the #29
    // 3rd-round context-limited SHA rescue must keep catching this).
    const hex64 = "625636386d8d6cff17fd2c37ba055ae206d9b53f589f4f1311f19abac2bee5cf";
    const outHex = redactValue(`token is ${hex64} here`) as string;
    expect(outHex).not.toContain(hex64);
    expect(outHex).toContain("[REDACTED]");
    expect((redactValue({ foo: hex64 }) as Record<string, unknown>)["foo"]).toBe(
      "[REDACTED]",
    );
  });

  // -----------------------------------------------------------------------
  // Error IDs for 500 correlation (issue #48; 16hex originated as a #51
  // workaround, retained as-is after #51/PR #54)
  // -----------------------------------------------------------------------

  test("i48: newErrorId is 16 lowercase hex (ERROR_ID_RE, single source of truth)", () => {
    for (let i = 0; i < 25; i++) {
      const id = newErrorId();
      expect(id).toMatch(ERROR_ID_RE);
      expect(id).toHaveLength(16);
    }
    // Uniqueness sanity: 25 draws must not collide (64-bit space).
    const ids = new Set(Array.from({ length: 25 }, () => newErrorId()));
    expect(ids.size).toBe(25);
  });

  test("i48: newErrorId survives the redactor verbatim (16hex retained after #51/PR #54)", () => {
    // Bare, embedded in free text, and under the real log field name —
    // the log line carrying the errorId must keep it readable.
    for (let i = 0; i < 25; i++) {
      const id = newErrorId();
      expect(redactValue(id)).toBe(id);
      expect(redactValue(`unexpected error ${id} logged`) as string).toContain(id);
      const obj = redactValue({ errorId: id }) as Record<string, unknown>;
      expect(obj["errorId"]).toBe(id);
    }
    // Via the logger, as the 500 path actually emits it.
    const logger = new InMemoryLogger();
    const id = newErrorId();
    logger.error("http.unexpected_error", { errorId: id } as unknown as LogFields);
    expect((logger.parsed[0] as Record<string, unknown>)["errorId"]).toBe(id);
    expect(logger.lines.join("\n")).toContain(id);
  });

  test("i48: 16hex errorIds never collide with the hex-40/64 SHA-rescue judgment (#29 3rd pass)", () => {
    // The rescue path only triggers for exact 40/64 hex (COMMIT_SHA_RE) seen
    // through the 20+-char entropy net. 16 chars clear both gates by length.
    const id = newErrorId();
    expect(id.length).toBeLessThan(20);
    // Same sentence shape, no commit-ish word nearby: a bare 40-hex secret
    // IS redacted here...
    const hex40 = "35bad8143c8813c45ca9841750209525f5177ab2";
    expect(redactValue(`token is ${hex40} here`) as string).not.toContain(hex40);
    // ...while the 16hex errorId in the identical shape survives.
    expect(redactValue(`token is ${id} here`) as string).toContain(id);
    // And a commit-context sentence keeps working for real SHAs (no
    // interference from the errorId path).
    const sha40 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
    expect(redactValue(`commit ${sha40} deployed`) as string).toContain(sha40);
  });

  test("i48/MINOR-1: describeError extracts class/message/stack without the raw object", () => {
    const err = new TypeError("boom");
    const d = describeError(err);
    expect(d.errorClass).toBe("TypeError");
    expect(d.errorMessage).toBe("boom");
    expect(typeof d.errorStack).toBe("string");
    expect(d.errorStack as string).toContain("TypeError");
    expect(describeError("plain string throw")).toEqual({
      errorClass: "string",
      errorMessage: "plain string throw",
    });
  });

  // -----------------------------------------------------------------------
  // NEVER log full command line or full environment
  // -----------------------------------------------------------------------

  test("never log full command line — log argv0 and argCount only", () => {
    const lines: string[] = [];
    const logger = createLogger({
      sink: (l) => lines.push(l),
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    // Try to log with argv containing secrets and full command
    logger.log({
      severity: "INFO",
      event: "sandbox.exec.completed",
      argv0: "npm",
      // @ts-expect-error - testing forbidden keys
      argv: ["npm", "run", "test", "--", "secret-token=ghs_abc123DEF456ghi789JKL0123456789"],
      // @ts-expect-error
      command: "npm run test -- secret-token=ghs_abc123DEF456ghi789JKL0123456789",
      // @ts-expect-error
      env: { DATABASE_URL: "postgres://user:pass@host/db", NORMAL: "value" },
      durationMs: 100,
      exitCode: 0,
    } as unknown as LogFields);

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed["argv"]).toBeUndefined();
    expect(parsed["command"]).toBeUndefined();
    expect(parsed["env"]).toBeUndefined();
    expect(parsed["argv0"]).toBe("npm");
    expect(parsed["argCount"]).toBe(5); // npm + 4 args
    // Ensure no token leaked
    const raw = lines[0]!;
    expect(raw).not.toContain("ghs_abc123");
    expect(raw).not.toContain("postgres://");
  });

  test("InMemoryLogger also strips full command/env", () => {
    const logger = new InMemoryLogger();
    logger.log({
      severity: "INFO",
      event: "test",
      // @ts-expect-error
      args: ["a", "b", "c"],
      // @ts-expect-error
      environment: { FOO: "bar" },
    } as unknown as LogFields);
    const parsed = logger.parsed[0] as Record<string, unknown>;
    expect(parsed["args"]).toBeUndefined();
    expect(parsed["environment"]).toBeUndefined();
    expect(parsed["argCount"]).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Metrics facade
  // -----------------------------------------------------------------------

  test("METRIC_NAMES typed constants match spec", () => {
    expect(METRIC_NAMES.workspaceStartDuration).toBe("workspace.start.duration");
    expect(METRIC_NAMES.workspaceRestoreDuration).toBe("workspace.restore.duration");
    expect(METRIC_NAMES.workspaceCheckpointDuration).toBe("workspace.checkpoint.duration");
    expect(METRIC_NAMES.sandboxCreateDuration).toBe("sandbox.create.duration");
    expect(METRIC_NAMES.sandboxExecDuration).toBe("sandbox.exec.duration");
    expect(METRIC_NAMES.sandboxResetCount).toBe("sandbox.reset.count");
    expect(METRIC_NAMES.agentTurnDuration).toBe("agent.turn.duration");
    expect(METRIC_NAMES.subprocessTimeoutCount).toBe("subprocess.timeout.count");
    expect(METRIC_NAMES.instanceActiveMinutes).toBe("instance.active_minutes");
    expect(METRIC_NAMES.cpuUtilization).toBe("cpu.utilization");
    expect(METRIC_NAMES.memoryUtilization).toBe("memory.utilization");
  });

  test("NoOpMetrics does not throw", () => {
    const m = new NoOpMetrics();
    m.recordDuration("workspace.start.duration", 123);
    m.increment("sandbox.reset.count", 1);
    m.gauge("cpu.utilization", 0.5);
    m.record({ name: "memory.utilization", value: 0.8 });
  });

  test("InMemoryMetrics recorder for tests", () => {
    const m = new InMemoryMetrics();
    m.recordDuration(METRIC_NAMES.sandboxExecDuration, 4212, { workspaceId: "ws-1" });
    m.increment(METRIC_NAMES.sandboxResetCount);
    m.gauge(METRIC_NAMES.cpuUtilization, 0.75);
    expect(m.events.length).toBe(3);
    expect(m.findByName("sandbox.exec.duration")[0]!.value).toBe(4212);
    expect(m.findByName("sandbox.reset.count")[0]!.value).toBe(1);
    expect(m.findByName("cpu.utilization")[0]!.value).toBe(0.75);

    m.clear();
    expect(m.events.length).toBe(0);
  });

  test("metrics record with tags preserved", () => {
    const m = new InMemoryMetrics();
    m.record({ name: "agent.turn.duration", value: 5000, tags: { workspaceId: "ws-1" } });
    expect(m.events[0]!.tags).toEqual({ workspaceId: "ws-1" });
  });
});
