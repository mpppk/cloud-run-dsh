# GCP Deployment Runbook — Control Plane (実装手順書 §2, §38 Stage 3)

> ## 💸 COST WARNING — READ FIRST
>
> Every step from **Step 2 onward creates billable resources** on a real Google Cloud project:
>
> | Resource | Approx. on-going cost | Stops costing when |
> |---|---|---|
> | Cloud SQL `db-custom-1-3840` (1 vCPU / 3.75 GB, private IP) | **largest line item** (~USD 40–80/month depending on region, plus storage) | instance deleted (Step 8 teardown) |
> | Cloud Run Instance (4 vCPU / 8 GiB, Pre-GA) | per-second billing while the instance is **running**; cheap only when stopped | instance stopped/deleted |
> | GCS checkpoint bucket | negligible at MVP scale | bucket deleted |
> | Artifact Registry | negligible (one image) | repository deleted |
> | NAT/none — Cloud SQL is private-IP only; no Cloud NAT is provisioned by the baseline | — | — |
>
> **If you stop working mid-runbook, jump to [Step 8 — Teardown](#step-8--teardown-stop-paying) and run `terraform destroy`.** Cloud SQL keeps billing even if nothing connects to it. The Cloud Run Instance keeps billing while it is `RUNNING`; `stop` it when idle (the control plane's idle manager normally does this for you, but a manually created PoC instance has no idle manager watching it).

This runbook takes an operator from an **empty Google Cloud project** to a **deployed control plane**, without provisioning anything until you choose to. It reconciles exactly with what `infra/terraform/` (T2 baseline) actually provisions — do not improvise a different sequence, especially for the Secret Manager two-phase bootstrap in Step 2.

Scope of the Terraform baseline (what you are about to create):

- 9 APIs enabled (`run`, `sqladmin`, `secretmanager`, `artifactregistry`, `storage`, `iap`, `logging`, `monitoring`, `servicenetworking`) — `apis.tf`
- Artifact Registry Docker repository `agent-host` — `artifact_registry.tf`
- Cloud SQL PostgreSQL 16, **private IP only** (own VPC + Service Networking peering), database `dsh`, user `dsh_app` — `cloudsql.tf`
- GCS checkpoint bucket (uniform access, versioning, ARCHIVED-object 30-day lifecycle) — `storage.tf`
- Two service accounts (agent-host, control-plane) with least-privilege bindings — `iam.tf`
- Secret Manager placeholders: `github-app-private-key`, `llm-api-key`, `db-password` (no values in code) — `secrets.tf`
- IAP brand + client + `iap.httpsResourceAccessor` members — `iap.tf`

**NOT** in Terraform (documented in `run_instances.tf.example` and `README.md`):

- **Cloud Run Instances** — Pre-GA, no Terraform resource exists. Created in Step 5 outside Terraform.
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
# Optional labels: TF_VAR_labels='{team="dsh",env="dev"}'
```

### 2.2 Init and plan (creates nothing)

```bash
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform plan
```

`plan` fails without valid Application Default Credentials / `gcloud auth login` + `gcloud auth application-default login`. That is expected — authenticate first; do not try to work around it.

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

Cloud SQL is **private IP only** (`ipv4_enabled = false`), so your workstation cannot reach it directly. Use the Cloud SQL Auth Proxy from your workstation:

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

> **This is the most fragile step in the runbook.** Cloud Run Instances have no Terraform resource (`run_instances.tf.example` is the standing TODO — do **not** fake it with `google_cloud_run_v2_service`, the Instance API is a different surface). The create/start/stop/delete REST paths and gcloud flags below are **Preview surface and can change without notice**. Per 仕様書 §29: **check the Cloud Run Instances Known Issues page and release notes before EVERY deploy** — a Preview API breaking change can invalidate this step (and the runtime adapter in `packages/cloud-run-instance-client`).
>
> References to monitor before each deploy:
> - REST reference: `https://cloud.google.com/run/docs/reference/rest/v1/projects.locations.instances`
> - Known Issues / release notes for Cloud Run Instances (Preview)
> - `https://github.com/hashicorp/terraform-provider-google/issues` — for when a `google_cloud_run_instance` resource ships; once it does, promote `run_instances.tf.example` → `run_instances.tf` and delete this manual step.

Baseline configuration (仕様書 §22 / 実装手順書 §6): `cpu: 4`, `memory: 8Gi`, `restartPolicy: ON_FAILURE`, `sandboxLauncher: true`, port `8080`, run as the agent-host service account.

> **Note:** in normal operation the **control plane** creates instances through its `InstanceRuntime` adapter (`packages/cloud-run-instance-client` → REST). This manual step exists to (a) validate the Preview API + image + service account wiring before the control plane depends on them, and (b) give you the exact call to fall back to when debugging. A manually created instance has no idle manager watching it — stop it when done (see below) or it keeps billing.

### 5.1 Via REST (canonical while Pre-GA)

```bash
export SA_EMAIL="$(terraform -chdir=infra/terraform output -raw agent_host_service_account_email)"
export BUCKET="$(terraform -chdir=infra/terraform output -raw checkpoint_bucket_name)"
export SQL_CONNECTION="$(terraform -chdir=infra/terraform output -raw sql_connection_name)"
export DB_PASSWORD="$(gcloud secrets versions access latest --secret=db-password)"

curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://run.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/instances?instanceId=dsh-ws-demo" \
  -d '{
    "template": {
      "containers": [{
        "image": "'"${IMAGE}"'",
        "resources": { "cpu": 4, "memory": "8Gi" },
        "ports": [{ "containerPort": 8080 }],
        "env": [
          { "name": "WORKSPACE_ID",  "value": "ws-demo" },
          { "name": "CHECKPOINT_BUCKET", "value": "'"${BUCKET}"'" },
          { "name": "DATABASE_URL",  "value": "postgresql://dsh_app:'"${DB_PASSWORD}"'@<cloudsql-private-ip>:5432/<db-name>" },
          { "name": "GITHUB_APP_ID", "value": "<github-app-id>" },
          { "name": "GITHUB_APP_PRIVATE_KEY_PEM", "value": "<pem>" }
        ]
      }],
      "serviceAccount": "'"${SA_EMAIL}"'",
      "restartPolicy": "ON_FAILURE"
    },
    "sandboxLauncher": true
  }'
```

Exact field names for sandbox launcher, instance-level settings, and the DATABASE_URL scheme for private-IP Cloud SQL are Preview surface — **verify against the current REST reference before running**, and prefer the SDK's typed client (`packages/cloud-run-instance-client`) as the source of truth for the shape the control plane actually sends.

### 5.2 Via gcloud (if your SDK version ships the Preview command group)

```bash
gcloud run instances create dsh-ws-demo \
  --location="$REGION" \
  --image="$IMAGE" \
  --cpu=4 --memory=8Gi \
  --port=8080 \
  --restart-policy=on-failure \
  --sandbox-launcher \
  --service-account="$SA_EMAIL" \
  --set-env-vars="WORKSPACE_ID=ws-demo,CHECKPOINT_BUCKET=${BUCKET}"
```

If `gcloud run instances` is rejected ("Invalid choice"), your SDK predates the Preview command — use the REST call in 5.1.

### 5.3 Verify and stop

```bash
gcloud auth print-access-token | xargs -I{} curl -s \
  -H "Authorization: Bearer {}" \
  "https://run.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/instances/dsh-ws-demo"

# When done with a manual instance — it bills while RUNNING:
gcloud run instances stop dsh-ws-demo --location="$REGION" 2>/dev/null || \
curl -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://run.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/instances/dsh-ws-demo:stop"
```

---

## Step 6 — Deploy the control plane to Cloud Run

The control plane (`apps/control-plane`) is **not** provisioned by the T2 Terraform baseline. Deploy it with `gcloud` (wrap it in Terraform later when a stable `google_cloud_run_v2_service` wiring is agreed for this repo):

```bash
export CP_SA_EMAIL="$(terraform -chdir=infra/terraform output -raw control_plane_service_account_email)"
export CP_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/agent-host/control-plane:v1"

# (build the control-plane image analogously to Step 3; the control-plane app has
#  no dedicated Dockerfile yet — reuse the agent-host pattern with ENTRYPOINT
#  "bun run apps/control-plane/src/index.ts" or add one in a follow-up task)
gcloud run deploy control-plane \
  --project="$PROJECT_ID" --region="$REGION" \
  --image="$CP_IMAGE" \
  --service-account="$CP_SA_EMAIL" \
  --ingress=internal-and-cloud-load-balancing \
  --no-allow-unauthenticated
```

IAP configuration (brand + client were already created by Terraform in Step 2; members via `var.iap_members`):

1. `iap_client_id` / `iap_brand_name` from `terraform output` identify the OAuth brand/client.
2. Front the service with IAP — either an HTTPS Load Balancer backend (classic, stable) or the newer direct IAP-on-Cloud Run integration, whichever your project's Preview surface supports.
3. Grant `roles/iap.httpsResourceAccessor` to your users (Terraform does this for `var.iap_members`; add more with `gcloud iap web add-iam-policy-binding`).
4. The control plane **never trusts the IAP identity alone** — it resolves IAP identity → internal user → workspace membership → authorization (仕様書 §21, 実装手順書 §25). IAP being on does not make membership checks optional.

---

## Step 7 — Smoke check

From a browser/session that goes through IAP:

```bash
# 1. Control plane is alive (through the IAP-secured endpoint / LB URL):
curl -s "https://<control-plane-host>/healthz"
# → expect a 200 with the health payload

# 2. Create a workspace (IAP identity headers must be present behind IAP):
curl -s -X POST "https://<control-plane-host>/v1/workspaces" \
  -H "Content-Type: application/json" \
  -H "x-goog-authenticated-user-id: accounts.google.com:<sub>" \
  -d '{"id":"ws-demo"}'
# → 201; then open it — this is what triggers instance creation via the adapter:
curl -s -X POST "https://<control-plane-host>/v1/workspaces/ws-demo/open" \
  -H "x-goog-authenticated-user-id: accounts.google.com:<sub>"

# 3. Instance came up in Cloud Run:
gcloud run instances list --location="$REGION"   # if the Preview command exists
# …or GET .../instances/dsh-ws-demo per Step 5.3

# 4. DB has the workspace row (via cloud-sql-proxy as in Step 4):
psql "$DATABASE_URL" -c "SELECT id, state FROM workspaces WHERE id = 'ws-demo';"

# 5. Checkpoint bucket exists and is reachable by the agent-host SA:
gcloud storage ls "gs://$(terraform -chdir=infra/terraform output -raw checkpoint_bucket_name)"
```

Pass criteria: `/healthz` 200; workspace created + opened; an Instance exists for the workspace; the `workspaces` row shows the expected state; no 403 from IAP.

---

## Step 8 — Teardown (stop paying)

Order matters: remove Instance-attached things first, then Terraform.

```bash
# 1. Stop & delete every Cloud Run Instance you (or the control plane) created.
#    They are NOT in Terraform state — destroy will not remove them.
gcloud run instances list --location="$REGION"    # enumerate (or via REST GET)
gcloud run instances stop   dsh-ws-demo --location="$REGION" 2>/dev/null || true
gcloud run instances delete dsh-ws-demo --location="$REGION" 2>/dev/null || true

# 2. Delete the control-plane service:
gcloud run services delete control-plane --region="$REGION" --quiet

# 3. Destroy Terraform-managed resources (SQL, bucket, AR, IAM, secrets, IAP):
terraform -chdir=infra/terraform destroy
# If the db-password data source fails on destroy (secret version deleted manually), re-run
# with TF_VAR_db_password set — same escape hatch as the first apply.

# 4. Local state cleanup:
rm -f infra/terraform/terraform.tfstate infra/terraform/terraform.tfstate.backup

# 5. Optional — stop the meter completely (scratch project only):
gcloud projects delete "$PROJECT_ID"
#    or unlink billing:
gcloud billing projects unlink "$PROJECT_ID"
```

After `terraform destroy` the GCS bucket and Cloud SQL instance are gone — **checkpoints and sessions are unrecoverable**. If you want the data instead of the savings, skip step 3/5 and keep only paying for Cloud SQL, or export the bucket first.

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
| Step 5 | **Highest risk.** The Instance create call (REST field names, `gcloud run instances` availability, sandbox-launcher flag spelling, private-IP `DATABASE_URL` scheme inside the instance) is Preview surface that could not be probed at all without a Preview-enabled project. Verify every field against the current REST reference before running. |
| Step 6 | Control-plane image build + `gcloud run deploy` + IAP frontend wiring — unexecuted; the control-plane app has no dedicated Dockerfile in this baseline (called out above). |
| Step 7 | Smoke checks — depend on Steps 4–6. |
| Step 8 | `terraform destroy` behavior with real state; Instance stop/delete endpoint names under the Preview API. |

The preflight script (`bun run preflight:gcp`) is likewise only proven in its "unauthenticated / cannot-check" code paths plus the local tool + Terraform validation paths.