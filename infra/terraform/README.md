# infra/terraform — GCP baseline (T2)

Terraform for the Google Cloud baseline described in 実装手順書 §2 and 仕様書 §21–22.

## Resources

| File | Purpose |
|---|---|
| `versions.tf` | `terraform >= 1.9`, `google` + `google-beta` providers `~> 6.0` |
| `variables.tf` | Input variables — see table below |
| `apis.tf` | Enables 9 required APIs (incl. Service Networking for Cloud SQL private IP) |
| `artifact_registry.tf` | Docker repo for the agent-host image |
| `cloudsql.tf` | Cloud SQL for PostgreSQL (private IP), database, user |
| `storage.tf` | GCS checkpoint bucket (uniform access, versioning, lifecycle) |
| `iam.tf` | Runtime service accounts, AI-agent operator account, and least-privilege bindings |
| `secrets.tf` | Secret Manager placeholders (no values in code) |
| `iap.tf` | IAP brand/client + `iap.httpsResourceAccessor` members |
| `outputs.tf` | Bucket, SQL connection, registry URL, SA emails |

## Variables

| Name | Type | Default | Required | Description |
|---|---|---|---|---|
| `project_id` | string | — | **yes** | GCP project ID. No default — supply via `TF_VAR_project_id` or `terraform.tfvars`. |
| `region` | string | `asia-northeast1` | no | Default region for regional resources. |
| `environment` | string | `dev` | no | Environment slug (`dev`/`staging`/`prod`). Used for naming. |
| `ai_agent_service_account_id` | string | `ai-agent` | no | Service account ID used by the local AI agent through gcloud impersonation. |
| `ai_agent_impersonators` | list(string) | `[]` | no | Members allowed to impersonate the AI-agent service account. |
| `ai_agent_project_roles` | set(string) | `roles/run.admin`, `roles/artifactregistry.writer` | no | Project roles granted to the AI-agent service account. Keep this minimal. |
| `db_tier` | string | `db-custom-1-3840` | no | Cloud SQL machine type. |
| `db_version` | string | `POSTGRES_16` | no | Postgres engine version. |
| `db_name` | string | `dsh` | no | Application database name. |
| `db_user` | string | `dsh_app` | no | Application DB user. |
| `checkpoint_bucket_name` | string | `""` | no | Bucket name; empty → `${project_id}-${environment}-checkpoints`. |
| `checkpoint_bucket_location` | string | `""` | no | Bucket location; empty → `var.region`. |
| `artifact_registry_repository_id` | string | `agent-host` | no | AR Docker repo ID. |
| `github_app_private_key_secret_id` | string | `github-app-private-key` | no | Secret ID for GitHub App private key. |
| `llm_api_key_secret_id` | string | `llm-api-key` | no | Secret ID for LLM API key. |
| `db_password_secret_id` | string | `db-password` | no | Secret ID for DB password. |
| `db_password` | string | `null` | no | Direct DB password for bootstrapping; `null` → read from Secret Manager. See Bootstrap sequence below. |
| `checkpoint_live_delete_age_days` | number | `0` | no | Days after which LIVE objects are deleted. `0` = disabled (safe default). |
| `iap_support_email` | string | `null` | conditional | Support email for IAP brand. Required to create `google_iap_brand`. |
| `iap_members` | list(string) | `[]` | no | Members granted `roles/iap.httpsResourceAccessor` (e.g. `user:alice@example.com`). |
| `labels` | map(string) | `{}` | no | Common labels on all resources. |

## How to init / plan

```bash
# Supply required vars out-of-band — never commit them.
export TF_VAR_project_id="my-gcp-project"
export TF_VAR_iap_support_email="support@example.com" # optional until IAP brand needed

terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform plan -var-file=terraform.tfvars  # or via env vars
terraform -chdir=infra/terraform apply
```

`backend` is deliberately not configured in this baseline (local state). Add a `backend "gcs" {}` block when a Terraform state bucket is ready.

現在の `cloud-run-dsh` プロジェクトでの設定記録は、[GCP AI-agent access](../../docs/gcp-ai-agent-impersonation.md) を参照してください。

### AI-agent gcloud impersonation

The `ai-agent` service account is an operator identity for local AI-agent
work. It has no user-managed key. Supply the human or workload members that
may impersonate it through `TF_VAR_ai_agent_impersonators`, then apply the
targeted resources before applying the rest of the baseline:

```bash
export TF_VAR_project_id="cloud-run-dsh"
export TF_VAR_ai_agent_impersonators='["user:you@example.com"]'

terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform apply \
  -target=google_service_account.ai_agent \
  -target=google_project_iam_member.ai_agent_project_roles \
  -target=google_service_account_iam_member.ai_agent_impersonators \
  -target=google_service_account_iam_member.ai_agent_act_as_agent_host \
  -target=google_service_account_iam_member.ai_agent_act_as_control_plane

export AI_AGENT_SA="$(terraform -chdir=infra/terraform output -raw ai_agent_service_account_email)"
gcloud config set project "$TF_VAR_project_id"
gcloud config set auth/impersonate_service_account "$AI_AGENT_SA"
gcloud auth print-access-token >/dev/null
```

The default project roles allow Cloud Run administration and Artifact
Registry image pushes. Add further roles only when the agent's workload
requires them; do not create a service-account key. To clear the local
impersonation setting, run `gcloud config unset auth/impersonate_service_account`.

## Values that MUST be supplied out-of-band

These are never stored in code and must be injected via Secret Manager / env:

- `TF_VAR_project_id` — GCP project id
- `TF_VAR_iap_support_email` — IAP OAuth brand support email
- Secret payloads (added with `gcloud secrets versions add` after `apply`):
  - `github-app-private-key` — GitHub App private key PEM
  - `llm-api-key` — LLM provider API key
  - `db-password` — PostgreSQL `dsh_app` password (also drives `google_sql_user.app.password` via `data.google_secret_manager_secret_version`)

Example:

```bash
echo -n "$GITHUB_APP_PEM" | gcloud secrets versions add github-app-private-key --data-file=-
echo -n "$LLM_KEY"        | gcloud secrets versions add llm-api-key        --data-file=-
echo -n "$DB_PW"          | gcloud secrets versions add db-password        --data-file=-
```

### Bootstrap sequence for the DB password (first apply)

On the very first `apply` the `db-password` secret has no versions yet, so
`data.google_secret_manager_secret_version.db_password` would fail with
"secret version not found". To make a clean first apply possible, `cloudsql.tf`
uses a bootstrap variable `var.db_password`:

- If `var.db_password` is `null` (default), Terraform reads `latest` from Secret Manager (steady-state path).
- If `var.db_password` is set (e.g. `TF_VAR_db_password="..."` or `-var db_password=...`), it is used directly and the data source is skipped (`count = 0`).

Recommended two-step bootstrap:

```bash
# 1) First apply — supply password out-of-band (never commit it)
TF_VAR_project_id=my-proj TF_VAR_db_password="$DB_PW" terraform apply

# 2) Store it in Secret Manager for steady-state, then remove the var
echo -n "$DB_PW" | gcloud secrets versions add db-password --data-file=-
# subsequent applies read from Secret Manager with var.db_password = null
terraform apply
```

After step 2 the password is sourced from Secret Manager again (conditional
`data` with `count`), and `var.db_password` can be left unset.

### Enabled APIs

`apis.tf` enables 9 APIs. The 9th is `servicenetworking.googleapis.com`,
required for `google_service_networking_connection.private_vpc_connection`
which creates the private IP peering for Cloud SQL. Without it the first
apply fails.

## Verification

```bash
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
```

`terraform` is not bundled in this repo; if the binary is absent the PR body notes it.

## Cloud Run Instances — Pre-GA note (TODO)

Cloud Run Instances (`run.googleapis.com` Instance API: create/start/stop/delete per-instance lifecycle, Pre-GA) do **not** yet have a stable Terraform resource in `hashicorp/google` / `google-beta` at the time of this baseline. The provider exposes `google_cloud_run_v2_service` / `job` but not a `google_cloud_run_instance` resource.

This baseline therefore does **not** provision Instances via Terraform. Instance lifecycle is handled at runtime by the control plane's `InstanceRuntime` adapter (see 実装手順書 §5) which calls the Cloud Run REST API directly.

```hcl
# TODO(cloud-run-instances): replace direct REST calls with a Terraform
# resource once hashicorp/google(-beta) ships google_cloud_run_instance
# (or google_cloud_run_v2_instance). Track:
#   https://github.com/hashicorp/terraform-provider-google/issues
#   https://cloud.google.com/run/docs/reference/rest/v1/projects.locations.instances
#
# resource "google_cloud_run_instance" "workspace" {
#   for_each = var.workspaces
#   ...
#   cpu             = 4
#   memory          = "8Gi"
#   restart_policy  = "ON_FAILURE"
# }

# Until then: DO NOT fake it with google_cloud_run_v2_service.
```

When a resource becomes available, add it under `infra/terraform/run_instances.tf` and wire the agent-host image from `google_artifact_registry_repository.agent_host`, the two service accounts, and the IAP backend.

## Private IP choice (cloudsql.tf)

Cloud SQL uses **private IP only** (`ipv4_enabled = false`, `private_network = <VPC>`). A minimal VPC + `VPC_PEERING` range + Service Networking connection is provisioned in `cloudsql.tf`. If the project already uses a Shared VPC, replace `google_compute_network.sql` with a data source and reuse the existing peering.

## IAM least-privilege summary

- `agent-host`: `cloudsql.client`, `storage.objectAdmin` (bucket-scoped) + `legacyBucketReader` (bucket-scoped), `secretmanager.secretAccessor` (three secrets), `logging.logWriter`, `monitoring.metricWriter`.
- `control-plane`: same plus `run.admin`, `iam.serviceAccountUser` on the agent-host SA, and secret accessor for brokering. `legacyBucketReader` is granted symmetrically to both SAs so both can list checkpoints (agent_host restores, control_plane verifies).

Bucket-level bindings use `google_storage_bucket_iam_member` (not project-wide `roles/storage.*`). Secret bindings use `google_secret_manager_secret_iam_member` per secret.

`roles/run.admin` on the control plane is the maximal choice needed to
create/start/stop/delete Cloud Run Instances. If the organisation forbids
`run.admin`, the narrower `roles/run.developer` is a viable alternative that
still allows instance lifecycle but with fewer permissions — switch
`google_project_iam_member.control_plane_run_admin` to `roles/run.developer`
and document the exception in the change log.

## Checkpoint lifecycle

`google_storage_bucket.checkpoints` has uniform bucket-level access, versioning
enabled, and a single active lifecycle rule:

- `ARCHIVED` objects (old versions) deleted after 30 days.

A second rule that deleted `LIVE` objects (`with_state = "ANY"` / `age = 90`) was
removed because it would destroy live checkpoints. LIVE deletion is now opt-in
behind `var.checkpoint_live_delete_age_days` (default `0` = disabled). Set it
to e.g. `90` only if you intentionally want to prune live checkpoints for cost
control, and document the retention explicitly before production.
