# GCP Deployment Runbook — Control Plane (実装手順書 §2, §38 Stage 3)

> ## 💸 COST WARNING — READ FIRST
>
> Every step from **Step 2 onward creates billable resources** on a real Google Cloud project:
>
> | Resource | Approx. on-going cost | Stops costing when |
> |---|---|---|
> | Cloud SQL `db-custom-1-3840` (1 vCPU / 3.75 GB, private + public IPv4) | **largest line item** (~USD 40–80/month depending on region, plus storage) | instance deleted (Step 8 teardown) |
> | Cloud Run Instance (4 vCPU / 8 GiB, Pre-GA) | per-second billing while the instance is **running**; cheap only when stopped | instance stopped/deleted |
> | GCS checkpoint bucket | negligible at MVP scale | bucket deleted |
> | Artifact Registry | negligible (one image) | repository deleted |
> | VPC/none — the baseline provisions no Cloud NAT and no VPC connector. Cloud Run Instances have **no VPC connectivity at all** (`vpcAccess.networkInterfaces` is silently dropped, `vpcAccess.connector` is rejected with "not supported on resources of kind 'instance'"); they reach Cloud SQL through the native `cloudSqlInstance` volume, which dials the instance's **public IPv4** (see Step 5) | — | — |
>
> **If you stop working mid-runbook, jump to [Step 8 — Teardown](#step-8--teardown-stop-paying) and run `terraform destroy`.** Cloud SQL keeps billing even if nothing connects to it. The Cloud Run Instance keeps billing while it is `RUNNING`; `stop` it when idle (the control plane's idle manager normally does this for you, but a manually created PoC instance has no idle manager watching it).

This runbook takes an operator from an **empty Google Cloud project** to a **deployed control plane**, without provisioning anything until you choose to. It reconciles exactly with what `infra/terraform/` (T2 baseline) actually provisions — do not improvise a different sequence, especially for the Secret Manager two-phase bootstrap in Step 2.

Scope of the Terraform baseline (what you are about to create):

- 11 APIs enabled (`cloudresourcemanager`, `iam`, `run`, `sqladmin`, `secretmanager`, `artifactregistry`, `storage`, `iap`, `logging`, `monitoring`, `servicenetworking`) — `apis.tf`
- Artifact Registry Docker repository `agent-host` — `artifact_registry.tf`
- Cloud SQL PostgreSQL 16 with a private IP (own VPC + Service Networking peering) **plus a public IPv4** — Cloud Run Instances have no VPC connectivity, so the native `cloudSqlInstance` volume path dials the public address (see Step 5); `authorized_networks` stays empty (IAM + short-lived client certificate do the authorization), database `dsh`, user `dsh_app` — `cloudsql.tf`. The public IPv4 is **not** a provider default (`variables.tf` keeps `db_enable_public_ip = false` as a safety valve) — you enable it in Step 2.1 via `TF_VAR_db_enable_public_ip=true`, or by using the minimal profile (`profiles/minimal.tfvars`, Appendix), which sets `db_enable_public_ip = true`.
- GCS checkpoint bucket (uniform access, versioning, ARCHIVED-object 30-day lifecycle) — `storage.tf`
- Three service accounts (agent-host, control-plane, and the `ai-agent` operator identity) with least-privilege bindings — `iam.tf`. The `ai-agent` operator identity and its gcloud impersonation setup are documented separately in [`gcp-ai-agent-impersonation.md`](gcp-ai-agent-impersonation.md).
- Secret Manager placeholders: `github-app-private-key`, `llm-api-key`, `db-password` (no values in code) — `secrets.tf`
- IAP brand + client + `iap.httpsResourceAccessor` members — `iap.tf`

**NOT** in Terraform (deliberately — see [ADR-0001](adr/0001-instances-outside-terraform.md)):

- **Cloud Run Instances** — runtime-managed by the control plane, not Terraform ([#28](https://github.com/mpppk/cloud-run-dsh/issues/28): decided to keep them out even once a provider resource ships, so per-workspace short-lived Instances don't pollute `terraform plan` with drift). Created in Step 5 outside Terraform.
- **The control-plane Cloud Run service** — deployed in Step 6 with `gcloud`.

---

## Step 0 — Prerequisites

### Tools (versions verified in the T2 baseline)

| Tool | Minimum | Check |
|---|---|---|
| `gcloud` (Google Cloud SDK) | any recent (≥ 450 recommended for Pre-GA Instance API support) | `gcloud version` |
| `terraform` | **≥ 1.9** (`versions.tf`) | `terraform version` |
| `docker` | any recent | `docker version` (daemon must be reachable for Steps 3) |
| `bun` | ≥ 1.0 (migrations runner) | `bun --version` |
| `cloud-sql-proxy` | latest (Step 4 only) | `cloud-sql-proxy --version` |
| `psql` (PostgreSQL client) | ≥ 14 (Steps 4/7) | `psql --version` |
| `jq` | any (Step 7 response parsing) | `jq --version` |

You can run the repo's read-only preflight to check all of these at once:

```bash
bun run preflight:gcp
```

It is safe to run on an unauthenticated machine — it reports what it can and clearly marks what it *cannot* check.

### Operator IAM (who can run this runbook)

On a brand-new project you own, grant yourself during Step 1:

- `roles/owner` — simplest for an MVP project; covers Terraform resource creation, IAM, billing linkage, API enablement, and `gcloud secrets versions add`.
- Additionally, to link billing (Step 1) you need `roles/billing.user` **on the billing account** (and `roles/billing.projectManager` or Owner on the project). A plain project Owner without billing-account rights cannot link billing.

Least-privilege alternative (if your org forbids Owner): the Terraform apply in Step 2 needs, at minimum — `resourcemanager.projectIamAdmin`, `iam.serviceAccountAdmin`, `iam.serviceAccountUser`, `run.admin`, `cloudsql.admin`, `secretmanager.admin`, `storage.admin`, `artifactregistry.admin`, `serviceusage.serviceUsageAdmin`, `compute.networkAdmin` (VPC + Service Networking peering), `iap.admin`. Reproducing this exact set is error-prone; Owner on a scratch project is the pragmatic MVP choice. Do **not** run this against a shared production project.

### Cloud Run Instance access (Preview)

Cloud Run Instances and Sandboxes are **Pre-GA**. You must have Preview access enabled on the project (allowlist/feature-flag as per Google's Preview enrollment) before Step 5 works. If `gcloud` or the REST API returns 404/403 on `instances`, the Preview is not enabled for that project — this is the most common early failure.

The Instances CRUD surface exists in **Cloud Run API v2 only** (verified 2026-09-03): the v1 discovery document exposes only `getIamPolicy` / `setIamPolicy` / `testIamPermissions` under `projects.locations.instances`, and `GET https://run.googleapis.com/v1/projects/.../locations/.../instances` returns a plain HTML 404. All REST calls in this runbook therefore target `run.googleapis.com/v2/...`. `bun run preflight:gcp` probes the v2 list endpoint read-only and classifies 200 / 403 / 404 for you before you reach Step 5.

---

## Step 1 — Project and billing setup

```bash
export PROJECT_ID="dsh-<something-unique>"        # must be globally unique
export REGION="asia-northeast1"                   # keep every regional resource in ONE region
export BILLING_ACCOUNT_ID="XXXXXX-XXXXXX-XXXXXX"  # gcloud billing accounts list

gcloud projects create "$PROJECT_ID"
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"

gcloud config set project "$PROJECT_ID"
gcloud config set run/region "$REGION"
```

Region is intentionally unified (実装手順書 §2): Artifact Registry, Cloud SQL, the checkpoint bucket, and the Instances all live in `REGION`. The Terraform default region is `asia-northeast1`; override with `TF_VAR_region` if you chose another.

---

## Step 2 — Terraform: init / plan / apply (including the two-phase secret bootstrap)

All Terraform commands run from the repository root. State is **local** (`terraform.tfstate`) — do not lose it, or you cannot cleanly destroy the resources. Add a `backend "gcs" {}` before using this outside a scratch project.

### 2.1 Inputs

```bash
cd <repo root>

export TF_VAR_project_id="$PROJECT_ID"
export TF_VAR_region="$REGION"
# IAP brand requires a support email (variable has no default; omit until Step 6 if you don't want IAP yet)
export TF_VAR_iap_support_email="you@example.com"
# Members allowed through IAP (empty = nobody can reach the app through IAP)
export TF_VAR_iap_members='["user:you@example.com"]'
# Public IPv4 on Cloud SQL — REQUIRED for bring-up. Cloud Run Instances have NO
# VPC connectivity at all (no connector, no NAT: `vpcAccess.connector` is
# rejected and `vpcAccess.networkInterfaces` is silently dropped on Instances),
# so the native `cloudSqlInstance` volume dials the instance's PUBLIC address.
# With the default `db_enable_public_ip = false` the Instance cannot reach the
# DB at all (`SFEClient is nil` / `refresh failed: context deadline exceeded`,
# measured 2026-09-03). Do NOT "harden" this to false: the danger you might
# imagine from a public IP is already handled — `authorized_networks` stays
# empty because an Instance egresses from Google's shared pool (any allowlist
# wide enough to admit it is effectively 0.0.0.0/0), and authorization is IAM
# (roles/cloudsql.client) + a short-lived client certificate, never a source IP.
export TF_VAR_db_enable_public_ip=true
# The minimal verification profile (Appendix) sets the same variable for you:
#   terraform -chdir=infra/terraform plan -var-file=profiles/minimal.tfvars
# Optional labels: TF_VAR_labels='{team="dsh",env="dev"}'
```

### 2.2 Init and plan (creates nothing)

```bash
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform plan
```

`plan` fails without valid Application Default Credentials / `gcloud auth login` + `gcloud auth application-default login`. That is expected — authenticate first; do not try to work around it.

> ⚠️ **Bootstrap APIs must exist before the FIRST apply.** The google provider itself depends on `cloudresourcemanager.googleapis.com` (it resolves project numbers / IAM during plan and apply). On a brand-new project the first apply would otherwise fail *while trying to enable that same API*. Enable the two bootstrap APIs **out-of-band, before the first `terraform apply`**:
>
> ```bash
> gcloud services enable cloudresourcemanager.googleapis.com run.googleapis.com
> ```
>
> `run.googleapis.com` is in the same boat in practice: the Cloud Run Instances Preview surface used in Step 5 was verified against a project where `run.googleapis.com` had been enabled manually before any Terraform ran. Terraform (`apis.tf`) declares both APIs, but the provider's *own* bootstrap dependency on `cloudresourcemanager` cannot be satisfied by Terraform itself — hence the manual pre-step.

### 2.3 The two-phase DB-password bootstrap (do NOT skip phase 1's `-var`)

`cloudsql.tf` sets `google_sql_user.app.password` from Secret Manager via a `count`-gated data source. On the **first** apply the `db-password` secret has no versions yet, so the data source would fail. The bootstrap variable `var.db_password` (default `null`) exists for exactly this:

- `var.db_password` set → used directly, data source skipped (`count = 0`). **First apply.**
- `var.db_password` `null` → read `latest` from Secret Manager. **Steady state.**

```bash
# Phase 1 — first apply; supply the password OUT OF BAND, never commit it
export DB_PASSWORD="$(openssl rand -base64 24)"
TF_VAR_db_password="$DB_PASSWORD" terraform -chdir=infra/terraform apply

# Phase 2 — store the password in Secret Manager, then re-apply WITHOUT the var
echo -n "$DB_PASSWORD" | gcloud secrets versions add db-password --data-file=-
terraform -chdir=infra/terraform apply
```

After Phase 2 the password is sourced from Secret Manager again; leave `var.db_password` unset forever after.

### 2.4 Fill the remaining secrets

The other two secrets were created as empty placeholders by the apply:

```bash
echo -n "$GITHUB_APP_PEM" | gcloud secrets versions add github-app-private-key --data-file=-
echo -n "$LLM_KEY"        | gcloud secrets versions add llm-api-key        --data-file=-
```

`$LLM_KEY` is the **OpenRouter** API key (`sk-or-v1-…`, from https://openrouter.ai/keys).
The agent-host turn (issue #21) calls OpenRouter's OpenAI-compatible
endpoint with it; how the secret reaches the container is described in
Step 5.1 (LLM settings below). Terraform only provisions the container
(`infra/terraform/secrets.tf`) — no Terraform change is needed for #21.

### 2.5 Record the outputs

```bash
terraform -chdir=infra/terraform output
```

You need these later:

- `artifact_registry_repository_url` — image push target (Step 3)
- `sql_connection_name`, `sql_database_name` — migrations + `DATABASE_URL` (Step 4)
- `checkpoint_bucket_name` — agent-host env (Steps 5/6)
- `agent_host_service_account_email`, `control_plane_service_account_email` — instance/service deployment (Steps 5/6)
- `iap_client_id`, `iap_brand_name` — IAP (Step 6)

> ⚠️ **Deprecation / migration risk (observed as real `terraform validate` warnings):** `google_iap_brand` / `google_iap_client` emit `Warning: Deprecated Resource` — *"after July 2025, the `google_iap_brand` Terraform resource will no longer function as intended due to the deprecation of the IAP OAuth Admin API"* — plus a `Deprecated value used` warning. Validation still passes, but **creating a brand on a brand-new project via Terraform may already be broken**: if the first apply fails on the IAP brand, create the OAuth brand manually via the Cloud Console OAuth consent screen, `terraform import` it (`google_iap_brand.brand`), and keep the client under Terraform. Expect the resource addresses (and possibly import semantics) to change in a future provider major; before upgrading `hashicorp/google`, re-plan and check the provider changelog for `iap_brand`/`iap_client` removal or rename. Treat the IAP outputs (`iap_client_id`) as durable values you may need to re-attach by import.

---

## Step 3 — Build and push the agent-host image

The Dockerfile is `apps/agent-host/Dockerfile` (multi-stage: bun deps → typecheck → slim runtime with git/bash/tar/gzip, non-root `host` user, `/workspace` mutable root). It deliberately does **not** vendor the sandbox CLI — Cloud Run provides it.

```bash
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/agent-host/agent-host:v1"

gcloud auth configure-docker "${REGION}-docker.pkg.dev"

docker build -f apps/agent-host/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"
```

The image never contains secrets — configuration is injected via environment at runtime (Step 5/6).

---

## Step 4 — Apply migrations to Cloud SQL

Cloud SQL carries a private IP (own VPC + Service Networking peering), but `authorized_networks` is deliberately left **empty**: a Cloud Run Instance egresses from Google's shared address pool, so any allowlist wide enough to admit it is effectively 0.0.0.0/0. Authorization is IAM (`roles/cloudsql.client`) plus an ephemeral client certificate, never a source IP — a plain TCP connect from an unlisted host does not open. Use the Cloud SQL Auth Proxy from your workstation (it dials the instance's **public IPv4**, so the instance must have been created with `db_enable_public_ip = true`; without it the proxy fails with `SFEClient is nil` / `refresh failed: context deadline exceeded`):

```bash
# Install: https://cloud.google.com/sql/docs/mysql/sql-proxy (curl the binary or brew install cloud-sql-proxy)
export SQL_CONNECTION_NAME="$(terraform -chdir=infra/terraform output -raw sql_connection_name)"
cloud-sql-proxy "$SQL_CONNECTION_NAME" --port 5433 &

export DB_PASSWORD="$(gcloud secrets versions access latest --secret=db-password)"
export DATABASE_URL="postgresql://dsh_app:${DB_PASSWORD}@127.0.0.1:5433/dsh"

bun run infra/migrations/runner.ts
kill %1   # stop the proxy
```

The runner (`infra/migrations/runner.ts`) is idempotent — it creates `schema_migrations` and applies pending `*.sql` (ignoring `*.down.sql`) in lexicographic order, each in a transaction. Re-running it is a no-op once everything is applied. Expected output for a fresh database: `0001_init` applied.

Alternative for private-network environments: run the same command from a VM inside the project's VPC, with `DATABASE_URL` pointing at the instance's private IP.

---

## Step 5 — Create the Cloud Run Instance **outside Terraform** (Pre-GA ⚠️)

> **This is the most fragile step in the runbook.** Cloud Run Instances are deliberately kept outside Terraform ([ADR-0001](adr/0001-instances-outside-terraform.md) — do **not** fake them with `google_cloud_run_v2_service`, the Instance API is a different surface, and do not reintroduce a `run_instances.tf` even if a provider resource ships). The create/start/stop/delete REST paths and gcloud flags below are **Preview surface and can change without notice** (paths verified against v2 on 2026-09-03; re-verify before every deploy). Per 仕様書 §29: **check the Cloud Run Instances Known Issues page and release notes before EVERY deploy** — a Preview API breaking change can invalidate this step (and the runtime adapter in `packages/cloud-run-instance-client`).
>
> References to monitor before each deploy:
> - REST reference (**v2** — the Instances CRUD surface exists in v2 only; the v1 discovery exposes IAM methods only): `https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.instances`
> - Known Issues / release notes for Cloud Run Instances (Preview)
> - `https://github.com/hashicorp/terraform-provider-google/issues` — to track the Instances API surface, not to Terraform-ize it (per ADR-0001 Instances stay runtime-managed).

Baseline configuration (仕様書 §22 / 実装手順書 §6): `cpu: 4`, `memory: 8Gi`, `restartPolicy: ON_FAILURE`, `sandboxLauncher: true`, port `8080`, run as the agent-host service account.

> 🚨 **NEVER set `restartPolicy: always`.** 仕様書 §23 mandates `on-failure` and explicitly rejects `always` because of a known Preview issue with `always`. `packages/cloud-run-instance-client` throws a typed `InvalidRestartPolicyError` (`restartPolicy "always" is not allowed — known Preview issue (spec section 23); use "on-failure" or "never"`) if it ever receives `always`. This applies to every place an instance is created OR updated below.

> **Note:** in normal operation the **control plane** creates instances through its `InstanceRuntime` adapter (`packages/cloud-run-instance-client` → REST). This manual step exists to (a) validate the Preview API + image + service account wiring before the control plane depends on them, and (b) give you the exact call to fall back to when debugging. A manually created instance has no idle manager watching it — stop it when done (see below) or it keeps billing.

### 5.1 Agent-host environment — all 13 required keys

`apps/agent-host/src/config.ts` defines `REQUIRED_ENV_KEYS`; if ANY of the following is missing or blank, the container crashes at startup with `MissingRequiredEnvError` (the composition root refuses to boot). The list below mirrors `config.ts:12-26` — **if you add an env key to `config.ts`, update this table in the same PR** so this runbook cannot silently drift.

| # | Key | Where the value comes from |
|---|---|---|
| 1 | `WORKSPACE_ID` | The workspace the instance serves (the control plane passes the workspace UUID created in Step 7). |
| 2 | `CHECKPOINT_BUCKET` | Terraform output `checkpoint_bucket_name`. |
| 3 | `DATABASE_URL` | `postgresql://dsh_app:<db-password>@/dsh?host=/cloudsql/<sql_connection_name>` — the Instance reaches Cloud SQL through its `cloudSqlInstance` volume mounted at `/cloudsql` (no Auth Proxy sidecar, no VPC connector; only the runtime SA needs `roles/cloudsql.client`, and the instance must have a public IPv4 — see Step 5.2). Password from Secret Manager `db-password` (Step 4). |
| 4 | `GITHUB_APP_ID` | Your GitHub App settings page. |
| 5 | `GITHUB_APP_PRIVATE_KEY_PEM` | The GitHub App private key PEM (multi-line — keep the file-based env mechanism below). |
| 6 | `REPOSITORY_OWNER` | Same repo owner you created the workspace with (Step 7). |
| 7 | `REPOSITORY_NAME` | Same repo name you created the workspace with (Step 7). |
| 8 | `BASE_BRANCH` | Workspace base branch (default `main`). |
| 9 | `CONTROLLER_ID` | The controller identity holding the lease for this workspace (from the control plane's controller-lease service). |
| 10 | `USER_ID` | The internal user ID that owns the workspace (returned in the workspace DTO `ownerId`). |
| 11 | `INSTANCE_NAME` | The instance name you are creating (`dsh-ws-demo` here). |
| 12 | `GCP_PROJECT_ID` | `$PROJECT_ID`. |
| 13 | `GCP_REGION` | `$REGION`. |

Optional (not required, have defaults in `config.ts`): `PORT` (8080), `WORKSPACE_ROOT` (`/workspace`), `CHECKPOINT_KEY`, `SANDBOX_CLI_PATH`, `SANDBOX_ALLOW_EGRESS`, plus the LLM settings below.

#### 5.1.1 Agent-host LLM settings (issue #21)

| Key | Default | Meaning |
|---|---|---|
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible chat-completions endpoint base (`/chat/completions` is appended by the adapter). |
| `LLM_API_KEY_ENV` | `OPENROUTER_API_KEY` | **Name** of the env var holding the key — the value itself never appears in config (same rule as the adapter's `apiKeyEnv`: a literal key is not a configuration value). The adapter resolves it per request from the process environment. |
| `LLM_MODEL` | `deepseek/deepseek-v4-flash` | Wire model id. Verified against the public OpenRouter catalog: advertises `tools`, 1M context, cheapest DeepSeek-family tool-calling model; DeepSeek-native minimizes the risk of OpenRouter rejecting DeepSeek-specific request fields. Override per deployment. |
| `LLM_APPROVAL_POLICY` | `ask` | Default approval policy for sessions without an override (`ask` pends tool-escalation asks for an HTTP `/approvals` decision; `never` auto-rejects — the headless/CI stance). |

Injection: at instance-create time, resolve the secret into the container env
inside the same 0600 temp-file body as `DATABASE_URL` (secret hygiene as above —
never argv/history):

```bash
export LLM_KEY_FROM_SM="$(gcloud secrets versions access latest --secret=llm-api-key)"
# ... inside the "env" array of $BODY:
      { "name": "OPENROUTER_API_KEY", "value": "${LLM_KEY_FROM_SM}" }
```

(A `MissingRequiredEnvError` crash mentions only the 13 required keys; a
missing `OPENROUTER_API_KEY` does NOT crash boot — the key is resolved per
LLM request, so turns fail with `MISSING_CREDENTIAL` while health checks
stay green. Check the turn logs, not the boot logs, for key problems.)

### 5.2 Via REST (canonical while Pre-GA)

> **Secret hygiene:** the request body carries `DATABASE_URL` (DB password) and the GitHub App PEM. Build it in a **temp file with `0600` permissions** and pass it via `--data @file` — never inline `-d '...'"` with expanded secrets, which leaks them into shell history and `ps` output.

```bash
export SA_EMAIL="$(terraform -chdir=infra/terraform output -raw agent_host_service_account_email)"
export BUCKET="$(terraform -chdir=infra/terraform output -raw checkpoint_bucket_name)"
export SQL_CONNECTION="$(terraform -chdir=infra/terraform output -raw sql_connection_name)"
export DB_PASSWORD="$(gcloud secrets versions access latest --secret=db-password)"

# Build the request body in a 0600 temp file (secrets never touch shell history or ps)
umask 077
BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT
cat > "$BODY" <<EOF
{
  "containers": [{
    "image": "${IMAGE}",
    "resources": { "limits": { "cpu": "4", "memory": "8Gi" } },
    "ports": [{ "containerPort": 8080 }],
    "sandboxLauncher": true,
    "volumeMounts": [{ "name": "cloudsql", "mountPath": "/cloudsql" }],
    "env": [
      { "name": "WORKSPACE_ID",  "value": "<workspace-id, e.g. the UUID from Step 7>" },
      { "name": "CHECKPOINT_BUCKET", "value": "${BUCKET}" },
      { "name": "DATABASE_URL",  "value": "postgresql://dsh_app:${DB_PASSWORD}@/dsh?host=/cloudsql/${SQL_CONNECTION}" },
      { "name": "GITHUB_APP_ID", "value": "<github-app-id>" },
      { "name": "GITHUB_APP_PRIVATE_KEY_PEM", "value": "<pem, with \n escapes>" },
      { "name": "REPOSITORY_OWNER", "value": "<repo-owner>" },
      { "name": "REPOSITORY_NAME", "value": "<repo-name>" },
      { "name": "BASE_BRANCH", "value": "main" },
      { "name": "CONTROLLER_ID", "value": "<controller-id>" },
      { "name": "USER_ID", "value": "<internal-user-id>" },
      { "name": "INSTANCE_NAME", "value": "dsh-ws-demo" },
      { "name": "GCP_PROJECT_ID", "value": "${PROJECT_ID}" },
      { "name": "GCP_REGION", "value": "${REGION}" }
    ]
  }],
  "volumes": [{ "name": "cloudsql", "cloudSqlInstance": "${SQL_CONNECTION}" }],
  "serviceAccount": "${SA_EMAIL}",
  "restartPolicy": "ON_FAILURE"
}
EOF

# (0) FREE DRY-RUN FIRST — validate the request without creating anything.
#     v2 create accepts `validateOnly=true`: the request is validated and
#     default values are filled in, but nothing is persisted and no resource
#     is created (no billing). Expect HTTP 200 and an empty operation body.
curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/instances?instanceId=dsh-ws-demo&validateOnly=true" \
  --data @"$BODY"

# (1) Real create (BILLABLE — the instance bills while RUNNING).
curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/instances?instanceId=dsh-ws-demo" \
  --data @"$BODY"
```

> 🚨 **`restartPolicy` must stay `"ON_FAILURE"`** — never `ALWAYS` (see the warning above / 仕様書 §23).

Exact field names for sandbox launcher, instance-level settings, and the `DATABASE_URL` socket scheme are Preview surface — **verify against the current v2 REST reference before running**, and prefer the SDK's typed client (`packages/cloud-run-instance-client`) as the source of truth for the shape the control plane actually sends. Connectivity facts measured against this project on 2026-09-03: the `cloudSqlInstance` volume is the **only** working path to Cloud SQL from an Instance (no VPC connector possible, no proxy sidecar needed), it dials the instance's public address so `ipv4_enabled` must be true, and the runtime SA needs only `roles/cloudsql.client`.

The v2 `GoogleCloudRunV2Instance` shape (verified against the live discovery document on 2026-09-03) differs from the Services/Revisions shape this runbook previously showed:

| v2 field (Instances) | Notes |
|---|---|
| `containers[]` | top-level — there is **no `template` wrapper** on Instances (that is the Services shape) |
| `containers[].image` | **Required** |
| `containers[].resources.limits.cpu` / `.memory` | limit **strings** (`"4"`, `"8Gi"`) — no top-level numeric `resources.cpu` |
| `containers[].sandboxLauncher` | lives **on the container**, not the instance |
| `containers[].ports[].containerPort` | array of port objects |
| `restartPolicy` | top-level; API enum `ON_FAILURE` / `NEVER` / `ALWAYS` (never `ALWAYS`, see §23) |
| `serviceAccount` | top-level instance field |
| instance id | passed as the `?instanceId=` **query parameter**; the body `name` field is ignored in create |
| readOnly fields | `name` (output), `createTime`, `uid`, `urls`, `terminalCondition`, etc. — never send these; the API rejects readOnly payloads |

### 5.3 Via gcloud (if your SDK version ships the Preview command group)

Do **not** pass `DATABASE_URL` or `GITHUB_APP_PRIVATE_KEY_PEM` inline via `--set-env-vars=` — those would land in shell history. Prefer the file-based form (`--set-env-vars-from-file=env.yaml`, if the Preview command group supports it) or REST 5.2, with the env file created under `umask 077` and deleted after.

```bash
gcloud run instances create dsh-ws-demo \
  --location="$REGION" \
  --image="$IMAGE" \
  --cpu=4 --memory=8Gi \
  --port=8080 \
  --restart-policy=on-failure \
  --sandbox-launcher \
  --service-account="$SA_EMAIL" \
  --set-env-vars-from-file=./agent-host.env   # YAML env map, all 13 keys from §5.1, file perms 0600
```

> 🚨 **`--restart-policy` must stay `on-failure`** — never `always` (see the warning above / 仕様書 §23).

If `gcloud run instances` is rejected ("Invalid choice"), your SDK predates the Preview command — use the REST call in 5.2.

### 5.4 Verify and stop

```bash
gcloud auth print-access-token | xargs -I{} curl -s \
  -H "Authorization: Bearer {}" \
  "https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/instances/dsh-ws-demo"

# When done with a manual instance — it bills while RUNNING:
gcloud run instances stop dsh-ws-demo --location="$REGION" 2>/dev/null || \
curl -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/instances/dsh-ws-demo:stop"
```

---

## Step 6 — Deploy the control plane to Cloud Run

The control plane (`apps/control-plane`) is **not** provisioned by the T2 Terraform baseline. Deploy it with `gcloud` (wrap it in Terraform later when a stable `google_cloud_run_v2_service` wiring is agreed for this repo):

```bash
export CP_SA_EMAIL="$(terraform -chdir=infra/terraform output -raw control_plane_service_account_email)"
export CP_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/agent-host/control-plane:v1"

# (build the control-plane image analogously to Step 3:)
#   docker build --platform linux/amd64 -f apps/control-plane/Dockerfile -t "$CP_IMAGE" .
#  (--platform linux/amd64 is REQUIRED: Cloud Run executes linux/amd64 only,
#   and a native build on Apple Silicon yields linux/arm64. The image build
#   does NOT run the typecheck — `bun run typecheck` aborts under qemu on a
#   cross-architecture host — type safety is enforced by CI and
#   `bunx tsc --build` instead.)
#  (the production entrypoint is apps/control-plane/src/main.ts; it requires
#   the 9 env keys in the table below, respects PORT, and serves /healthz +
#   /readyz — see apps/control-plane/README.md. The RuntimeRegistry is wired:
#   POST /v1/workspaces/:id/open creates-or-starts the workspace Instance.)
#
# Control-plane environment — mirrors apps/control-plane/src/config.ts.
# If you add an env key to config.ts, update this table in the same PR.
# Secret hygiene: the DB password and the PEM never appear in argv or shell
# history — secrets travel via Secret Manager (--set-secrets) and stdin
# redirection (herestrings use temp files, not argv). The control-plane SA
# already holds accessor grants for db-password / github-app-private-key
# (iam.tf) and run.admin + act-as agent-host (Steps 5/7 need them).
export SA_EMAIL="$(terraform -chdir=infra/terraform output -raw agent_host_service_account_email)"
export BUCKET="$(terraform -chdir=infra/terraform output -raw checkpoint_bucket_name)"
export SQL_CONNECTION="$(terraform -chdir=infra/terraform output -raw sql_connection_name)"
export DB_PASSWORD="$(gcloud secrets versions access latest --secret=db-password)"
# Your GitHub App ID (numeric, from the App settings page — not a secret).
export GH_APP_ID="<github-app-id>"

# The control plane needs its own full DATABASE_URL (TCP form — Cloud Run
# services reach Cloud SQL over TCP, unlike Instances which use the socket).
# Store it as a dedicated secret version so the password never lands in argv
# or the service config (herestring, not argv):
umask 077
gcloud secrets create control-plane-database-url --replication-policy=automatic 2>/dev/null || true
gcloud sql instances describe "$(echo "$SQL_CONNECTION" | cut -d: -f3)" \
  --format='get(ipAddresses[0].ipAddress)' | {
  read -r SQL_IP
  gcloud secrets versions add control-plane-database-url --data-file=- \
    <<<"postgresql://dsh_app:${DB_PASSWORD}@${SQL_IP}:5432/dsh"
}

# Plain env vars travel via a 0600 YAML file (--env-vars-file), NOT inline
# --set-env-vars: AGENT_HOST_DATABASE_URL embeds the DB password, and inline
# values land in shell history and `ps` output (same rule as Step 5.2).
umask 077
CP_ENV="$(mktemp)"; trap 'rm -f "$CP_ENV"' EXIT
cat > "$CP_ENV" <<EOF
GCP_PROJECT_ID: "${PROJECT_ID}"
GCP_REGION: "${REGION}"
AGENT_HOST_IMAGE: "${IMAGE}"
AGENT_HOST_SERVICE_ACCOUNT: "${SA_EMAIL}"
CHECKPOINT_BUCKET: "${BUCKET}"
AGENT_HOST_DATABASE_URL: "postgresql://dsh_app:${DB_PASSWORD}@/dsh?host=/cloudsql/${SQL_CONNECTION}"
GITHUB_APP_ID: "${GH_APP_ID}"
EOF

gcloud run deploy control-plane \
  --project="$PROJECT_ID" --region="$REGION" \
  --image="$CP_IMAGE" \
  --service-account="$CP_SA_EMAIL" \
  --ingress=internal-and-cloud-load-balancing \
  --no-allow-unauthenticated \
  --env-vars-file="$CP_ENV" \
  --set-secrets="DATABASE_URL=control-plane-database-url:latest,GITHUB_APP_PRIVATE_KEY_PEM=github-app-private-key:latest"
```

Created Instances receive their environment (including `DATABASE_URL` with the
DB password) as plain `value` pairs — the same posture as the manual create in
Step 5.2. Switching to secret references (`valueSource`) once the v2
Instances API shape for secrets is verified is follow-up work (the typed
client in `packages/cloud-run-instance-client` only sends plain values
today).

IAP configuration (brand + client were already created by Terraform in Step 2; members via `var.iap_members`):

1. `iap_client_id` / `iap_brand_name` from `terraform output` identify the OAuth brand/client.
2. Front the service with IAP — either an HTTPS Load Balancer backend (classic, stable) or the newer direct IAP-on-Cloud Run integration, whichever your project's Preview surface supports.
3. Grant `roles/iap.httpsResourceAccessor` to your users (Terraform does this for `var.iap_members`; add more with `gcloud iap web add-iam-policy-binding`).
4. The control plane **never trusts the IAP identity alone** — it resolves IAP identity → internal user → workspace membership → authorization (仕様書 §21, 実装手順書 §25). IAP being on does not make membership checks optional.

---

## Step 7 — Smoke check

From a browser/session that goes through IAP:

```bash
export DB_PASSWORD="$(gcloud secrets versions access latest --secret=db-password)"  # as in Step 4

# 1. Control plane is alive (through the IAP-secured endpoint / LB URL).
#    /healthz is served before the auth pipeline — no IAP headers needed here.
curl -s "https://<control-plane-host>/healthz"
# → expect a 200 with the health payload

# IAP injects BOTH headers below in front of Cloud Run; the API returns 401
# "missing IAP identity headers" unless BOTH are present
# (parseIapHeaders in apps/control-plane/src/auth.ts requires user-id AND
# user-email). Set them once:
IAP_ID='x-goog-authenticated-user-id: accounts.google.com:<sub>'
IAP_EMAIL='x-goog-authenticated-user-email: <email@example.com>'

# 2. Create a workspace (both IAP headers must be present).
#    NOTE: the server GENERATES the workspace id (crypto.randomUUID() in
#    handlers.ts createWorkspace) and requires repositoryOwner/repositoryName;
#    you do NOT send an id. baseBranch is optional and defaults to "main".
CREATE_RESPONSE="$(curl -s -X POST "https://<control-plane-host>/v1/workspaces" \
  -H "Content-Type: application/json" \
  -H "$IAP_ID" \
  -H "$IAP_EMAIL" \
  -d '{"repositoryOwner":"<repo-owner>","repositoryName":"<repo-name>","baseBranch":"main"}')"
echo "$CREATE_RESPONSE"
# → 201 with the workspace DTO { id, ownerId, repositoryOwner, repositoryName, baseBranch, runtimeState, ... }

# Capture the server-generated workspace id from the 201 response
# (jq is a Step 0 prerequisite; without jq, paste the id manually into WS_ID):
WORKSPACE_ID="$(echo "$CREATE_RESPONSE" | jq -r '.id')"

# 3. Open it — this is what triggers instance creation via the adapter:
curl -s -X POST "https://<control-plane-host>/v1/workspaces/${WORKSPACE_ID}/open" \
  -H "$IAP_ID" \
  -H "$IAP_EMAIL"

# 4. Instance came up in Cloud Run:
gcloud run instances list --location="$REGION"   # if the Preview command exists
# …or GET .../instances/<instance-id> per Step 5.4

# 5. DB has the workspace row (via cloud-sql-proxy as in Step 4).
#    The DB password never appears on the command line (it would leak via `ps`
#    and shell history): put it in a 0600 pgpass file and point PGPASSFILE at it.
umask 077
PGPASSF="$(mktemp)"; trap 'rm -f "$PGPASSF"' EXIT
printf '127.0.0.1:5433:dsh:dsh_app:%s\n' "$DB_PASSWORD" > "$PGPASSF"

PGPASSFILE="$PGPASSF" psql "postgresql://dsh_app@127.0.0.1:5433/dsh" \
  -v ws="$WORKSPACE_ID" \
  -c "SELECT id, runtime_state FROM workspaces WHERE id = :'ws';"

# 6. Checkpoint bucket exists and is reachable by the agent-host SA:
gcloud storage ls "gs://$(terraform -chdir=infra/terraform output -raw checkpoint_bucket_name)"
```

Pass criteria: `/healthz` 200; workspace created (201, server-generated UUID `id`) + opened; an Instance exists for the workspace; the `workspaces` row shows the expected state; no 403 from IAP.

---

## Step 8 — Teardown (stop paying)

Order matters: remove Instance-attached things first, empty the bucket, then Terraform.

```bash
# 1. Stop & delete every Cloud Run Instance you (or the control plane) created.
#    They are NOT in Terraform state — destroy will not remove them.
gcloud run instances list --location="$REGION"    # enumerate (or via REST GET)
gcloud run instances stop   dsh-ws-demo --location="$REGION" 2>/dev/null || true
gcloud run instances delete dsh-ws-demo --location="$REGION" 2>/dev/null || true

# 2. Delete the control-plane service:
gcloud run services delete control-plane --region="$REGION" --quiet

# 3. EMPTY the versioned checkpoint bucket — `terraform destroy` CANNOT delete
#    a non-empty versioned GCS bucket (lifecycle rules only age out ARCHIVED
#    versions), so a destroy without this step FAILS and you keep paying.
#    ⚠️ THIS PERMANENTLY DELETES ALL CHECKPOINTS (live objects + every version).
#    Export first if you want the data (see the note below the block).
gcloud storage rm --all-versions -r \
  "gs://$(terraform -chdir=infra/terraform output -raw checkpoint_bucket_name)"

# 4. Destroy Terraform-managed resources (SQL, bucket, AR, IAM, secrets, IAP):
terraform -chdir=infra/terraform destroy
# If the db-password data source fails on destroy (secret version deleted manually), re-run
# with TF_VAR_db_password set — same escape hatch as the first apply.

# 5. Remove the abandoned Service Networking peering (see note below).
#    The VPC name follows cloudsql.tf: "${var.environment}-dsh-sql-vpc" (default env: dev).
gcloud services vpc-peerings delete \
  --service=servicenetworking.googleapis.com \
  --network="${TF_VAR_environment:-dev}-dsh-sql-vpc" \
  --project="$PROJECT_ID" --quiet

# 6. Local state cleanup:
rm -f infra/terraform/terraform.tfstate infra/terraform/terraform.tfstate.backup

# 7. Optional — stop the meter completely (scratch project only):
gcloud projects delete "$PROJECT_ID"
#    or unlink billing:
gcloud billing projects unlink "$PROJECT_ID"
```

Teardown gotchas (all verified against `infra/terraform`):

- **Versioned bucket**: `google_storage_bucket.checkpoints` has versioning enabled; `terraform destroy` fails on a non-empty versioned bucket. That is why step 3 empties it first with `gcloud storage rm --all-versions -r` — the only way the destroy succeeds. Checkpoints and sessions are unrecoverable after it; export the bucket (`gcloud storage cp -r ...`) before step 3 if you want the data instead of the savings.
- **Service Networking peering is ABANDONED, not destroyed**: `cloudsql.tf` sets `deletion_policy = "ABANDON"` on `google_service_networking_connection.private_vpc_connection`, so `terraform destroy` intentionally leaves the VPC peering (and the peered Private Service Access range) in place — deleting it would break any other SQL instance sharing the peering. Remove it manually with step 5 above (`gcloud services vpc-peerings delete`), which deletes the peering; the reserved global address itself is Terraform-managed and is destroyed normally. (Note: after `terraform destroy` the VPC network is also gone; if destroy already removed it, the peering went with it — verify with `gcloud compute networks peerings list --network=...` and skip step 5 if nothing is listed.)
- **Cloud SQL instance**: `google_sql_database_instance.main` has no ABANDON override, so destroy DOES delete it — the largest cost line disappears at step 4.
- **Secret Manager secrets** are destroyed with their versions — you will need to re-add them if you redeploy.
- **Cloud Run Instances**: never in Terraform state; step 1 is the only thing that stops their billing.

---

## What cannot be verified without a real project

This runbook was authored against a machine with **no gcloud credentials and no configured project**; nothing here was executed against real GCP. Unexecuted and therefore unproven:

| Step | Unproven because |
|---|---|
| Step 1 | Project creation, billing linkage — no billing account available in this environment. |
| Step 2 (`plan`/`apply`) | `terraform plan`/`apply` require provider credentials; only `fmt -check`, `init -backend=false`, `validate` were run (see PR verification). The two-phase secret bootstrap sequence is code-reviewed and reconciled with `infra/terraform/README.md`, but never executed end-to-end. |
| Step 2 (IAP resources) | `google_iap_brand` creation behavior + deprecation warnings observed only in docs; actual warning text/resource behavior unverified. |
| Step 3 | `docker build` of the agent-host image was not run here; the Dockerfile's `bun run typecheck` stage depends on the workspace installing cleanly in-container. |
| Step 4 | Migration runner against real Cloud SQL (proxy, private-IP path, `DATABASE_URL` with the Cloud SQL connection name) — untested against a live instance; the runner itself is covered by unit tests. |
| Step 5 | **Highest risk.** The create body shape, `validateOnly` dry-run, and the v2 REST paths were verified against the live discovery document and read-only probes on 2026-09-03 (see PR verification: v1 paths return HTML 404, v2 list returns 200). Still unproven: an actual create/start/stop against a live instance (billable), and the `gcloud run instances` Preview command-group availability. |
| Step 6 | `gcloud run deploy` + IAP frontend wiring — unexecuted (needs a real project). The image itself now builds (see the control-plane Dockerfile) and was verified locally: `docker build` + container start + `/healthz` curl (see the P3 PR verification). The RuntimeRegistry is wired (#23): `open` creates-or-starts the workspace Instance, so Step 7.3 exercises it for real. |
| Step 7 | Smoke checks — depend on Steps 4–6. |
| Step 8 | `terraform destroy` behavior with real state; Instance stop/delete endpoint names under the Preview API. |

The preflight script (`bun run preflight:gcp`) is likewise only proven in its "unauthenticated / cannot-check" code paths plus the local tool + Terraform validation paths.

---

## Appendix — Minimal cost profile (verification-only) & guaranteed teardown

> **🚨 DESTROY FAILURE = BILLING CONTINUES.** If `terraform destroy` fails — most commonly because the versioned checkpoint bucket still contains objects — Cloud SQL and the bucket KEEP BILLING until you fix it. Empty the bucket first (step 3 below, or the guarded script), then re-run destroy, and verify every resource is gone in the Cloud Console billing report.

For the billing-approval gate (P6) you normally want the **minimal verification profile**, not the production-ish defaults:

```bash
terraform -chdir=infra/terraform plan  -var-file=profiles/minimal.tfvars
terraform -chdir=infra/terraform apply -var-file=profiles/minimal.tfvars
```

What it changes (defaults are untouched — see [`cost.md`](cost.md) for sourced monthly estimates, ≈ $11–12/month at `db-f1-micro`, vs ≈ $67/month at `db-custom-1-3840`, both asia-northeast1):

- `db-f1-micro` (shared-core, SLA-excluded, bring-up verification only; official tier availability: https://cloud.google.com/sql/docs/postgres/machine-series-overview)
- `db_enable_public_ip = true` — required, not optional: the Instance reaches Cloud SQL only through the public address (see Step 2.1 for the why); `authorized_networks` stays empty (IAM + short-lived client certificate authorize, never source IP)
- backups / PITR / Query Insights **disabled**, HDD storage — acceptable only because verification data is disposable
- teardown billing notes and the ABANDONed Service Networking peering impact on a future re-apply: [`cost.md` — Teardown](cost.md)

For teardown, runbook Step 8 step 3 (empty the versioned bucket) can be executed with the guarded helper script — it refuses to run without `--yes` because it permanently deletes every checkpoint version:

```bash
bun run teardown:empty-bucket -- --bucket "$(terraform -chdir=infra/terraform output -raw checkpoint_bucket_name)" --yes
# then: terraform -chdir=infra/terraform destroy
```
