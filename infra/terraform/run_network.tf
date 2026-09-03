# Subnet for Cloud Run Direct VPC egress.
#
# google_compute_network.sql sets auto_create_subnetworks = false, so the VPC
# has no subnets of its own. Private Services Access (the peering used by Cloud
# SQL) does not need one, but Cloud Run Direct VPC egress DOES: a
# GoogleCloudRunV2NetworkInterface requires a `subnetwork`. Without this
# resource nothing running on Cloud Run can reach the private-IP Cloud SQL
# instance — the deployment comes up but cannot talk to its own database.
resource "google_compute_subnetwork" "run" {
  name          = "${var.environment}-dsh-run-subnet"
  project       = var.project_id
  region        = var.region
  network       = google_compute_network.sql.id
  ip_cidr_range = var.run_subnet_cidr

  # Lets workloads reach Google APIs (Secret Manager, GCS, Artifact Registry)
  # without an external IP.
  private_ip_google_access = true
}

# Serverless VPC Access connector.
#
# REQUIRED for Cloud Run Instances to reach the private-IP Cloud SQL instance.
# Direct VPC egress (GoogleCloudRunV2VpcAccess.networkInterfaces) is present in
# the v2 discovery document but is NOT honoured for Instances: the API silently
# drops the field and then rejects its own request with
#   metadata.annotations[run.googleapis.com/vpc-access-egress]: ... cannot be set
#   without also setting the ... vpc-access-connector ... annotation
# Verified against the live API on 2026-09-03 with network-only, subnetwork-only
# and fully-qualified variants; all three fail identically. Use
# vpcAccess.connector instead.
resource "google_vpc_access_connector" "run" {
  name          = "${var.environment}-dsh-conn"
  project       = var.project_id
  region        = var.region
  network       = google_compute_network.sql.name
  ip_cidr_range = var.vpc_connector_cidr
  min_instances = 2
  max_instances = 3
  machine_type  = "e2-micro"

  depends_on = [google_project_service.apis]
}
