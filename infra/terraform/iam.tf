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
