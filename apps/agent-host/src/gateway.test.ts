import { describe, expect, test } from "bun:test";
import { composeTestHost, seedWorkspace } from "./fakes.js";

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost:8080${path}`, { method, headers });
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

  test("message / approval / cancel are accepted when READY with the lease", async () => {
    const th = await gatewayWithReadyHost();
    const message = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/messages", IAP),
    );
    expect(message.status).toBe(202);
    const approval = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/sessions/s1/approvals", IAP),
    );
    expect(approval.status).toBe(202);
    const cancel = await th.host.gateway.handle(
      request("POST", "/workspaces/ws-1/cancel", IAP),
    );
    expect(cancel.status).toBe(202);
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
});
