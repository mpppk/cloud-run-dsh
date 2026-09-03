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

# Verification only: total data loss is accepted on instance failure.
# PITR (+ its WAL storage cost) and Query Insights are pointless here.
db_backup_enabled                 = false
db_point_in_time_recovery_enabled = false
db_transaction_log_retention_days = 1
db_query_insights_enabled         = false
