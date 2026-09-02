resource "google_artifact_registry_repository" "agent_host" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_registry_repository_id
  description   = "Docker repository for the agent-host image (T2 baseline)."
  format        = "DOCKER"
  labels        = var.labels

  cleanup_policy_dry_run = false

  depends_on = [google_project_service.apis]
}
