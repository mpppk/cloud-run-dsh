import { describe, test, expect } from "bun:test";
import type { WorkspaceRuntimeState } from "./state.js";
import {
  WORKSPACE_RUNTIME_STATES,
  WORKSPACE_STATE_TRANSITIONS,
  AGENT_INPUT_REFUSED_STATES,
  IllegalTransitionError,
  assertTransition,
  canTransition,
  isAgentInputAllowed,
} from "./state.js";

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

describe("state transition table (仕様書 section 9)", () => {
  test("table covers every state", () => {
    for (const state of WORKSPACE_RUNTIME_STATES) {
      expect(WORKSPACE_STATE_TRANSITIONS[state]).toBeArray();
      expect(WORKSPACE_STATE_TRANSITIONS[state]!.length).toBeGreaterThan(0);
    }
    expect(WORKSPACE_RUNTIME_STATES).toHaveLength(10);
  });

  test("no state can transition to itself", () => {
    for (const state of WORKSPACE_RUNTIME_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  test("every table entry is a known state", () => {
    for (const [from, tos] of Object.entries(WORKSPACE_STATE_TRANSITIONS)) {
      expect(WORKSPACE_RUNTIME_STATES).toContain(from as WorkspaceRuntimeState);
      for (const to of tos) {
        expect(WORKSPACE_RUNTIME_STATES).toContain(to);
      }
    }
  });

  // Happy path from the spec diagram
  test("STOPPED -> STARTING -> RESTORING -> READY is legal", () => {
    assertTransition("STOPPED", "STARTING");
    assertTransition("STARTING", "RESTORING");
    assertTransition("RESTORING", "READY");
  });

  test("READY <-> BUSY and READY <-> CHECKPOINTING are legal, both return to READY", () => {
    assertTransition("READY", "BUSY");
    assertTransition("BUSY", "READY");
    assertTransition("READY", "CHECKPOINTING");
    assertTransition("CHECKPOINTING", "READY");
  });

  test("READY -> STOPPING -> STOPPED is legal (after lifecycle checkpoint)", () => {
    assertTransition("READY", "STOPPING");
    assertTransition("STOPPING", "STOPPED");
  });

  test("BUSY and CHECKPOINTING can go to STOPPING (graceful stop from active states)", () => {
    assertTransition("BUSY", "STOPPING");
    assertTransition("CHECKPOINTING", "STOPPING");
  });

  test("restore failure: STARTING/RESTORING -> RESTORE_FAILED (仕様書 section 8)", () => {
    assertTransition("STARTING", "RESTORE_FAILED");
    assertTransition("RESTORING", "RESTORE_FAILED");
  });

  test("checkpoint failure during stop: STOPPING -> CHECKPOINT_FAILED", () => {
    assertTransition("STOPPING", "CHECKPOINT_FAILED");
  });

  test("generic failures land in ERROR", () => {
    for (const from of ["READY", "BUSY", "CHECKPOINTING", "STOPPING"] as const) {
      assertTransition(from, "ERROR");
    }
  });

  test("recovery edges are legal", () => {
    assertTransition("ERROR", "STARTING");
    assertTransition("ERROR", "STOPPING");
    assertTransition("RESTORE_FAILED", "STARTING");
    assertTransition("RESTORE_FAILED", "STOPPING");
    assertTransition("CHECKPOINT_FAILED", "READY");
    assertTransition("CHECKPOINT_FAILED", "STARTING");
    assertTransition("CHECKPOINT_FAILED", "STOPPING");
  });

  // Representative illegal transitions
  describe("illegal transitions throw IllegalTransitionError", () => {
    const representativeIllegal: readonly [WorkspaceRuntimeState, WorkspaceRuntimeState][] = [
      // skipping states
      ["STOPPED", "READY"],
      ["STOPPED", "STOPPING"],
      ["STOPPED", "RESTORING"],
      ["STARTING", "READY"],
      ["STARTING", "BUSY"],
      ["STARTING", "STOPPED"],
      ["RESTORING", "BUSY"],
      ["RESTORING", "STOPPED"],
      ["READY", "STARTING"],
      ["READY", "STOPPED"],
      ["READY", "RESTORE_FAILED"],
      ["BUSY", "STARTING"],
      ["BUSY", "STOPPED"],
      ["CHECKPOINTING", "STARTING"],
      ["CHECKPOINTING", "STOPPED"],
      ["STOPPING", "READY"],
      ["STOPPING", "BUSY"],
      ["STOPPING", "STARTING"],
      // error recovery without cleanup
      ["ERROR", "READY"],
      ["ERROR", "BUSY"],
      ["ERROR", "STOPPED"],
      ["RESTORE_FAILED", "READY"],
      ["RESTORE_FAILED", "BUSY"],
      ["RESTORE_FAILED", "RESTORING"],
      ["CHECKPOINT_FAILED", "BUSY"],
      ["CHECKPOINT_FAILED", "RESTORING"],
      ["CHECKPOINT_FAILED", "STOPPED"],
      // self transitions
      ["READY", "READY"],
      ["BUSY", "BUSY"],
      ["STOPPED", "STOPPED"],
      ["ERROR", "ERROR"],
    ];

    for (const [from, to] of representativeIllegal) {
      test(`${from} -> ${to} is illegal`, () => {
        expect(canTransition(from, to)).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
      });
    }

    test("error carries from/to", () => {
      const err = new IllegalTransitionError("READY", "STOPPED");
      expect(err.from).toBe("READY");
      expect(err.to).toBe("STOPPED");
      expect(err.message).toContain("READY -> STOPPED");
      expect(err).toBeInstanceOf(Error);
    });

    test("unknown from-state is illegal", () => {
      expect(
        canTransition("SUSPENDED" as WorkspaceRuntimeState, "READY"),
      ).toBe(false);
    });
  });

  describe("agent input gate (仕様書 section 8)", () => {
    test("refused in failure and lifecycle states", () => {
      for (const state of AGENT_INPUT_REFUSED_STATES) {
        expect(isAgentInputAllowed(state)).toBe(false);
      }
      expect(AGENT_INPUT_REFUSED_STATES).toContain("RESTORE_FAILED");
      expect(AGENT_INPUT_REFUSED_STATES).toContain("STOPPING");
      expect(AGENT_INPUT_REFUSED_STATES).toContain("ERROR");
      expect(AGENT_INPUT_REFUSED_STATES).toContain("CHECKPOINT_FAILED");
    });

    test("allowed only in READY/BUSY", () => {
      expect(isAgentInputAllowed("READY")).toBe(true);
      expect(isAgentInputAllowed("BUSY")).toBe(true);
      for (const state of WORKSPACE_RUNTIME_STATES) {
        if (state === "READY" || state === "BUSY") {
          expect(isAgentInputAllowed(state)).toBe(true);
        }
      }
    });
  });
});