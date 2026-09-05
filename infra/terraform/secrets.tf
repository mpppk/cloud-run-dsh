resource "google_secret_manager_secret" "github_app_private_key" {
  project   = var.project_id
  secret_id = var.github_app_private_key_secret_id

  replication {
    auto {}
  }

  labels = var.labels

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "llm_api_key" {
  project   = var.project_id
  secret_id = var.llm_api_key_secret_id

  replication {
    auto {}
  }

  labels = var.labels

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "db_password" {
  project   = var.project_id
  secret_id = var.db_password_secret_id

  replication {
    auto {}
  }

  labels = var.labels

  depends_on = [google_project_service.apis]
}

# Dedicated DATABASE_URL for the control-plane Cloud Run service (issues
# #93 / #94). Managed here — like the other three — so the control-plane SA's
# accessor grant (iam.tf) cannot drift out of sync with the secret's
# existence. Previously created out-of-band in the runbook's Step 6
# (`gcloud secrets create`), which left it with no accessor grant and broke
# every `gcloud run deploy` with `Permission denied on secret`.
resource "google_secret_manager_secret" "control_plane_database_url" {
  project   = var.project_id
  secret_id = var.control_plane_database_url_secret_id

  replication {
    auto {}
  }

  labels = var.labels

  depends_on = [google_project_service.apis]
}

# Secret values are intentionally not managed in Terraform.
# Create versions out-of-band, e.g.:
#   echo -n "$VALUE" | gcloud secrets versions add <secret-id> --data-file=-
# Terraform only provisions the secret containers.
