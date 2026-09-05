# ---------------------------------------------------------------------------
# Service accounts — least privilege per spec sections 2 / 18 / 19.
# ---------------------------------------------------------------------------

resource "google_service_account" "agent_host" {
  project      = var.project_id
  account_id   = "${var.environment}-dsh-agent-host"
  display_name = "Agent Host (${var.environment}) — runs Cloud Run Instance workload"
  description  = "Identity for the agent-host container (Instance + Sandbox launcher). See spec sec 18/19."
}

resource "google_service_account" "control_plane" {
  project      = var.project_id
  account_id   = "${var.environment}-dsh-control-plane"
  display_name = "Control Plane (${var.environment}) — workspace/instance controller"
  description  = "Identity for the control plane that manages workspace lifecycle and Instance start/stop."
}

# --- Local AI-agent operator identity --------------------------------------
#
# This account is intended for local gcloud/Terraform operations via service
# account impersonation. It is separate from the runtime identities above so
# credentials used by the operator are never placed on a Cloud Run workload.
resource "google_service_account" "ai_agent" {
  project      = var.project_id
  account_id   = var.ai_agent_service_account_id
  display_name = "AI Agent (${var.environment}) — local operator identity"
  description  = "Operator identity for the AI coding agent. Use gcloud service-account impersonation; do not create a key."
}

resource "google_project_iam_member" "ai_agent_project_roles" {
  for_each = var.ai_agent_project_roles

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.ai_agent.email}"
}

resource "google_service_account_iam_member" "ai_agent_impersonators" {
  for_each = toset(var.ai_agent_impersonators)

  service_account_id = google_service_account.ai_agent.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = each.value
}

# Cloud Run deployment requires iam.serviceAccounts.actAs on the selected
# runtime identity. Keep this scoped to the two runtime SAs rather than
# granting serviceAccountUser project-wide.
resource "google_service_account_iam_member" "ai_agent_act_as_agent_host" {
  service_account_id = google_service_account.agent_host.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ai_agent.email}"
}

resource "google_service_account_iam_member" "ai_agent_act_as_control_plane" {
  service_account_id = google_service_account.control_plane.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ai_agent.email}"
}

# --- Common roles (both SAs): logging + monitoring -------------------------

resource "google_project_iam_member" "agent_host_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.agent_host.email}"
}

resource "google_project_iam_member" "control_plane_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_project_iam_member" "agent_host_monitoring" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.agent_host.email}"
}

resource "google_project_iam_member" "control_plane_monitoring" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# --- Cloud SQL client (sections 2 / 19) -----------------------------------

resource "google_project_iam_member" "agent_host_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.agent_host.email}"
}

resource "google_project_iam_member" "control_plane_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# --- Storage: object admin scoped strictly to the checkpoint bucket --------

resource "google_storage_bucket_iam_member" "agent_host_bucket_admin" {
  bucket = google_storage_bucket.checkpoints.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.agent_host.email}"
}

resource "google_storage_bucket_iam_member" "control_plane_bucket_admin" {
  bucket = google_storage_bucket.checkpoints.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.control_plane.email}"
}

# Legacy bucket viewer for listing (least-privilege narrow alternative to
# objectAdmin at project scope). Scoped to bucket.
# Both SAs need listing: agent_host restores checkpoints, control_plane
# lists/verifies checkpoints. Keep symmetric for least-privilege clarity.
resource "google_storage_bucket_iam_member" "agent_host_bucket_legacy_reader" {
  bucket = google_storage_bucket.checkpoints.name
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${google_service_account.agent_host.email}"
}

resource "google_storage_bucket_iam_member" "control_plane_bucket_legacy_reader" {
  bucket = google_storage_bucket.checkpoints.name
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${google_service_account.control_plane.email}"
}

# --- Secret Manager: accessor scoped to each secret (section 18) ----------

resource "google_secret_manager_secret_iam_member" "agent_host_github_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.github_app_private_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agent_host.email}"
}

resource "google_secret_manager_secret_iam_member" "agent_host_llm_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.llm_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agent_host.email}"
}

resource "google_secret_manager_secret_iam_member" "agent_host_db_password" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.db_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agent_host.email}"
}

# Control plane also needs DB password for migrations / health checks.
resource "google_secret_manager_secret_iam_member" "control_plane_db_password" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.db_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}

# Control plane needs GitHub App key + LLM key for brokering ( §18 ).
resource "google_secret_manager_secret_iam_member" "control_plane_github_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.github_app_private_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_secret_manager_secret_iam_member" "control_plane_llm_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.llm_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}

# Control plane needs its own DATABASE_URL secret for the Cloud Run deploy
# (issues #93 / #94). Kept next to the other three accessor grants so a new
# secret can never again exist without its grant.
resource "google_secret_manager_secret_iam_member" "control_plane_database_url" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.control_plane_database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}

# --- Control plane only: Cloud Run admin ----------------------------------
# Needed to create/start/stop/delete Cloud Run Instances (spec §2, §27-29).
# Narrow to run.developer if the organisation forbids run.admin.

resource "google_project_iam_member" "control_plane_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Allow control plane to act as the agent-host SA when launching instances
# (iam.serviceAccountUser). Remove if instance creation uses a different flow.
resource "google_service_account_iam_member" "control_plane_act_as_agent_host" {
  service_account_id = google_service_account.agent_host.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.control_plane.email}"
}

# --- Artifact Registry: repo-scoped reader for Instance create + runtime ----
# The agent-host repository image is pulled at Instance startup by the Cloud
# Run infrastructure using the runtime execution SA (agent-host). Without this
# binding, POST /v1/workspaces/:id/open fails with
# artifactregistry.repositories.downloadArtifacts PERMISSION_DENIED (#58).
# Scoped to the repository — not the project — via
# google_artifact_registry_repository_iam_member.
#
# The control-plane SA does NOT call the Artifact Registry API itself — it only
# passes the image URI string in the create request (containers[].image).
# It still needs roles/artifactregistry.reader here because Cloud Run verifies
# image access with the CALLER's permission at Instance create time (#64).
# Verified on live infra: with agent-host only, `open` failed at `create` with
# downloadArtifacts 403; granting the control-plane SA let the same `open`
# proceed past create. Do NOT remove the control-plane binding as "unused".

resource "google_artifact_registry_repository_iam_member" "agent_host_reader" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.agent_host.repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.agent_host.email}"
}

resource "google_artifact_registry_repository_iam_member" "control_plane_reader" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.agent_host.repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.control_plane.email}"
}
