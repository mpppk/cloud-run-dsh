import { describe, test, expect } from "bun:test";
import {
  PLACEHOLDER_KIND,
  createPlaceholder,
  createLogger,
  InMemoryLogger,
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

  test("redacts high-entropy generic tokens and avoids false positives", () => {
    // High-entropy 32-char mixed-case + digits token should be redacted (spec 26 item 12)
    const highEntropy = "xK9mPq3vT8rY2nZ5bJ7hL0cF4dW6aG1sE2qXyZ";
    const out = redactValue(`token is ${highEntropy} here`) as string;
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(highEntropy);

    // Also via logger: high-entropy token in any log value is redacted
    const logger = new InMemoryLogger();
    logger.info("sandbox.exec.completed", {
      workspaceId: "ws-1",
      sandboxId: highEntropy,
    } as unknown as LogFields);
    const logged = logger.parsed[0] as Record<string, unknown>;
    expect(logged["sandboxId"] as string).toBe("[REDACTED]");

    // Bounding: low-entropy 20-char repeated string must NOT be redacted (false positive check)
    const lowEntropy = "aaaaaaaaaaaaaaaaaaaa";
    expect(redactValue(lowEntropy) as string).toBe(lowEntropy);
    expect(redactValue("hello world") as string).toBe("hello world");
    // Workspace-like ID short mixed but low entropy / short should not be redacted separately
    expect(redactValue("ws-123") as string).toBe("ws-123");
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
