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
| Runtime handles | `RuntimeRegistry` + `LoggingWorkspaceRuntimeHandle` — `open` answers `STARTING` at once and flips to `READY` ~3s later (the async agent-host leg, played by a timer), `stop` flips to `STOPPED`, and every activity kind is printed to the console |
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

### 1b. List your workspaces (200)

Returns only workspaces you belong to — never anyone else's. With no
workspaces the shape is `{"workspaces": []}`. Like the controller status
read, listing never extends the idle timer:

```bash
curl -s -H "$ALICE_ID" -H "$ALICE_EMAIL" "$BASE/v1/workspaces"
# {"workspaces":[{"id":"…","ownerId":"alice",…,"runtimeState":"STOPPED",…}]}
```

### 2. Open the workspace (202, async)

`open` returns within seconds with `202` + the live state (`STARTING`).
The dev server stands in for the agent-host and flips the row to `READY`
~3 seconds later (`DEV_OPEN_READY_DELAY_MS` in `apps/control-plane/src/dev.ts`;
in production the agent-host does this after boot + restore). Poll `GET`
until `runtimeState` reads `READY`:

```bash
curl -s -H "$ALICE_ID" -H "$ALICE_EMAIL" -H 'content-type: application/json' \
  -X POST "$BASE/v1/workspaces/$WS_ID/open" -d '{}'
# {"workspaceId":"…","state":"STARTING"}

curl -s -H "$ALICE_ID" -H "$ALICE_EMAIL" "$BASE/v1/workspaces/$WS_ID"
# … "runtimeState":"STARTING" … → (a few seconds later) … "runtimeState":"READY" …
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

### 4b. Check controller status (200)

`open` implicitly takes the controller lease for the opener, so this reads
`mine: true` even before any `acquire`. It returns only your relationship
to the lease (`held` / `mine` / `expiresAt`) — never `controllerId` or user
ids — and never extends the idle timer, so the debug UI polls it freely:

```bash
curl -s -H "$ALICE_ID" -H "$ALICE_EMAIL" \
  "$BASE/v1/workspaces/$WS_ID/controller"
# {"held":true,"mine":true,"expiresAt":"…"}
```

### 5. Post a message (201)

The message field is **`content`**, not `text`:

```bash
curl -s -H "$ALICE_ID" -H "$ALICE_EMAIL" -H 'content-type: application/json' \
  -X POST "$BASE/v1/sessions/$SESSION_ID/messages" \
  -d '{"content":"fix the flaky test"}'
# {"sessionId":"…","seq":0,"eventType":"user_message","eventTime":…,"data":{"content":"fix the flaky test"}}
```

In production, messaging a workspace that is still `STARTING` / `RESTORING`
answers `409` — finish step 2 (poll to `READY`) first. The dev server never
refuses (it has no agent-host to be unready), so the walkthrough order above
is the production-safe order.

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
  acquire while the lease is active. A concurrent `stop` that loses the
  shared-row race also answers 409 (`conflict`) — just retry the stop.
  In production, message / approval / cancel against a workspace that is
  still `STARTING` / `RESTORING` (open accepted, agent-host not done yet)
  also answers 409 — poll `GET /v1/workspaces/:id` to `READY` first.
- **400** — malformed path segments, invalid JSON, missing fields.
- Console logs from the dev server show every `open`/`stop` and activity kind
  (`user_message`, `approval`, `checkpoint`, `workspace_operation`).

State is entirely in memory — restarting the server wipes everything.

## Web UI

`bun run dev:control-plane`, then open `http://127.0.0.1:8787/` — the
control-plane serves a dependency-free debug screen (workspace / lease /
session / turn / SSE / request log) from the same origin, so no CORS setup
is needed.

- The header box at the top fills `x-goog-authenticated-user-id` /
  `x-goog-authenticated-user-email` for every API call (saved to
  localStorage, omitted when empty).
- Under IAP leave both boxes empty: the proxy injects the headers, so the
  same screen works in production with no code change.
- Your workspaces are listed by `GET /v1/workspaces` (step 1b above);
  created ids are also kept in the browser's
  localStorage (an "existing id" box imports ids made via curl).

### Product UI (`/app`, issue #138)

`http://127.0.0.1:8787/app` serves the user-facing screen next to the debug
UI (`/` stays as-is). No build step, no npm dependencies — plain ES modules
(`/app/app.js` + the shared `/app/sse.js` parser).

- **Home (`/app`)**: workspace list from `GET /v1/workspaces` plus a
  "リポジトリを開く" form that runs create → prepare → session as one
  action, then moves to the conversation screen.
- **Conversation (`/app?ws=<id>`)**: chat + Japanese status banner +
  inline approval cards (approve / reject in place) + a two-tap stop
  button. The screen switches on the `?ws=<id>` query string — the pathname
  stays `/app` because the static allowlist serves exact paths only
  (dynamic `/app/<id>` pathnames answer 404).
- **Transparent resume**: sending while stopped prepares behind the
  "再開しています…" banner, waits for readiness via `GET` polling, then
  retries the send on the same session. A failed prepare shows
  "準備に失敗しました" with a retry button.
- **No auth inputs**: the page sends no auth headers. Locally the dev
  server's fake IAP stands in (headerless requests run as
  `dev@example.com`; any explicit header wins; disable with
  `DSH_DEV_FAKE_IAP=0`). Under production IAP the same page works
  untouched. The fake IAP lives only in `apps/control-plane/src/dev.ts` —
  `main.ts` never imports it.
- **Idle-timer discipline**: the screen's timers only hit `GET` workspace /
  controller plus the SSE stream (all `recordActivity`-free), so leaving it
  open never extends the idle timer. Message / approval sends are the only
  writes, and they come from clicks.

---

## Docker dev environment

*This section (task B) covers the Docker-based dev environment: Postgres +
migrations + agent-host DB-backed paths. The section above (task A) covers the
in-memory control-plane dev server.*

### What works locally

1. **Postgres via docker compose.** `docker compose up -d postgres` starts a
   pinned `postgres:16.9-alpine` container with a named volume
   (`dsh-postgres-data`), a `pg_isready` healthcheck, and port `5432`
   published to localhost. Credentials/dev defaults are `dsh`/`dsh`, database
   `dsh` — overridable via `POSTGRES_USER` / `POSTGRES_PASSWORD` /
   `POSTGRES_DB` / `POSTGRES_PORT` env vars (see `.env.example`).
   - `gen_random_uuid()` (used by the agent-host checkpoint persist path,
     `apps/agent-host/src/adapters.ts`) is **built into PostgreSQL 13+** as a
     core function, so the `postgres:16` image supports it with **no extra
     extension** (`pgcrypto` is not needed).
2. **Migrations.** `bun run db:migrate` (with `DATABASE_URL` set) runs the
   existing T4 migration runner (`infra/migrations/runner.ts`) and applies
   `infra/migrations/*.sql` (e.g. `0001_init.sql`, creating the five T4
   tables: `workspaces`, `sessions`, `session_events`,
   `workspace_checkpoints`, `controller_leases`). The runner records applied
   versions in `schema_migrations` and is idempotent — running it twice is a
   no-op the second time.
3. **DB-backed agent-host components against real Postgres.** The Postgres
   session repository (`packages/session-persistence-postgres` via
   `createSessionRepository`), the lease store (`BunSqlLeaseStore`), the
   transactional state store (`SqlTransactionalStateStore`), and the
   migration runner all run against the compose Postgres using plain SQL over
   `Bun.SQL` — no GCP/GitHub dependencies involved. (The task-A control-plane
   dev server above uses in-memory fakes instead; the two local paths are
   complementary.)
4. **Verification test.** `tests/integration/migrations-live.test.ts` applies
   the migrations against a live `DATABASE_URL`, asserts the five T4 tables
   plus `schema_migrations` exist, and asserts idempotency. It **skips
   cleanly** when `DATABASE_URL` is unset or unreachable, so `bun test`
   stays green without Docker.

Typical flow:

```sh
docker compose up -d postgres          # wait for healthy
export DATABASE_URL=postgres://dsh:dsh@localhost:5432/dsh
bun run db:migrate                     # applies 0001_init.sql
bun test tests/integration/migrations-live.test.ts
```

### What does NOT work locally

The agent-host is designed for Cloud Run and depends on platform-provided
primitives that do not exist on a dev machine:

- **Sandbox execution.** The `sandbox` CLI (`SANDBOX_CLI_PATH`, default
  `/usr/local/gcp/bin/sandbox`) is provided **by Cloud Run** and cannot be
  installed or faked locally. Do not fabricate a shim and present it as
  working — the harness would immediately diverge from the platform.
- **GCS checkpoints.** `FetchGcsClient` + `createGcsTokenProvider`
  (`apps/agent-host/src/adapters.ts`) resolve tokens as
  metadata server → ADC (`gcloud auth application-default login`) →
  `GCP_ACCESS_TOKEN`, so a real `CHECKPOINT_BUCKET` works wherever any one
  of those sources exists. Tokens are cached until 60s before expiry.
- **GitHub App token exchange.** The credential broker needs a real
  `GITHUB_APP_PRIVATE_KEY_PEM` for the configured `GITHUB_APP_ID`; there is
  no local stand-in.
- **Therefore: a full agent-host bootstrap is impossible locally.**

### How far `bun run apps/agent-host/src/index.ts` gets locally

`main()` → `createProductionDependencies()`:

1. **Missing env → immediate exit.** `readAgentHostConfig` requires
   `WORKSPACE_ID`, `DATABASE_URL`, `CHECKPOINT_BUCKET`,
   `CHECKPOINT_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PEM`,
   `REPOSITORY_OWNER`, `REPOSITORY_NAME`, `BASE_BRANCH`, `CONTROLLER_ID`,
   `USER_ID`, `INSTANCE_NAME`, `GCP_PROJECT_ID`, `GCP_REGION`. With an empty
   env it throws `MissingRequiredEnvError` listing the missing keys.
2. **DB connection.** With `.env.example`-style values (including placeholder
   markers for the impossible ones), the config parses; `BunSqlQueryExecutor.connect`
   and `createSessionRepository` connect to the compose Postgres
   successfully. This is the deepest DB-backed point reachable locally.
3. **Where it stops.** The composition still constructs the GCS client, the
   Cloud Run Instance client, and the sandbox runner from env values. The
   first *actual* failure depends on where those are first used: `host.recover()`
   reads the workspace from Postgres (works), then the bootstrap/checkpoint
   paths hit GCS (auth failure) and the lease/broker paths hit GitHub (auth
   failure), and any sandbox invocation fails because the sandbox CLI binary
   does not exist locally. In practice the process fails on the first
   external call after recovery — with `n/a-locally` placeholders it cannot
   even get a valid bucket/key, so it will not serve meaningful traffic.

In short: locally you can validate everything that touches Postgres
(schema, repository, leases, state machine) plus the gateway HTTP surface in
unit tests; you cannot exercise sandbox exec, GCS checkpoints, or GitHub App
auth — those require a real Cloud Run deployment.

---

## Upgrading Bun

Bun's version is pinned in **three places that must stay in sync**
(issue #83 — a floating container tag once broke production with 503s;
see `docs/stop-restore-verification-report.md` §3.1):

1. `.bun-version` at the repository root — the canonical source.
   CI installs exactly this (`bun-version-file: .bun-version` in
   `.github/workflows/ci.yml`), and local development should use it too
   (`bun upgrade` / your version manager, then `bun --version` to confirm).
2. `apps/agent-host/Dockerfile` — `ARG BUN_VERSION=<x.y.z>` default.
3. `apps/control-plane/Dockerfile` — same `ARG BUN_VERSION=<x.y.z>` default.

The Dockerfiles intentionally use an `ARG` with a default rather than a
hardcoded tag so a one-off build can override it
(`--build-arg BUN_VERSION=<x.y.z>`) without editing files, while the
default keeps plain `docker build` reproducible. `FROM` cannot read
`.bun-version` directly (the file is not available until after the first
`FROM`), so the sync is enforced by
`tests/bun-version-consistency.test.ts`, which fails `bun test` if the
`ARG` defaults drift from `.bun-version`.

Upgrade steps (example: 1.4.0 → 1.4.1):

```sh
# 1. Confirm the exact tags exist (both the full and -slim variants):
#    https://hub.docker.com/r/oven/bun/tags?name=1.4.1
#    oven/bun:1.4.1 and oven/bun:1.4.1-slim must both be present.
# 2. Bump all three places to 1.4.1.
echo '1.4.1' > .bun-version
#    then update ARG BUN_VERSION in both Dockerfiles.
# 3. Switch your local toolchain and re-verify everything:
bun upgrade  # or your version manager; confirm with: bun --version
bun install
bunx tsc --build && bun test
# 4. Rebuild both images for the Cloud Run architecture and check the
#    version actually inside the image (never trust the tag alone):
DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker
$DOCKER build --platform linux/amd64 -f apps/agent-host/Dockerfile -t agent-host:bun-check .
$DOCKER run --rm --platform linux/amd64 --entrypoint bun agent-host:bun-check --version
$DOCKER build --platform linux/amd64 -f apps/control-plane/Dockerfile -t control-plane:bun-check .
$DOCKER run --rm --platform linux/amd64 --entrypoint bun control-plane:bun-check --version
# NOTE: `--entrypoint bun` is required — without it your args are appended
# to the image ENTRYPOINT (`bun run apps/…`) and the app itself starts
# instead of `bun --version`.
```

Also consider `@types/bun` in the root `package.json`, which tracks the
runtime minor version. Never use floating tags (`oven/bun:1`,
`oven/bun:latest`) in Dockerfiles.
