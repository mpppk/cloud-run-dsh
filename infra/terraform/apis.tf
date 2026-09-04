locals {
  required_apis = toset([
    "cloudresourcemanager.googleapis.com",
    # Required by google_compute_network.sql (Cloud SQL private IP VPC).
    # Without it the first apply fails with "Compute Engine API has not been used".
    "compute.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "storage.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "servicenetworking.googleapis.com",
  ])
}

resource "google_project_service" "apis" {
  for_each = local.required_apis

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
