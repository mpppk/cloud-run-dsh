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
