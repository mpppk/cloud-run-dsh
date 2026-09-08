variable "project_id" {
  description = "GCP project ID. Must be supplied out-of-band (env var TF_VAR_project_id or tfvars)."
  type        = string
  nullable    = false

  validation {
    condition     = length(var.project_id) > 0
    error_message = "project_id must not be empty."
  }
}

variable "region" {
  description = "Default GCP region for regional resources."
  type        = string
  default     = "asia-northeast1"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod, etc.). Used for naming and labelling."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.environment))
    error_message = "environment must be lower-case alphanumeric or hyphen."
  }
}

variable "ai_agent_service_account_id" {
  description = "Service account ID used by the local AI agent through gcloud impersonation."
  type        = string
  default     = "ai-agent"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.ai_agent_service_account_id))
    error_message = "ai_agent_service_account_id must be 6-30 characters, start with a letter, and contain only lowercase letters, numbers, or hyphens."
  }
}

variable "ai_agent_impersonators" {
  description = "IAM members allowed to impersonate the AI-agent service account (for example, [\"user:alice@example.com\"])."
  type        = list(string)
  default     = []
}

variable "ai_agent_project_roles" {
  description = "Project roles granted to the AI-agent service account. Keep this list minimal for the tasks the agent performs."
  type        = set(string)
  default = [
    "roles/run.admin",
    "roles/artifactregistry.writer",
  ]
}

variable "db_tier" {
  description = "Cloud SQL machine type. See https://cloud.google.com/sql/docs/postgres/instance-settings"
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_disk_type" {
  description = "Cloud SQL storage type: PD_SSD (production default) or PD_HDD (Enterprise edition only, cheaper, higher latency)."
  type        = string
  default     = "PD_SSD"

  validation {
    condition     = contains(["PD_SSD", "PD_HDD"], var.db_disk_type)
    error_message = "db_disk_type must be PD_SSD or PD_HDD."
  }
}

variable "db_backup_enabled" {
  description = "Enable automated Cloud SQL backups. Production default: true. Verification-only profiles may disable (accepts total data loss on instance failure)."
  type        = bool
  default     = true
}

variable "db_point_in_time_recovery_enabled" {
  description = "Enable point-in-time recovery (requires automated backups). Production default: true; PITR storage bills per GiB of retained WAL."
  type        = bool
  default     = true
}

variable "db_transaction_log_retention_days" {
  description = "Days of transaction logs retained for PITR (1-7). Production default: 7. Only applied when backups are enabled."
  type        = number
  default     = 7

  validation {
    condition     = var.db_transaction_log_retention_days >= 1 && var.db_transaction_log_retention_days <= 7
    error_message = "db_transaction_log_retention_days must be between 1 and 7 (Cloud SQL limit)."
  }
}

variable "db_query_insights_enabled" {
  description = "Enable Cloud SQL Query Insights. Production default: true; unnecessary for one-shot verification."
  type        = bool
  default     = true
}

variable "db_version" {
  description = "PostgreSQL engine version for Cloud SQL."
  type        = string
  default     = "POSTGRES_16"
}

variable "db_name" {
  description = "PostgreSQL database name."
  type        = string
  default     = "dsh"
}

variable "db_user" {
  description = "PostgreSQL application user name."
  type        = string
  default     = "dsh_app"
}

variable "checkpoint_bucket_name" {
  description = "GCS checkpoint bucket name. Leave empty to use derived name \"<project_id>-<environment>-checkpoints\"."
  type        = string
  default     = ""
}

variable "checkpoint_bucket_location" {
  description = "GCS bucket location. Defaults to var.region."
  type        = string
  default     = ""
}

variable "artifact_registry_repository_id" {
  description = "Artifact Registry Docker repository ID."
  type        = string
  default     = "agent-host"
}

variable "github_app_private_key_secret_id" {
  description = "Secret Manager secret ID for the GitHub App private key."
  type        = string
  default     = "github-app-private-key"
}

variable "llm_api_key_secret_id" {
  description = "Secret Manager secret ID for the LLM API key."
  type        = string
  default     = "llm-api-key"
}

variable "db_password_secret_id" {
  description = "Secret Manager secret ID for the Cloud SQL application user password."
  type        = string
  default     = "db-password"
}

variable "control_plane_database_url_secret_id" {
  description = "Secret Manager secret ID for the control-plane Cloud Run service DATABASE_URL (socket form, added out-of-band in the runbook Step 6)."
  type        = string
  default     = "control-plane-database-url"
}

variable "github_app_client_secret_id" {
  description = "Secret Manager secret ID for the GitHub App OAuth Web-flow client secret (issue #151; separate from the private key. Version added out-of-band)."
  type        = string
  default     = "github-app-client-secret"
}

# ---------------------------------------------------------------------------
# Control-plane Cloud Run service (issue #155). All defaults keep the
# service unmanaged (image "") and private (public=false): nothing is
# created or publicized unexpectedly. See control-plane.tf header for the
# two-phase bootstrap and rollback.
# ---------------------------------------------------------------------------

variable "control_plane_image" {
  description = "Full container image URL for the control-plane service (e.g. <region>-docker.pkg.dev/<project>/agent-host/control-plane:v1). Empty means the service is NOT Terraform-managed."
  type        = string
  default     = ""
}

variable "control_plane_service_name" {
  description = "Cloud Run service name for the control plane."
  type        = string
  default     = "control-plane"
}

variable "control_plane_public" {
  description = "Public rollout gate (issue #155). false = restrictive ingress (internal+LB) with the invoker IAM check ON (bootstrap/rollback posture). true = INGRESS_TRAFFIC_ALL with invoker_iam_disabled (official recommended public mechanism, no allUsers binding) — requires app_origin (https), github_client_id, github_app_id and agent_host_image (lifecycle preconditions fail the plan otherwise)."
  type        = bool
  default     = false
}

variable "control_plane_app_origin" {
  description = "Public origin of the control plane (e.g. https://dsh-control-abc.run.app). Required in public mode: must equal the service URI (or custom domain) AND the GitHub App callback <APP_ORIGIN>/auth/callback. Leave empty in private/bootstrap mode."
  type        = string
  default     = ""
}

variable "control_plane_github_client_id" {
  description = "GitHub App OAuth Web-flow client ID (Iv1.…). Required in public mode; empty disables OAuth login (app 503s /auth/*)."
  type        = string
  default     = ""
}

variable "control_plane_github_app_id" {
  description = "GitHub App numeric ID (GITHUB_APP_ID, not a secret). Required whenever the service is managed."
  type        = string
  default     = ""
}

variable "control_plane_agent_host_image" {
  description = "Agent-host container image URL injected into created Instances (AGENT_HOST_IMAGE). Required whenever the service is managed."
  type        = string
  default     = ""
}

variable "control_plane_deletion_protection" {
  description = "Deletion protection for the control-plane service. Keep true in production; set false for verification profiles that terraform-destroy afterwards."
  type        = bool
  default     = true
}

variable "control_plane_extra_env" {
  description = "Optional plain-text env passthrough (LLM_BASE_URL/MODEL/APPROVAL_POLICY, INSTANCE_GC_*, DB_POOL_*). WARNING: values land in Terraform state — never put secrets here; credentials are secret_key_refs in control-plane.tf."
  type        = map(string)
  default     = {}
}

variable "checkpoint_live_delete_age_days" {
  description = "If >0, GCS lifecycle will delete LIVE checkpoint objects older than this many days. Defaults to 0 (disabled) to avoid destructive deletion of live checkpoints; spec only requires cleanup of ARCHIVED versions."
  type        = number
  default     = 0
}

variable "db_password" {
  description = "Optional direct DB password for bootstrapping. When set, used as google_sql_user.app password instead of reading from Secret Manager. Leave null to use Secret Manager (recommended for steady state). Required for first apply when the secret has no versions yet."
  type        = string
  default     = null
  sensitive   = true
}

variable "labels" {
  description = "Common labels applied to all resources."
  type        = map(string)
  default     = {}
}

variable "db_edition" {
  description = "Cloud SQL edition. Must match var.db_tier: db-custom-* tiers require ENTERPRISE; ENTERPRISE_PLUS only accepts db-perf-optimized-N-* tiers. Left implicit the API picks ENTERPRISE_PLUS and rejects db-custom-*."
  type        = string
  default     = "ENTERPRISE"

  validation {
    condition     = contains(["ENTERPRISE", "ENTERPRISE_PLUS"], var.db_edition)
    error_message = "db_edition must be ENTERPRISE or ENTERPRISE_PLUS."
  }
}



variable "db_enable_public_ip" {
  description = "Assign a public IPv4 to Cloud SQL in addition to the private IP. Required today because Cloud Run Instances have no VPC connectivity, so the Cloud SQL Auth Proxy must dial the public address. Default false is a deliberate safety valve (public exposure is opt-in per profile, e.g. profiles/minimal.tfvars); authorized_networks stays empty: access is authorized by IAM (roles/cloudsql.client) and an ephemeral client certificate, never by source IP."
  type        = bool
  default     = false
}
