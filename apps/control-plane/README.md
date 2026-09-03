# Control Plane — container & production entry

The production entrypoint is `src/main.ts` (`bun run start` from this
directory). It composes the **real Postgres-backed** dependencies and serves
the HTTP surface on `0.0.0.0:$PORT`. The in-memory development server is
`src/dev.ts` (`bun run dev:control-plane` from the repo root) — do not confuse
the two.

## Required environment variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | **yes** | — | Postgres connection string. Cloud SQL in production (`postgres://user:pass@host:5432/db`); locally the docker compose Postgres: `postgres://dsh:dsh@localhost:5432/dsh`. The schema must be applied first (`bun run db:migrate`). |
| `PORT` | no | `8080` | Listen port. Cloud Run injects this; the server always listens on `0.0.0.0:$PORT` (実装手順書 section 24). |

Missing `DATABASE_URL` fails startup with `MissingRequiredEnvError` listing
the missing key; an invalid `PORT` fails with a clear error. No secrets are
baked into the image — everything is injected via environment at runtime.

## Build & run (local)

```sh
# from the repository root
docker build -f apps/control-plane/Dockerfile -t control-plane .

# dependencies: Postgres + schema
docker compose up -d postgres        # wait for healthy
export DATABASE_URL=postgres://dsh:dsh@localhost:5432/dsh
bun run db:migrate

# run the container against the compose Postgres
docker run --rm -p 8080:8080 \
  -e DATABASE_URL="postgres://dsh:dsh@host.docker.internal:5432/dsh" \
  control-plane

curl -s http://localhost:8080/healthz   # {"status":"ok"}
```

## Known limitation: runtime registry is a placeholder (P11a)

This image composes the Postgres-backed session persistence (T4), controller
leases (T6) and owner-based membership. The **production `RuntimeRegistry` is
NOT wired**: the T8 `WorkspaceRuntime` composition (Cloud Run instance client,
checkpoint storage, GCS collaborators) is a follow-up task (**P11a**).

Consequences, which are honest and observable — never silent:

- Workspace **runtime operations** (`open`, `stop`, manual checkpoint, agent
  input) fail fast with `RuntimeNotWiredError` → HTTP **503** `unavailable`.
- Startup logs one **WARN** line: runtime operations are unavailable because
  the RuntimeRegistry is a placeholder.
- `GET /readyz` returns **503** `not_ready` with the reason, while
  `GET /healthz` (liveness) stays **200**. Everything not requiring the
  runtime (workspace CRUD, sessions, events, leases, SSE replay) works.
- Membership in this milestone is **owner-only** (derived from
  `workspaces.owner_id`; the schema has no members table — see
  `src/membership.ts`). Adding non-owner members requires a members table.

## SQL adapters

`src/prod-adapters.ts` mirrors the production SQL adapters from
`apps/agent-host/src/adapters.ts` (`BunSqlQueryExecutor`, `BunSqlLeaseStore`)
against the same Cloud SQL schema. Extracting them into a shared package is a
deliberate follow-up.
