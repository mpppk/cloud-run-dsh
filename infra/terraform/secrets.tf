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

# Secret values are intentionally not managed in Terraform.
# Create versions out-of-band, e.g.:
#   echo -n "$VALUE" | gcloud secrets versions add <secret-id> --data-file=-
# Terraform only provisions the secret containers.
