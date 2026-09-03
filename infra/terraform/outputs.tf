output "checkpoint_bucket_name" {
  description = "GCS checkpoint bucket name."
  value       = google_storage_bucket.checkpoints.name
}

output "checkpoint_bucket_url" {
  description = "GCS checkpoint bucket URL (gs://...)."
  value       = "gs://${google_storage_bucket.checkpoints.name}"
}

output "sql_connection_name" {
  description = "Cloud SQL connection name (project:region:instance)."
  value       = google_sql_database_instance.main.connection_name
}

output "sql_instance_name" {
  description = "Cloud SQL instance name."
  value       = google_sql_database_instance.main.name
}

output "sql_database_name" {
  description = "Application database name."
  value       = google_sql_database.dsh.name
}

output "artifact_registry_repository_url" {
  description = "Artifact Registry Docker repository URL."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.agent_host.name}"
}

output "agent_host_service_account_email" {
  description = "Agent-host service account email."
  value       = google_service_account.agent_host.email
}

output "control_plane_service_account_email" {
  description = "Control-plane service account email."
  value       = google_service_account.control_plane.email
}

output "ai_agent_service_account_email" {
  description = "AI-agent operator service account email for gcloud impersonation."
  value       = google_service_account.ai_agent.email
}

output "iap_brand_name" {
  description = "IAP brand resource name (if created)."
  value       = try(google_iap_brand.brand[0].name, null)
}

output "iap_client_id" {
  description = "IAP OAuth client ID (if created)."
  value       = try(google_iap_client.dsh[0].client_id, null)
}
