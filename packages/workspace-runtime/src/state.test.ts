import { describe, test, expect } from "bun:test";
import type { WorkspaceRuntimeState } from "./state.js";

describe("WorkspaceRuntimeState", () => {
  test("union contains all required states", () => {
    const states: WorkspaceRuntimeState[] = [
      "STOPPED",
      "STARTING",
      "RESTORING",
      "READY",
      "BUSY",
      "CHECKPOINTING",
      "STOPPING",
      "ERROR",
      "RESTORE_FAILED",
      "CHECKPOINT_FAILED",
    ];
    expect(states).toHaveLength(10);
    expect(states).toContain("READY");
    expect(states).toContain("CHECKPOINT_FAILED");
  });
});
