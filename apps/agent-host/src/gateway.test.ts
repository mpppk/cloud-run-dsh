import { describe, expect, test } from "bun:test";
import { InMemoryLogger } from "@cloud-run-dsh/observability";
import { AGENT_HOST_HEALTH_PATH } from "@cloud-run-dsh/workspace-runtime";
import { composeTestHost, seedWorkspace } from "./fakes.js";
import { AgentGateway } from "./gateway.js";
import type { AgentTurnInput, TurnStarter } from "./gateway.js";

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Request {
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { ...headers, "content-type": "application/json" };
  }
  return new Request(`http://localhost:8080${path}`, init);
}

/** Recording TurnStarter fake: never touches the repo (single-writer proof). */
class RecordingTurnStarter implements TurnStarter {
  inputs: AgentTurnInput[] = [];
  failNext: Error | null = null;
  async startTurn(input: AgentTurnInput): Promise<void> {
    this.inputs.push(input);
    if (this.failNext) throw this.failNext;
  }
}

/** Issue #21 stub: records the cancel/approval seam calls. */
class SeamedTurnStarter extends RecordingTurnStarter {
  cancelled: (string | undefined)[] = [];
  approvals: { approvalId: string; decision: string }[] = [];
  async cancelTurn(sessionId?: string): Promise<number> {
    this.cancelled.push(sessionId);
    return 1;
  }
  async resolveApproval(approvalId: string, decision: "approved" | "rejected"): Promise<boolean> {
    this.approvals.push({ approvalId, decision });
    return approvalId !== "unknown";
  }
}

const IAP = { "x-goog-authenticated-user-email": "user@example.com" };

async function gatewayWithReadyHost() {
  const th = await composeTestHost();
  await seedWorkspace(th);
  await th.host.recover();
  return th;
}

describe("AgentGateway", () => {
  test("GET AGENT_HOST_HEALTH_PATH does not require IAP identity", async () => {
    const th = await composeTestHost();
    const res = await th.host.gateway.handle(request("GET", AGENT_HOST_HEALTH_PATH));
    expect(res.status).toBe(503); // RESTORING — not ready yet
    await seedWorkspace(th);
    await th.host.recover();
    const ready = await th.host.gateway.handle(request("GET", AGENT_HOST_HEALTH_PATH));
    expect(ready.status).toBe(200);
  });

  test("issue #68: the health path is not /healthz (Cloud Run reserves it)", async () => {
    // The shared constant is the contract the control-plane poll builds its
    // URL from — if this ever reads "/healthz" again, the open flow is
    // broken by construction (the Cloud Run frontend answers /healthz
    // itself and never forwards it to the container).
    expect(AGENT_HOST_HEALTH_PATH).toBe("/readyz");
    expect(AGENT_HOST_HEALTH_PATH).not.toBe("/healthz");
    const th = await gatewayWithReadyHost();
    const served = await th.host.gateway.handle(request("GET", AGENT_HOST_HEALTH_PATH));
    expect(served.status).toBe(200);
    // ... and the reserved path is NOT served here (a 404 from the gateway
    // proves the move; on GCP the platform answers /healthz before us).
    // NOTE: with IAP identity — without it the gateway 401s before route
    // matching, which would prove nothing about the path.
    const reserved = await th.host.gateway.handle(request("GET", "/healthz", IAP));
    expect(reserved.status).toBe(404);
  });

  test("non-health routes require an IAP identity", async () => {
    const th = await gatewayWithReadyHost();
    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages"),
    );
    expect(res.status).toBe(401);
  });

  test("workspace mismatch is refused", async () => {
    const th = await gatewayWithReadyHost();
    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/other/sessions/s1/messages", IAP),
    );
    expect(res.status).toBe(403);
  });

  test("agent input is refused while not READY", async () => {
    const th = await composeTestHost();
    await seedWorkspace(th);
    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP),
    );
    // Not READY (RESTORING) AND lease not yet held — both refuse.
    expect([409]).toContain(res.status);
  });

  test("message starts the turn via the starter; approval/cancel need no starter", async () => {
    const starter = new RecordingTurnStarter();
    const th = await composeTestHost({}, { turnStarter: starter });
    await seedWorkspace(th);
    await th.host.recover();
    const message = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP, {
        sessionId: "s1",
        seq: 3,
        content: "hello",
      }),
    );
    expect(message.status).toBe(202);
    expect(await message.json()).toMatchObject({ accepted: true, turnStarted: true, seq: 3 });
    expect(starter.inputs).toEqual([
      { workspaceId: "ws-1", sessionId: "s1", seq: 3, content: "hello" },
    ]);

    const approval = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/approvals", IAP),
    );
    expect(approval.status).toBe(202);
    const cancel = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/cancel", IAP),
    );
    expect(cancel.status).toBe(202);
    // Approvals/cancel never touch the turn starter (messages-only seam).
    expect(starter.inputs).toHaveLength(1);
  });

  test("requests without the controller lease are refused with 409", async () => {    const th = await gatewayWithReadyHost();
    // Release the lease: the gateway must refuse controller-gated actions.
    await th.host.lease.release("ws-1", "ctrl-1");
    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP),
    );
    expect(res.status).toBe(409);
  });

  test("SSE endpoint streams heartbeats as non-meaningful activity", async () => {
    const th = await gatewayWithReadyHost();
    const idleBefore = th.host.idle.getIdleMs();
    const res = await th.host.gateway.handle(
      request("GET", "/workspaces/ws-1/sessions/s1/events", IAP),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // The open + a health poll did not register meaningful activity.
    expect(th.host.idle.getIdleMs()).toBeGreaterThanOrEqual(idleBefore ?? 0);
  });

  test("unknown paths 404, wrong methods 405", async () => {
    const th = await gatewayWithReadyHost();
    expect((await th.host.gateway.handle(request("GET", "/nope", IAP))).status).toBe(404);
    expect(
      (await th.host.gateway.handle(request("DELETE", AGENT_HOST_HEALTH_PATH))).status,
    ).toBe(405);
  });

  test("messages without a TurnStarter answer 503 with an explicit code (never a fake 202)", async () => {
    const logger = new InMemoryLogger();
    const th = await composeTestHost({}, { logger });
    await seedWorkspace(th);
    await th.host.recover();
    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP, {
        sessionId: "s1",
        seq: 0,
        content: "hi",
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "turn_not_implemented" });
    expect(
      logger.parsed.some((e) => e["event"] === "gateway.turn.not_implemented"),
    ).toBe(true);
  });

  test("cancel reaches the starter's cancelTurn; approvals resolve by id", async () => {
    const starter = new SeamedTurnStarter();
    const th = await composeTestHost({}, { turnStarter: starter });
    await seedWorkspace(th);
    await th.host.recover();

    const sessionCancel = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/cancel", IAP),
    );
    expect(sessionCancel.status).toBe(202);
    expect(await sessionCancel.json()).toMatchObject({ accepted: true, turnsCancelled: 1 });

    const workspaceCancel = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/cancel", IAP),
    );
    expect(workspaceCancel.status).toBe(202);
    expect(await workspaceCancel.json()).toMatchObject({ turnsCancelled: 1 });
    expect(starter.cancelled).toEqual(["s1", undefined]);

    const approval = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/approvals", IAP, {
        approvalId: "ask-1",
        decision: "rejected",
      }),
    );
    expect(approval.status).toBe(202);
    expect(await approval.json()).toMatchObject({ accepted: true, approvalResolved: true });
    expect(starter.approvals).toEqual([{ approvalId: "ask-1", decision: "rejected" }]);

    // Unknown approval ids still 202 (acceptance stands) but report unresolved.
    const unknownApproval = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/approvals", IAP, {
        approvalId: "unknown",
        decision: "approved",
      }),
    );
    expect(await unknownApproval.json()).toMatchObject({ approvalResolved: false });

    // A body-less approval keeps the historical accept-only 202 shape.
    const bodyless = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/approvals", IAP),
    );
    expect(bodyless.status).toBe(202);
    const bodylessJson = (await bodyless.json()) as Record<string, unknown>;
    expect(bodylessJson).toMatchObject({ accepted: true });
    expect("approvalResolved" in bodylessJson).toBe(false);
    // Neither path starts a turn.
    expect(starter.inputs).toHaveLength(0);
  });

  test("the gateway never appends user_message itself (single writer is the control plane)", async () => {
    const starter = new RecordingTurnStarter();
    const th = await composeTestHost({}, { turnStarter: starter });
    await seedWorkspace(th);
    await th.host.recover();
    // The control-plane-written event, seeded directly.
    await th.repository.createSession({ id: "s1", workspaceId: "ws-1" });
    await th.repository.append("s1", [
      { eventType: "user_message", eventTime: 1, data: { content: "hi" } },
    ]);

    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP, {
        sessionId: "s1",
        seq: 0,
        content: "hi",
      }),
    );
    expect(res.status).toBe(202);
    // Still exactly the one event — no duplicate append on the host side.
    const events = await th.repository.readEvents("s1");
    expect(events.map((e) => e.eventType)).toEqual(["user_message"]);
    expect(starter.inputs[0]).toMatchObject({ seq: 0, content: "hi" });
  });

  test("sessionId mismatch between path and body -> 400", async () => {
    const starter = new RecordingTurnStarter();
    const th = await composeTestHost({}, { turnStarter: starter });
    await seedWorkspace(th);
    await th.host.recover();
    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP, {
        sessionId: "other",
        seq: 0,
        content: "hi",
      }),
    );
    expect(res.status).toBe(400);
    expect(starter.inputs).toHaveLength(0);
  });

  test("malformed forwarded bodies -> 400 without starting a turn", async () => {
    const starter = new RecordingTurnStarter();
    const th = await composeTestHost({}, { turnStarter: starter });
    await seedWorkspace(th);
    await th.host.recover();
    const bad = [
      "not json",
      JSON.stringify({ content: "missing seq" }),
      JSON.stringify({ seq: "zero", content: "hi" }),
      JSON.stringify({ seq: 0, content: 42 }),
    ];
    for (const body of bad) {
      const res = await th.host.gateway.handle(
        request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP, body),
      );
      expect(res.status).toBe(400);
    }
    expect(starter.inputs).toHaveLength(0);
  });

  test("starter failure -> 500 (the control plane maps it to its 502)", async () => {
    const starter = new RecordingTurnStarter();
    starter.failNext = new Error("llm exploded");
    const th = await composeTestHost({}, { turnStarter: starter });
    await seedWorkspace(th);
    await th.host.recover();
    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP, {
        sessionId: "s1",
        seq: 0,
        content: "hi",
      }),
    );
    expect(res.status).toBe(500);
  });
});

describe("lifecycle routes (issues #72/#75)", () => {
  test("POST prepare-stop drains, checkpoints and stays STOPPING without stopping the instance", async () => {
    const th = await gatewayWithReadyHost();
    const res = await th.host.gateway.handle(request("POST", "/workspaces/ws-1/prepare-stop", IAP));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ prepared: true, state: "STOPPING" });
    expect(th.host.runtime.getState()).toBe("STOPPING");
    // The instance stop belongs to the control plane — the host never calls it.
    expect(th.instance.calls).not.toContainEqual(expect.stringContaining("stop"));
    // The sandbox was torn down and a checkpoint was attempted (clean tree:
    // scheduler skips the write but still succeeds — the bathwater rule).
    expect(th.sandboxRunner.recorded.some((argv) => argv.includes("delete"))).toBe(true);
  });

  test("prepare-stop is a lifecycle route, not agent input: no session, no starter, works while STOPPING-gated", async () => {
    const th = await gatewayWithReadyHost();
    // No sessionId in the path and no TurnStarter wired — still 200.
    const res = await th.host.gateway.handle(request("POST", "/workspaces/ws-1/prepare-stop", IAP));
    expect(res.status).toBe(200);
    // A second call re-enters STOPPING instead of 409 (unfinished-stop retry).
    const retry = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/prepare-stop", IAP),
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ prepared: true, state: "STOPPING" });
  });

  test("prepare-stop keeps the gateway guards: 401 without identity, 403 on mismatch, 409 without lease, 405 on GET", async () => {
    const th = await gatewayWithReadyHost();
    expect(
      (await th.host.gateway.handle(request("POST", "/workspaces/ws-1/prepare-stop"))).status,
    ).toBe(401);
    expect(
      (await th.host.gateway.handle(request("POST", "/workspaces/other/prepare-stop", IAP)))
        .status,
    ).toBe(403);
    expect(
      (await th.host.gateway.handle(request("GET", "/workspaces/ws-1/prepare-stop", IAP)))
        .status,
    ).toBe(405);
    await th.host.lease.release("ws-1", "ctrl-1");
    const fenced = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/prepare-stop", IAP),
    );
    expect(fenced.status).toBe(409);
    expect(await fenced.json()).toMatchObject({ error: "controller lease not held by this host" });
  });

  test("prepare-stop checkpoint failure -> 502 prepared:false with CHECKPOINT_FAILED (never 200)", async () => {
    const th = await gatewayWithReadyHost();
    // Sabotage AFTER recovery: git status now errors, so the lifecycle
    // checkpoint fails and the caller must NOT stop the instance.
    th.git.responses.set("status", { exitCode: 1, stdout: "", stderr: "disk gone" });
    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/prepare-stop", IAP),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ prepared: false, state: "CHECKPOINT_FAILED" });
    expect(th.host.runtime.getState()).toBe("CHECKPOINT_FAILED");
    expect(th.instance.calls).not.toContainEqual(expect.stringContaining("stop"));
  });

  test("POST checkpoint on a clean tree -> 200 checkpointed:true skipped:true (success, not a bug)", async () => {
    const th = await gatewayWithReadyHost();
    const keysBefore = th.storage.keys();
    const res = await th.host.gateway.handle(request("POST", "/workspaces/ws-1/checkpoint", IAP));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      checkpointed: true,
      skipped: true,
      state: "READY",
    });
    // Nothing new to persist: no bundle written, runtime untouched.
    expect(th.storage.keys()).toEqual(keysBefore);
    expect(th.host.runtime.getState()).toBe("READY");
  });

  test("POST checkpoint on a dirty tree writes a real bundle -> 200 checkpointed:true skipped:false", async () => {
    const th = await gatewayWithReadyHost();
    th.git.responses.set("status", { exitCode: 0, stdout: " M notes.txt\n", stderr: "" });
    const res = await th.host.gateway.handle(request("POST", "/workspaces/ws-1/checkpoint", IAP));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      checkpointed: true,
      skipped: false,
      state: "READY",
    });
    expect(th.storage.keys().length).toBeGreaterThan(0);
  });

  test("POST checkpoint failure -> 502 checkpointed:false (never a fake true)", async () => {
    const th = await gatewayWithReadyHost();
    th.git.responses.set("status", { exitCode: 1, stdout: "", stderr: "disk gone" });
    const res = await th.host.gateway.handle(request("POST", "/workspaces/ws-1/checkpoint", IAP));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ checkpointed: false });
  });

  test("checkpoint without a wired trigger -> 503 with an explicit code (never a fake true)", async () => {
    const th = await gatewayWithReadyHost();
    const bare = new AgentGateway({
      config: th.host.config,
      health: th.host.health,
      runtime: th.host.runtime,
      lease: th.host.lease,
      logger: th.host.logger,
    });
    const res = await bare.handle(request("POST", "/workspaces/ws-1/checkpoint", IAP));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: "checkpoint_not_implemented",
      checkpointed: false,
    });
  });

  test("checkpoint keeps the gateway guards: 401 without identity, 403 on mismatch", async () => {
    const th = await gatewayWithReadyHost();
    expect(
      (await th.host.gateway.handle(request("POST", "/workspaces/ws-1/checkpoint"))).status,
    ).toBe(401);
    expect(
      (await th.host.gateway.handle(request("POST", "/workspaces/other/checkpoint", IAP))).status,
    ).toBe(403);
  });
});

describe("unexpected error observability (issue #48)", () => {
  test("uncaught throw (lease lookup outage) -> generic 500 + redacted log with matching errorId", async () => {
    const logger = new InMemoryLogger();
    const th = await composeTestHost({}, { logger });
    await seedWorkspace(th);
    await th.host.recover();
    // Simulate a DB outage behind the lease lookup: the throw escapes every
    // inner handler and must still be logged, never leaked.
    const secret = "postgres://dsh_app:HostS3cretPassw0rd@10.0.0.3:5432/dsh";
    const token = "ghp_abcdefghij12345678901234567890abcd";
    th.host.lease.getActive = async () => {
      throw new Error(`lease store unreachable ${secret} ${token}`);
    };
    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP, {
        sessionId: "s1",
        seq: 0,
        content: "hi",
      }),
    );
    expect(res.status).toBe(500);
    const rawBody = await res.text();
    const body = JSON.parse(rawBody) as { error: string; errorId: string };
    expect(body.error).toBe("internal server error");
    expect(typeof body.errorId).toBe("string");
    expect(rawBody).not.toContain("lease store unreachable");
    expect(rawBody).not.toContain("HostS3cretPassw0rd");
    expect(rawBody).not.toContain(token);

    const line = logger.parsed.find((e) => e["event"] === "gateway.unexpected_error");
    expect(line).toBeTruthy();
    expect(line!["errorId"]).toBe(body.errorId);
    expect(line!["errorClass"]).toBe("Error");
    expect(line!["workspaceId"]).toBe("ws-1");
    expect(line!["sessionId"]).toBe("s1");
    expect(typeof line!["errorStack"]).toBe("string");
    const rawLogs = logger.lines.join("\n");
    expect(rawLogs).not.toContain("HostS3cretPassw0rd");
    expect(rawLogs).not.toContain(token);
    expect(rawLogs).not.toContain(secret);
  });

  test("starter failure 500 carries the errorId of the gateway.turn.failed log", async () => {
    const logger = new InMemoryLogger();
    const starter = new RecordingTurnStarter();
    starter.failNext = new Error("llm exploded");
    const th = await composeTestHost({}, { turnStarter: starter, logger });
    await seedWorkspace(th);
    await th.host.recover();
    const res = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP, {
        sessionId: "s1",
        seq: 0,
        content: "hi",
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; errorId: string };
    expect(body.error).toBe("turn failed to start");
    const line = logger.parsed.find((e) => e["event"] === "gateway.turn.failed");
    expect(line).toBeTruthy();
    expect(line!["errorId"]).toBe(body.errorId);
    expect(line!["errorClass"]).toBe("Error");
    expect(typeof line!["errorStack"]).toBe("string");
  });
});
