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

# Issue #151: the existing GitHub App's OAuth Web-flow client secret
# (GitHub App Settings > General > Client secrets > "Generate a new client
# secret"). This is a SEPARATE credential from `github-app-private-key`
# (which signs installation-token JWTs): the private key never leaves the
# installation-token flow, and this secret never leaves the OAuth
# code-exchange in apps/control-plane/src/auth-github.ts.
#
# Operator setup (existing App — no new App registration needed):
#   1. Open the GitHub App settings > General and enable the Web flow if not
#      already enabled (user authorization during installation / web flow).
#   2. Generate a client secret and add it out-of-band:
#        echo -n "$CLIENT_SECRET" | gcloud secrets versions add github-app-client-secret --data-file=-
#   3. Set the App's "Authorization callback URL" to
#        <APP_ORIGIN>/auth/callback
#      where APP_ORIGIN is the control-plane Cloud Run HTTPS service URL
#      resolved at deployment time (see docs/deployment-runbook.md).
resource "google_secret_manager_secret" "github_app_client_secret" {
  project   = var.project_id
  secret_id = var.github_app_client_secret_id

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
