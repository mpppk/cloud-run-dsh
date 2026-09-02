# Local development — control plane

Run the control-plane API locally with **all in-memory dependencies** (no GCP,
Cloud SQL, or Cloud Run required) and drive it with `curl`.

## What runs

`bun run dev:control-plane` starts the full HTTP surface (defined in
`apps/control-plane/src/dev.ts`) on `127.0.0.1:$PORT` (default **8787**) with:

| Dependency | Local implementation |
| --- | --- |
| Session persistence (`PostgresSessionPersistenceRepository`) | over `InMemoryFakeExecutor` (from `@cloud-run-dsh/session-persistence-postgres/testing`) |
| Controller lease (`ControllerLeaseService`) | over `InMemoryLeaseStore` (from `@cloud-run-dsh/controller-lease/testing`) |
| Workspace membership | `InMemoryMembershipStore` (the workspace owner is added automatically) |
| Runtime handles | `RuntimeRegistry` + `LoggingWorkspaceRuntimeHandle` — open/stop flip the state and every activity kind is printed to the console |
| Clock | `SystemClock` |
| Identity | **any** IAP identity is accepted; the subject becomes the internal user id |

## Start it

```bash
bun run dev:control-plane
# [dev] control plane listening on http://127.0.0.1:8787
```

Use a different port with `PORT=9000 bun run dev:control-plane`.

## Authentication (IAP headers)

The API expects the two headers that Identity-Aware Proxy injects in front of
Cloud Run. Locally you set them yourself:

```
x-goog-authenticated-user-id: accounts.google.com:<user-id>
x-goog-authenticated-user-email: <user-email>
```

Any user id/email pair works locally; the part after `accounts.google.com:` is
the internal user id. Requests without these headers get `401`.

## curl walkthrough

Run these against `http://127.0.0.1:8787`. Set shell variables once:

```bash
BASE=http://127.0.0.1:8787
ALICE_ID='x-goog-authenticated-user-id: accounts.google.com:alice'
ALICE_EMAIL='x-goog-authenticated-user-email: alice@example.com'
```

### 1. Create a workspace (201)

```bash
curl -s -H "$ALICE_ID" -H "$ALICE_EMAIL" -H 'content-type: application/json' \
  -X POST "$BASE/v1/workspaces" \
  -d '{"repositoryOwner":"mpppk","repositoryName":"demo","baseBranch":"main"}'
# {"id":"…","ownerId":"alice",…,"runtimeState":"STOPPED",…}
```

Copy the returned `id` into `WS_ID`:

```bash
WS_ID=<paste the workspace id>
```

### 2. Open the workspace (200)

```bash
curl -s -H "$ALICE_ID" -H "$ALICE_EMAIL" -H 'content-type: application/json' \
  -X POST "$BASE/v1/workspaces/$WS_ID/open" -d '{}'
# {"workspaceId":"…","state":"READY"}
```

### 3. Create a session (201)

```bash
curl -s -H "$ALICE_ID" -H "$ALICE_EMAIL" -H 'content-type: application/json' \
  -X POST "$BASE/v1/workspaces/$WS_ID/sessions" -d '{}'
# {"id":"…","workspaceId":"…","metadata":{},…}
```

Copy the returned `id` into `SESSION_ID`:

```bash
SESSION_ID=<paste the session id>
```

### 4. Acquire the controller lease (200)

```bash
curl -s -H "$ALICE_ID" -H "$ALICE_EMAIL" -H 'content-type: application/json' \
  -X POST "$BASE/v1/workspaces/$WS_ID/controller/acquire" -d '{}'
# {"workspaceId":"…","controllerId":"…","expiresAt":"…"}
```

### 5. Post a message (201)

The message field is **`content`**, not `text`:

```bash
curl -s -H "$ALICE_ID" -H "$ALICE_EMAIL" -H 'content-type: application/json' \
  -X POST "$BASE/v1/sessions/$SESSION_ID/messages" \
  -d '{"content":"fix the flaky test"}'
# {"sessionId":"…","seq":0,"eventType":"user_message","eventTime":…,"data":{"content":"fix the flaky test"}}
```

### 6. Watch the event stream (SSE)

```bash
curl -N -H "$ALICE_ID" -H "$ALICE_EMAIL" "$BASE/v1/sessions/$SESSION_ID/events?seq=0"
# id: 0
# event: user_message
# data: {"content":"fix the flaky test"}
#
# : stream open
```

`?seq=N` replays events with `seq >= N` and then keeps streaming; omit it to
replay the whole session. Send another message (step 5) in a second terminal
and watch it appear.

## Behavior to expect

- **401** — no/malformed IAP headers.
- **403** — the user is not a member of the workspace (only the creator is a
  member automatically).
- **409** — a member without the controller lease tries message / approval /
  cancel / manual checkpoint ("observer"), or a second controller tries to
  acquire while the lease is active.
- **400** — malformed path segments, invalid JSON, missing fields.
- Console logs from the dev server show every `open`/`stop` and activity kind
  (`user_message`, `approval`, `checkpoint`, `workspace_operation`).

State is entirely in memory — restarting the server wipes everything.
