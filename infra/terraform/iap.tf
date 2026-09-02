# ---------------------------------------------------------------------------
# IAP — per spec section 21.
#
# user authentication is IAP; application must additionally verify
# workspace membership. This file wires the OAuth brand + client and
# grants IAP-secured Web App User to var.iap_members.
#
# Notes:
# - google_iap_brand can only exist once per project. If the project
#   already has a brand, import it or replace this resource with a
#   data source.
# - Backend-service-level IAP bindings (google_iap_web_backend_service_iam_*)
#   should be added once the Cloud Run / LB backend service exists.
# ---------------------------------------------------------------------------

resource "google_iap_brand" "brand" {
  count = var.iap_support_email != null ? 1 : 0

  project           = var.project_id
  support_email     = var.iap_support_email
  application_title = "Cloud Run DSH (${var.environment})"
}

resource "google_iap_client" "dsh" {
  count = var.iap_support_email != null ? 1 : 0

  brand        = google_iap_brand.brand[0].name
  display_name = "dsh-${var.environment}"
}

# Project-level IAP grant — sufficient for the baseline. Replace or
# supplement with backend-service-scoped bindings once the HTTPS LB /
# Cloud Run backend service is created.
resource "google_project_iam_member" "iap_https_resource_accessor" {
  for_each = toset(var.iap_members)

  project = var.project_id
  role    = "roles/iap.httpsResourceAccessor"
  member  = each.value
}
