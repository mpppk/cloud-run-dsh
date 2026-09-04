# Control Plane — container & production entry

The production entrypoint is `src/main.ts` (`bun run start` from this
directory). It composes the **real Postgres-backed** dependencies and serves
the HTTP surface on `0.0.0.0:$PORT`. The in-memory development server is
`src/dev.ts` (`bun run dev:control-plane` from the repo root) — do not confuse
the two.

## Required environment variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | **yes** | — | Postgres connection string for the control plane itself. Cloud SQL in production (`postgres://user:pass@host:5432/db`); locally the docker compose Postgres: `postgres://dsh:dsh@localhost:5432/dsh`. The schema must be applied first (`bun run db:migrate`). |
| `GCP_PROJECT_ID` | **yes** | — | GCP project hosting the workspace Cloud Run Instances (`projects/<id>/locations/<region>` base path). |
| `GCP_REGION` | **yes** | — | Region for every created Instance (unified with the rest of the deployment, e.g. `asia-northeast1`). |
| `AGENT_HOST_IMAGE` | **yes** | — | Agent-host container image for created Instances (v2 `containers[].image`), e.g. `${REGION}-docker.pkg.dev/${PROJECT_ID}/agent-host/agent-host:v1`. |
| `AGENT_HOST_SERVICE_ACCOUNT` | **yes** | — | Service account that created Instances run as (v2 top-level `serviceAccount`). |
| `CHECKPOINT_BUCKET` | **yes** | — | GCS checkpoint bucket (Terraform output `checkpoint_bucket_name`). Also injected into Instances. |
| `AGENT_HOST_DATABASE_URL` | **yes** | — | `DATABASE_URL` injected into created Instances. Must use the Cloud SQL **socket** form (`postgresql://dsh_app:<pw>@/dsh?host=/cloudsql/<conn>`) — Instances reach Cloud SQL through the `cloudSqlInstance` volume, never over TCP. |
| `GITHUB_APP_ID` | **yes** | — | GitHub App ID injected into created Instances. |
| `GITHUB_APP_PRIVATE_KEY_PEM` | **yes** | — | GitHub App private key PEM injected into created Instances. Prefer `--set-secrets` at deploy time so it never touches shell history. |
| `GCP_ACCESS_TOKEN` | no | metadata server | GCP OAuth2 token for the Instances API + GCS. On Cloud Run it is resolved from the metadata server automatically (the control-plane SA needs `roles/run.admin`); set explicitly only for local runs. Production-grade token handling (caching/refresh) is #27. |
| `PORT` | no | `8080` | Listen port. Cloud Run injects this; the server always listens on `0.0.0.0:$PORT` (実装手順書 section 24). |

Missing required keys fail startup with `MissingRequiredEnvError` listing
the missing keys; an invalid `PORT` fails with a clear error. No secrets are
baked into the image — everything is injected via environment at runtime.

## Build & run (local)

```sh
# from the repository root
# --platform linux/amd64 is REQUIRED for any image destined for Cloud Run
# (Cloud Run executes linux/amd64 only; a native build on Apple Silicon
# produces linux/arm64). Typechecking is not part of the image build — it
# runs in CI and via `bunx tsc --build` (see the Dockerfile build-stage note).
docker build --platform linux/amd64 -f apps/control-plane/Dockerfile -t control-plane .

# dependencies: Postgres + schema
docker compose up -d postgres        # wait for healthy
export DATABASE_URL=postgres://dsh:dsh@localhost:5432/dsh
bun run db:migrate

# run the container against the compose Postgres.
# NOTE: the production entrypoint requires all 9 env keys in the table above
# (it fails fast with MissingRequiredEnvError otherwise). For a bare
# liveness probe, dummy values for the GCP/agent-host keys suffice — but
# open/stop will then fail against the fake project. Real values come from
# Step 6 of docs/deployment-runbook.md.
docker run --rm -p 8080:8080 \
  -e DATABASE_URL="postgres://dsh:dsh@host.docker.internal:5432/dsh" \
  -e GCP_PROJECT_ID="demo" -e GCP_REGION="demo-region" \
  -e AGENT_HOST_IMAGE="demo-image" -e AGENT_HOST_SERVICE_ACCOUNT="demo-sa" \
  -e CHECKPOINT_BUCKET="demo-bucket" -e AGENT_HOST_DATABASE_URL="postgres://demo" \
  -e GITHUB_APP_ID="0" -e GITHUB_APP_PRIVATE_KEY_PEM="demo-pem" \
  control-plane

curl -s http://localhost:8080/healthz   # {"status":"ok"}
```

## Runtime registry: wired to Cloud Run Instances

This image composes the Postgres-backed session persistence (T4), controller
leases (T6), owner-based membership, and the **production `RuntimeRegistry`**
(`src/runtime-factory.ts`): workspace `open` creates-or-starts the Cloud Run
Instance (with the full agent-host environment), waits for the Instance to
report READY and the agent-host `/healthz` to turn healthy, then marks the
workspace READY. `stop` runs the graceful path and calls the Instance `:stop`
API. Manual checkpoints record a timestamped request marker in the checkpoint
bucket (`workspaces/<id>/manual-checkpoints/`).

Honest and observable behavior — never silent:

- `GET /readyz` returns **200** `ready` (no degraded capability to report;
  a failed `open`/`stop` surfaces per-request as before: state conflicts as
  **409**, unreachable infrastructure as **5xx** with no internals leaked).
- The Instance URL of an opened workspace is available two ways for the
  #22 forwarding work: `WorkspaceRuntimeHandle.getInstanceUrl()` (live
  Instances API lookup, falls back to the durable row) and the
  `workspaces.instance_url` column (written on every successful open).
- Membership in this milestone is **owner-only** (derived from
  `workspaces.owner_id`; the schema has no members table — see
  `src/membership.ts`). Adding non-owner members requires a members table.

Known follow-ups (not placeholders — tracked issues):

- Remote checkpoint trigger: the lifecycle checkpoint on `stop` is currently
  a no-op (durable checkpoints are the agent-host scheduler's job) and manual
  checkpoints write request markers the agent-host does not honor yet. #22
  adds the agent-host trigger endpoint.
- Production-grade GCP token handling (caching/refresh/ADC) is #27.

## SQL adapters

`src/prod-adapters.ts` mirrors the production SQL adapters from
`apps/agent-host/src/adapters.ts` (`BunSqlQueryExecutor`, `BunSqlLeaseStore`)
against the same Cloud SQL schema. Extracting them into a shared package is a
deliberate follow-up.
