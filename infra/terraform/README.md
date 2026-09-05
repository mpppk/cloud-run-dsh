# infra/terraform — GCP baseline (T2)

Terraform for the Google Cloud baseline described in 実装手順書 §2 and 仕様書 §21–22.

## Resources

| File | Purpose |
|---|---|
| `versions.tf` | `terraform >= 1.9`, `google` + `google-beta` providers `~> 6.0` |
| `variables.tf` | Input variables — see table below |
| `apis.tf` | Enables 12 required APIs (incl. IAM, Resource Manager, and Service Networking) |
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
| `db_edition` | string | `ENTERPRISE` | no | Cloud SQL edition. `db-custom-*` tiers require `ENTERPRISE`; left implicit the API picks `ENTERPRISE_PLUS` and rejects them. |
| `db_enable_public_ip` | bool | `false` | no | Public IPv4 for Cloud SQL. Default `false` is a deliberate safety valve; profiles opt in (`profiles/minimal.tfvars` sets `true`) because Cloud Run Instances dial the public address via the `cloudSqlInstance` volume. |
| `db_backup_enabled` | bool | `true` | no | Automated backups. Verification-only profiles may disable (accepts total data loss). |
| `db_point_in_time_recovery_enabled` | bool | `true` | no | PITR (requires backups). |
| `db_transaction_log_retention_days` | number | `7` | no | WAL retention days for PITR (1-7). Only applied when backups are enabled. |
| `db_query_insights_enabled` | bool | `true` | no | Query Insights. Verification-only profiles may disable. |
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

> **Note:** the live `TokenCreator` grant on the project was made out-of-band via
> `gcloud`, and `google_service_account_iam_member.ai_agent_impersonators` is
> additive — the live member may not be in Terraform state. Capture the actual
> member through `TF_VAR_ai_agent_impersonators` to bring it under Terraform
> management and avoid future drift confusion.

### ⚠️ Security posture: impersonating `ai-agent` yields full runtime secrets

**Do not treat this setup as least-privilege.** The effective credential
ceiling of anyone added to `ai_agent_impersonators` is **every runtime
credential in the project**. The confirmed escalation path is:

1. Impersonate the `ai-agent` SA (`roles/iam.serviceAccountTokenCreator`).
2. Use project-level `roles/run.admin` + `roles/artifactregistry.writer`, plus
   the scoped `actAs` (`roles/iam.serviceAccountUser`) bindings on both runtime
   SAs, to push an arbitrary container image and deploy a Cloud Run service
   running **as `agent-host`** (`dev-dsh-agent-host`).
3. That container can read all three Secret Manager secrets
   (`github-app-private-key`, `llm-api-key`, `db-password`) and the checkpoint
   bucket. The same holds when running as `control_plane`.

This is acceptable for a single-owner MVP scratch project, but adding a member
to `ai_agent_impersonators` is an informed decision — the wording above must
not overstate the security posture.

`roles/run.developer` is the narrower alternative to `run.admin` (it drops
Cloud Run service IAM policy management while still allowing create/update of
services, mirroring the `control_plane_run_admin` note below). However, it
does **not** close the secret path on its own: a developer can still deploy a
service running as `agent-host` (given `actAs`), and that identity holds
`secretAccessor` on all three secrets. Closing the secret path would require
revisiting the runtime SAs' `secretAccessor` grants.

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
`data` with `count`), and `var.db_password` can be left unset. Secret
*versions* are destroyed with the secrets (`terraform destroy` removes them),
so every recreate needs step 2 again (G10).

### Enabled APIs

`apis.tf` enables 12 APIs. `iam.googleapis.com` and
`cloudresourcemanager.googleapis.com` are required for IAM and project
resource operations. `servicenetworking.googleapis.com` is required for
`google_service_networking_connection.private_vpc_connection`, which creates
the private IP peering for Cloud SQL. Without it the first apply fails.

## Verification

```bash
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
```

`terraform` is not bundled in this repo; if the binary is absent the PR body notes it.

## Cloud Run Instances — deliberately outside Terraform (ADR-0001)

Cloud Run Instances (`run.googleapis.com` Instance API: create/start/stop/delete per-instance lifecycle, Pre-GA) are **not** provisioned via Terraform, by decision — not by accident. See [ADR-0001](../../docs/adr/0001-instances-outside-terraform.md) ([#28](https://github.com/mpppk/cloud-run-dsh/issues/28)).

In short: Instances are short-lived, per-workspace resources whose lifecycle belongs to the application (the control plane creates/deletes them at runtime). Managing them declaratively would turn every runtime-created Instance into `terraform plan` drift, while making "open a workspace" an infrastructure change. Terraform owns the static foundation (APIs, Cloud SQL, GCS, Secrets, IAM, service accounts) — nothing more.

Instance lifecycle is handled at runtime by the control plane's `InstanceRuntime` adapter (see 実装手順書 §5) which calls the Cloud Run REST API directly. Do **not** fake it with `google_cloud_run_v2_service`, and do not add a `run_instances.tf` even if `hashicorp/google`(-beta) ships a `google_cloud_run_instance` resource — revisit ADR-0001 first.

## Private IP choice (cloudsql.tf)

Cloud SQL has a private IP (dedicated VPC + Service Networking peering in
`cloudsql.tf`) **and** an opt-in public IPv4 (`var.db_enable_public_ip`,
default `false` as a deliberate safety valve). The public address is required
in practice: Cloud Run Instances have no VPC connectivity, so the native
`cloudSqlInstance` volume at `/cloudsql` dials the public address (measured
2026-09-03, re-verified 2026-09-05; with `ipv4_enabled = false` it fails with
`SFEClient is nil`). `authorized_networks` stays empty — authorization is IAM
(`roles/cloudsql.client`) plus an ephemeral client certificate, never source
IP. If the project already uses a Shared VPC, replace
`google_compute_network.sql` with a data source and reuse the existing peering.

## Teardown traps (read before `terraform destroy`)

Destroy can fail in two ways, and either one means billing does NOT stop:

- **Checkpoint bucket not empty.** `force_destroy = false` with versioning on,
  so any remaining object (live or noncurrent version) fails the destroy.
  Empty it first: `bun run teardown:empty-bucket -- --yes`.
- **DB user still referenced after migrations (#73).** `0001_init.sql` plus the
  runner-created `schema_migrations` table reference the `dsh_app` role, so
  deleting `google_sql_user.app` fails with `role "dsh_app" cannot be dropped
  because some objects depend on it` (400). Observed on the 2026-09-05
  teardown (first destroy failed, second passed after the database was gone —
  order-dependent). Before destroy, drop the objects:
  `psql "$DATABASE_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'`.
  See also [architecture §09](../../docs/architecture.md).

## IAM least-privilege summary

- `agent-host`: `cloudsql.client`, `storage.objectAdmin` (bucket-scoped) + `legacyBucketReader` (bucket-scoped), `secretmanager.secretAccessor` (three secrets), `logging.logWriter`, `monitoring.metricWriter`, plus `artifactregistry.reader` repo-scoped on the agent-host repository (image pull at Instance startup, #58).
- `control-plane`: same plus `run.admin`, `iam.serviceAccountUser` on the agent-host SA, and secret accessor for brokering. `legacyBucketReader` is granted symmetrically to both SAs so both can list checkpoints (agent_host restores, control_plane verifies). The control-plane SA also holds repo-scoped `artifactregistry.reader`: it never calls the AR API itself, but Cloud Run verifies image access with the caller's permission at Instance create time (#64) — verified live, do not remove as "unused".
- `ai-agent`: `run.admin` + `artifactregistry.writer` (project-level, via `ai_agent_project_roles`), `iam.serviceAccountTokenCreator` for members listed in `ai_agent_impersonators` (SA-scoped on the ai-agent SA), and scoped `iam.serviceAccountUser` (`actAs`) on both runtime SAs (`ai_agent_act_as_agent_host`, `ai_agent_act_as_control_plane`). See [AI-agent impersonation](#ai-agent-gcloud-impersonation): impersonating this account yields full runtime secrets.

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
