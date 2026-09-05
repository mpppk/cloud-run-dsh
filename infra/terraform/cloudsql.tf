# ---------------------------------------------------------------------------
# Cloud SQL for PostgreSQL
#
# Network choice: Private IP (no public IPv4) is preferred for security
# (spec sections 2 / 19 — session persistence). This requires a VPC,
# a private IP range, and a Service Networking peering connection.
# The file provisions a minimal dedicated VPC for the baseline; if the
# project already has a shared VPC, replace google_compute_network.sql
# and google_service_networking_connection.private_vpc_connection with
# a data source / existing network reference and remove the network
# resources below. Uncomment deletion_protection / backup settings for
# production.
# ---------------------------------------------------------------------------

resource "google_compute_network" "sql" {
  name                    = "${var.environment}-dsh-sql-vpc"
  project                 = var.project_id
  auto_create_subnetworks = false
  description             = "VPC for Cloud SQL private IP (T2 baseline). Replace with shared VPC if available."
}

resource "google_compute_global_address" "sql_private_ip" {
  name          = "${var.environment}-dsh-sql-private-ip"
  project       = var.project_id
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.sql.id
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.sql.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql_private_ip.name]

  deletion_policy = "ABANDON"
}

data "google_secret_manager_secret_version" "db_password" {
  count = var.db_password == null ? 1 : 0

  secret  = google_secret_manager_secret.db_password.id
  version = "latest"

  depends_on = [google_secret_manager_secret.db_password]
}

resource "google_sql_database_instance" "main" {
  name             = "${var.environment}-dsh-pg"
  project          = var.project_id
  region           = var.region
  database_version = var.db_version

  deletion_protection = false

  settings {
    tier = var.db_tier
    # MUST be explicit. Without it the API defaults this instance to
    # ENTERPRISE_PLUS, which rejects db-custom-* tiers with
    # "Invalid Tier (db-custom-1-3840) for (ENTERPRISE_PLUS) Edition".
    edition           = var.db_edition
    availability_type = "ZONAL"
    disk_autoresize   = true
    disk_type         = var.db_disk_type

    # Cost-profile knobs (defaults = production values; see profiles/):
    # PITR requires automated backups, and retained transaction logs are
    # meaningless without it, so both are forced off together when backups
    # are disabled instead of sending an invalid combination to the API.
    backup_configuration {
      enabled                        = var.db_backup_enabled
      point_in_time_recovery_enabled = var.db_backup_enabled && var.db_point_in_time_recovery_enabled
      transaction_log_retention_days = var.db_backup_enabled ? var.db_transaction_log_retention_days : null
    }

    maintenance_window {
      day          = 7
      hour         = 3
      update_track = "stable"
    }

    ip_configuration {
      # Private IP is configured, but a public IPv4 is REQUIRED in practice.
      #
      # A Cloud Run Instance has no VPC connectivity of any kind: the v2 API
      # drops vpcAccess.networkInterfaces and rejects vpcAccess.connector with
      # "not supported on resources of kind 'instance'". Instances reach Cloud
      # SQL through the built-in integration instead — a volume of type
      # `cloudSqlInstance` mounted at /cloudsql, authorized by
      # roles/cloudsql.client on the runtime service account (granted below).
      # That path needs NO proxy sidecar and NO VPC connector, but it does dial
      # the instance's public address: with ipv4_enabled = false it fails with
      # "SFEClient is nil / refresh failed: context deadline exceeded".
      # Both behaviours were measured against this project on 2026-09-03.
      # Re-verified on 2026-09-05: the production agent-host Instance mounted
      # the `cloudSqlInstance` volume at /cloudsql and reached PostgreSQL 16
      # (INSERT + SELECT as dsh_app) with db_enable_public_ip = true; see
      # docs/e2e-verification-report.md section 1.1 and docs/architecture.md.
      #
      # `authorized_networks` is deliberately left EMPTY. A Cloud Run Instance
      # egresses from Google's shared address pool, so any IP allowlist wide
      # enough to admit it is effectively 0.0.0.0/0 — an allowlist here would
      # be security theatre. Authorization is IAM plus an ephemeral client
      # certificate, so reaching the address is not sufficient to connect
      # (verified: a plain TCP connect from an unlisted host does not open).
      ipv4_enabled    = var.db_enable_public_ip
      private_network = google_compute_network.sql.id
      # SSL is enforced at the instance level via require_ssl = true
      # on the connection; google provider v6 removed require_ssl from
      # ip_configuration — use API flag or sql_ssl_config if needed.
    }

    insights_config {
      query_insights_enabled = var.db_query_insights_enabled
    }

    user_labels = var.labels
  }

  depends_on = [
    google_service_networking_connection.private_vpc_connection,
    google_project_service.apis,
  ]
}

resource "google_sql_database" "dsh" {
  name     = var.db_name
  instance = google_sql_database_instance.main.name
  project  = var.project_id

  # Issue #73: force destroy order database -> user.
  #
  # Terraform destroys in the inverse of creation order
  # (https://github.com/hashicorp/terraform/blob/main/docs/destroying.md#simple-resource-destruction:
  # "The order for destroying resource is exactly the inverse used to create
  # them"), so the resource carrying `depends_on` is destroyed FIRST.
  #
  # `DROP ROLE dsh_app` fails while the 6 migrated tables (and the
  # CONNECT/USAGE/CREATE grants inside `dsh`) still reference the role, so the
  # database must go first and the user second. That means the DATABASE must
  # depend on the USER — the opposite of the direction first suggested in #73
  # (`google_sql_user` depending on the database would destroy the user first
  # and reproduce the 400). Create order becomes user -> database, which is
  # safe: Cloud SQL users and databases are both instance-level objects with no
  # create-time dependency on each other.
  #
  # Best-effort, NOT verified against live GCP (no apply/destroy in this
  # environment): DROP DATABASE removes the owned tables plus the in-DB
  # privilege grants, and nothing outside `dsh` is ever owned by `dsh_app`, so
  # the subsequent DROP ROLE is expected to succeed — but if a privilege
  # residue ever blocks it again, the two-connection DROP OWNED + REVOKE
  # fallback in docs/deployment-runbook.md Step 8 still applies.
  # Issue #115: NO Terraform-side drain gate is possible here — verified
  # 2026-09-06 against the provider registry docs and upstream issue
  # hashicorp/terraform-provider-google#27492 (open `force_delete` request).
  # `google_sql_database` exposes only `deletion_policy`
  # (DELETE/ABANDON/PREVENT); there is no pre-delete hook, no connection
  # drain, and no DROP DATABASE ... WITH (FORCE) path, and the Cloud SQL
  # Admin API DELETE databases issues a plain DROP DATABASE that fails with
  # 400 "database is being accessed by other users" while idle backends
  # remain (Bun.SQL never reaps them — #109). A destroy-time provisioner was
  # rejected: it would need a live proxy + credentials during destroy and
  # could not be verified in this environment. The fix is operator-side:
  # docs/deployment-runbook.md Step 8 step 3b gates destroy on the
  # num_backends gauge, with re-run as fallback (measured 2026-09-05).
  depends_on = [google_sql_user.app]
}

resource "google_sql_user" "app" {
  name     = var.db_user
  instance = google_sql_database_instance.main.name
  project  = var.project_id
  # Never hardcode a literal — use Secret Manager in steady state, or
  # var.db_password for bootstrapping when the secret has no versions yet.
  # See README "Bootstrap sequence" for the two-step first-apply flow.
  password = var.db_password != null ? var.db_password : data.google_secret_manager_secret_version.db_password[0].secret_data
  # Changing the password version forces re-creation of the user password;
  # host must rotate via Secret Manager, not via TF state edits.
}
