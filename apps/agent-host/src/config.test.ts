import { describe, expect, test } from "bun:test";
import {
  MissingRequiredEnvError,
  defaultCheckpointKey,
  readAgentHostConfig,
} from "./config.js";

const validEnv: Record<string, string> = {
  WORKSPACE_ID: "ws-9",
  CHECKPOINT_BUCKET: "bucket",
  DATABASE_URL: "postgres://db",
  GITHUB_APP_ID: "42",
  GITHUB_APP_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----",
  REPOSITORY_OWNER: "mpppk",
  REPOSITORY_NAME: "repo",
  BASE_BRANCH: "main",
  CONTROLLER_ID: "ctrl",
  USER_ID: "user",
  INSTANCE_NAME: "dsh-ws-9",
  GCP_PROJECT_ID: "proj",
  GCP_REGION: "us-central1",
};

describe("readAgentHostConfig", () => {
  test("parses required env with defaults", () => {
    const config = readAgentHostConfig(validEnv);
    expect(config.workspaceId).toBe("ws-9");
    expect(config.port).toBe(8080);
    expect(config.workspaceRoot).toBe("/workspace");
    expect(config.checkpointKey).toBe(defaultCheckpointKey("ws-9"));
    expect(config.sandboxCliPath).toBe("/usr/local/gcp/bin/sandbox");
    expect(config.allowEgress).toBe(true);
    // Issue #47: production default is the absolute v2 origin.
    expect(config.instancesApiBaseUrl).toBe("https://run.googleapis.com/v2");
    // Issue #21 LLM defaults: OpenRouter route, env-name credential ref, verified model.
    expect(config.llmBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.llmApiKeyEnv).toBe("OPENROUTER_API_KEY");
    expect(config.llmModel).toBe("deepseek/deepseek-v4-flash");
    expect(config.llmApprovalPolicy).toBe("ask");
    // Issue #109: pool budget defaults to the db-f1-micro share (5 of 25).
    expect(config.dbPoolMax).toBe(5);
    expect(config.dbPoolIdleTimeout).toBe(30);
    expect(config.dbPoolConnectionTimeout).toBe(30);
  });

  test("missing env throws with the missing key names", () => {
    expect(() => readAgentHostConfig({})).toThrow(MissingRequiredEnvError);
    try {
      readAgentHostConfig({});
    } catch (e) {
      const err = e as MissingRequiredEnvError;
      expect(err.missing).toContain("WORKSPACE_ID");
      expect(err.missing).toContain("GITHUB_APP_PRIVATE_KEY_PEM");
    }
  });

  test("honours optional overrides", () => {
    const config = readAgentHostConfig({
      ...validEnv,
      PORT: "9090",
      WORKSPACE_ROOT: "/workspaces/ws-9",
      SANDBOX_ALLOW_EGRESS: "false",
    });
    expect(config.port).toBe(9090);
    expect(config.workspaceRoot).toBe("/workspaces/ws-9");
    expect(config.allowEgress).toBe(false);
  });

  test("invalid PORT is refused", () => {
    expect(() => readAgentHostConfig({ ...validEnv, PORT: "nope" })).toThrow(/invalid PORT/);
  });

  test("LLM settings honour overrides; bad approval policy is refused", () => {
    const config = readAgentHostConfig({
      ...validEnv,
      LLM_BASE_URL: "https://example.com/v1",
      LLM_API_KEY_ENV: "MY_KEY",
      LLM_MODEL: "example/model",
      LLM_APPROVAL_POLICY: "never",
    });
    expect(config.llmBaseUrl).toBe("https://example.com/v1");
    expect(config.llmApiKeyEnv).toBe("MY_KEY");
    expect(config.llmModel).toBe("example/model");
    expect(config.llmApprovalPolicy).toBe("never");
    expect(() =>
      readAgentHostConfig({ ...validEnv, LLM_APPROVAL_POLICY: "sometimes" }),
    ).toThrow(/invalid LLM_APPROVAL_POLICY/);
  });

  test("pool budget honours overrides and refuses bad values (issue #109)", () => {
    const config = readAgentHostConfig({
      ...validEnv,
      DB_POOL_MAX: "20",
      DB_POOL_IDLE_TIMEOUT: "60",
      DB_POOL_CONNECTION_TIMEOUT: "10",
    });
    expect(config.dbPoolMax).toBe(20);
    expect(config.dbPoolIdleTimeout).toBe(60);
    expect(config.dbPoolConnectionTimeout).toBe(10);
    expect(() => readAgentHostConfig({ ...validEnv, DB_POOL_MAX: "0" })).toThrow(
      /DB_POOL_MAX/,
    );
    expect(() => readAgentHostConfig({ ...validEnv, DB_POOL_IDLE_TIMEOUT: "-1" })).toThrow(
      /DB_POOL_IDLE_TIMEOUT/,
    );
  });

  test("INSTANCES_API_BASE_URL defaults to production, honors overrides, rejects relative (issue #47)", () => {
    expect(readAgentHostConfig(validEnv).instancesApiBaseUrl).toBe(
      "https://run.googleapis.com/v2",
    );
    expect(
      readAgentHostConfig({ ...validEnv, INSTANCES_API_BASE_URL: "http://localhost:8080/v2" })
        .instancesApiBaseUrl,
    ).toBe("http://localhost:8080/v2");
    expect(
      readAgentHostConfig({ ...validEnv, INSTANCES_API_BASE_URL: "   " }).instancesApiBaseUrl,
    ).toBe("https://run.googleapis.com/v2");
    expect(() =>
      readAgentHostConfig({
        ...validEnv,
        INSTANCES_API_BASE_URL: "projects/proj/locations/us-central1",
      }),
    ).toThrow(/invalid INSTANCES_API_BASE_URL/);
  });
});
