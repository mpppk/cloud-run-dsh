# ---------------------------------------------------------------------------
# Control-plane Cloud Run service (issue #155).
#
# The STABLE control-plane service is Terraform-managed. Preview Cloud Run
# Instances (agent-host, per-workspace) are NOT — see ADR-0001
# (docs/adr/0001-instances-outside-terraform.md): their lifecycle belongs to
# the application, and managing them here would turn every workspace open
# into plan drift. No agent-host service/instance resource may be added here.
#
# Fail-closed rollout gate (read the whole comment before flipping anything):
# - Defaults create NOTHING: `control_plane_image` defaults to "" and the
#   service has `count = 0` until a real image URL is supplied.
# - `control_plane_public` defaults to false: the service (once created) uses
#   restrictive ingress (internal + LB, the pre-#155 posture) with the
#   invoker IAM check ON. Public mode requires it to be explicitly true AND
#   (via lifecycle preconditions, which fail the plan otherwise) a non-empty
#   https APP_ORIGIN plus the GitHub App client ID / App ID / agent-host
#   image. There is deliberately NO `allUsers` IAM binding anywhere in this
#   repo: public mode uses the official recommended `invoker_iam_disabled`
#   field instead (https://cloud.google.com/run/docs/authenticating/public),
#   which needs no IAM grant and survives domain-restricted-sharing policies.
# - Rollback to private = set `control_plane_public = false` and re-apply
#   (ingress back to internal+LB, IAM check back on). #156 (IAP removal)
#   stays gated until production E2E succeeds — see docs/deployment-runbook.md.
#
# Two-phase bootstrap (service URI is only known after phase 1):
#   1. Set control_plane_image (+ App ID/agent-host image), keep public=false.
#      Apply. Read `control_plane_service_uri` from outputs.
#   2. Out-of-band: create secret VERSIONS (Step 6.x), register the GitHub App
#      callback <APP_ORIGIN>/auth/callback with APP_ORIGIN = that URI, run
#      migrations (0001-0004). Then set control_plane_public=true,
#      control_plane_app_origin=<URI>, control_plane_github_client_id=<Iv1…>
#      and re-apply. Verify with scripts/verify-issue155-e2e.ts.
#
# Secret posture: NO secret values in code or state — every credential env
# uses value_source.secret_key_ref (Secret Manager versions only, ":latest").
# AGENT_HOST_DATABASE_URL embeds the DB password, so it is a secret ref too,
# reusing the control-plane-database-url secret (identical socket-form value
# as DATABASE_URL — see runbook Step 6).
# ---------------------------------------------------------------------------

locals {
  cp_enabled = var.control_plane_image != ""
  cp_public  = local.cp_enabled && var.control_plane_public

  cp_base_env = {
    GCP_PROJECT_ID             = var.project_id
    GCP_REGION                 = var.region
    AGENT_HOST_IMAGE           = var.control_plane_agent_host_image
    AGENT_HOST_SERVICE_ACCOUNT = google_service_account.agent_host.email
    CHECKPOINT_BUCKET          = google_storage_bucket.checkpoints.name
    CLOUD_SQL_CONNECTION_NAME  = google_sql_database_instance.main.connection_name
    GITHUB_APP_ID              = var.control_plane_github_app_id
  }
  # Public-only env: OAuth is meaningless (and must stay unset) in private/
  # bootstrap mode; the app 503s /auth/* and skips the Origin gate instead.
  cp_public_env = local.cp_public ? {
    APP_ORIGIN           = var.control_plane_app_origin
    GITHUB_APP_CLIENT_ID = var.control_plane_github_client_id
  } : {}
  cp_env = merge(local.cp_base_env, local.cp_public_env, var.control_plane_extra_env)
}

resource "google_cloud_run_v2_service" "control_plane" {
  count = local.cp_enabled ? 1 : 0

  name     = var.control_plane_service_name
  location = var.region
  project  = var.project_id
  labels   = var.labels

  # Fail-closed ingress: public mode serves the internet edge, everything
  # else keeps the pre-#155 internal+LB posture for the (still IAP-fronted)
  # bootstrap phase and for rollback.
  ingress = local.cp_public ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  # Official recommended public-access mechanism (no allUsers binding):
  # https://cloud.google.com/run/docs/authenticating/public
  invoker_iam_disabled = local.cp_public

  deletion_protection = var.control_plane_deletion_protection

  template {
    service_account = google_service_account.control_plane.email
    # Server caps connections at 255s idle; the request bound stays the
    # platform's own 300s (see SERVER_IDLE_TIMEOUT_SECONDS).
    timeout = "300s"

    containers {
      image = var.control_plane_image

      ports {
        container_port = 8080
      }

      dynamic "env" {
        for_each = local.cp_env
        content {
          name  = env.key
          value = env.value
        }
      }

      # Credential env: Secret Manager versions only, never values.
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = var.control_plane_database_url_secret_id
            version = "latest"
          }
        }
      }
      # Same socket-form value as DATABASE_URL (runbook Step 6) — one
      # secret, two references. Must stay a secret ref: it embeds the DB
      # password and would otherwise land in Terraform state.
      env {
        name = "AGENT_HOST_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = var.control_plane_database_url_secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GITHUB_APP_PRIVATE_KEY_PEM"
        value_source {
          secret_key_ref {
            secret  = var.github_app_private_key_secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "OPENROUTER_API_KEY"
        value_source {
          secret_key_ref {
            secret  = var.llm_api_key_secret_id
            version = "latest"
          }
        }
      }
      # OAuth client secret exists only after the Step 6.x out-of-band
      # setup; referencing an absent version would fail the apply, so this
      # ref exists in public mode only (when OAuth is mandatory anyway).
      dynamic "env" {
        for_each = local.cp_public ? [1] : []
        content {
          name = "GITHUB_APP_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = var.github_app_client_secret_id
              version = "latest"
            }
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      # Startup gate on /readyz (honest DB probe, issue #97): Cloud Run
      # withholds traffic until the database is reachable instead of
      # serving 500s behind a "ready" badge. 60s grace covers cold start.
      startup_probe {
        initial_delay_seconds = 10
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 6
        http_get {
          path = "/readyz"
          port = 8080
        }
      }
      # Liveness stays process-level (/livez): a slow database must never
      # look like a dead process.
      liveness_probe {
        period_seconds    = 30
        timeout_seconds   = 5
        failure_threshold = 3
        http_get {
          path = "/livez"
          port = 8080
        }
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [google_project_service.apis]

  lifecycle {
    # Fail-closed public gate: these fail the PLAN (not the container at
    # boot) when public mode is requested without its mandatory config.
    precondition {
      condition = (
        !var.control_plane_public ||
        (
          local.cp_enabled &&
          var.control_plane_app_origin != "" &&
          startswith(var.control_plane_app_origin, "https://") &&
          var.control_plane_github_client_id != "" &&
          var.control_plane_github_app_id != "" &&
          var.control_plane_agent_host_image != ""
        )
      )
      error_message = "control_plane_public=true requires control_plane_image, https control_plane_app_origin, control_plane_github_client_id, control_plane_github_app_id and control_plane_agent_host_image (two-phase bootstrap: see control-plane.tf header)."
    }
    precondition {
      condition = (
        !local.cp_enabled ||
        (
          var.control_plane_github_app_id != "" &&
          var.control_plane_agent_host_image != ""
        )
      )
      error_message = "control_plane_image requires control_plane_github_app_id and control_plane_agent_host_image (REQUIRED_ENV_KEYS in apps/control-plane/src/config.ts)."
    }
  }
}
