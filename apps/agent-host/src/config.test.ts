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
});
