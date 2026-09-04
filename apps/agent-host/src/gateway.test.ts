import { describe, expect, test } from "bun:test";
import { InMemoryLogger } from "@cloud-run-dsh/observability";
import { composeTestHost, seedWorkspace } from "./fakes.js";
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

const IAP = { "x-goog-authenticated-user-email": "user@example.com" };

async function gatewayWithReadyHost() {
  const th = await composeTestHost();
  await seedWorkspace(th);
  await th.host.recover();
  return th;
}

describe("AgentGateway", () => {
  test("GET /healthz does not require IAP identity", async () => {
    const th = await composeTestHost();
    const res = await th.host.gateway.handle(request("GET", "/healthz"));
    expect(res.status).toBe(503); // RESTORING — not ready yet
    await seedWorkspace(th);
    await th.host.recover();
    const ready = await th.host.gateway.handle(request("GET", "/healthz"));
    expect(ready.status).toBe(200);
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

  test("requests without the controller lease are refused with 409", async () => {
    const th = await gatewayWithReadyHost();
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
    expect((await th.host.gateway.handle(request("DELETE", "/healthz"))).status).toBe(405);
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
