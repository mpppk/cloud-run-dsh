# Minimal cost profile — for one-shot bring-up verification (P6 billing gate).
#
# Usage:
#   terraform -chdir=infra/terraform plan  -var-file=profiles/minimal.tfvars
#   terraform -chdir=infra/terraform apply -var-file=profiles/minimal.tfvars
#
# Production defaults are NOT changed; every variable here only tightens the
# existing knobs. Rationale and sourced cost estimates: docs/cost.md.
#
# Tier choice (verified against official docs, not guessed):
# - Cloud SQL for PostgreSQL Enterprise edition supports the "general purpose
#   shared core" machine series (db-f1-micro / db-g1-small) with POSTGRES_16:
#   https://cloud.google.com/sql/docs/postgres/machine-series-overview
# - db-f1-micro (shared 1 vCPU, 0.6 GiB) is the cheapest tier that still runs
#   PostgreSQL 16. It is NOT covered by the Cloud SQL SLA and 0.6 GiB will not
#   sustain a real workload — bring-up / migration smoke test only.
# - If the instance OOMs at 0.6 GiB, fall back to db-g1-small (1.7 GiB,
#   ~3x the price) before concluding the deployment is broken.
# - Teardown billing notes (stop paying ASAP): docs/cost.md#teardown.

db_tier      = "db-f1-micro"
db_disk_type = "PD_HDD"

# Public IPv4 MUST stay enabled for this profile (variables.tf default is a
# deliberate false safety valve; only profiles opt in):
# - Cloud Run Instances have NO VPC connectivity at all (no connector, no NAT —
#   `vpcAccess` is rejected/silently dropped on Instances), so the native
#   `cloudSqlInstance` volume dials the instance's PUBLIC address via /cloudsql.
#   With ipv4_enabled = false the bring-up fails: `SFEClient is nil` /
#   `refresh failed: context deadline exceeded` (measured 2026-09-03).
# - authorized_networks stays empty: an Instance egresses from Google's shared
#   pool, so any allowlist wide enough to admit it is effectively 0.0.0.0/0.
#   Authorization is IAM (roles/cloudsql.client) + a short-lived client
#   certificate, never a source IP.
db_enable_public_ip = true

# Verification only: total data loss is accepted on instance failure.
# PITR (+ its WAL storage cost) and Query Insights are pointless here.
db_backup_enabled                 = false
db_point_in_time_recovery_enabled = false
db_transaction_log_retention_days = 1
db_query_insights_enabled         = false
