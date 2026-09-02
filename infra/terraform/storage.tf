locals {
  checkpoint_bucket_effective_name = var.checkpoint_bucket_name != "" ? var.checkpoint_bucket_name : "${var.project_id}-${var.environment}-checkpoints"
  checkpoint_bucket_location       = var.checkpoint_bucket_location != "" ? var.checkpoint_bucket_location : var.region
}

resource "google_storage_bucket" "checkpoints" {
  name                        = local.checkpoint_bucket_effective_name
  project                     = var.project_id
  location                    = local.checkpoint_bucket_location
  uniform_bucket_level_access = true
  force_destroy               = false
  labels                      = var.labels

  versioning {
    enabled = true
  }

  # Remove old checkpoint versions after 30 days; keep live objects
  # until explicitly deleted. Spec only requires cleanup of ARCHIVED
  # versions — LIVE object deletion is destructive and therefore opt-in.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      with_state                 = "ARCHIVED"
      days_since_noncurrent_time = 30
    }
  }

  # Opt-in: delete LIVE objects older than var.checkpoint_live_delete_age_days.
  # Disabled by default (0) to avoid destroying live checkpoints.
  dynamic "lifecycle_rule" {
    for_each = var.checkpoint_live_delete_age_days > 0 ? [1] : []
    content {
      action {
        type = "Delete"
      }
      condition {
        age        = var.checkpoint_live_delete_age_days
        with_state = "LIVE"
      }
    }
  }

  depends_on = [google_project_service.apis]
}
