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

variable "iap_support_email" {
  description = "Support email for the IAP OAuth brand. Required when creating google_iap_brand. Supply out-of-band."
  type        = string
  default     = null
}

variable "iap_members" {
  description = "List of IAM members (e.g. \"user:alice@example.com\", \"group:eng@example.com\") granted IAP-secured Web App User."
  type        = list(string)
  default     = []
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

variable "run_subnet_cidr" {
  description = "CIDR for the Cloud Run Direct VPC egress subnet. Must not overlap the Private Services Access range reserved by google_compute_global_address.sql_private_ip."
  type        = string
  default     = "10.200.0.0/24"
}

variable "vpc_connector_cidr" {
  description = "Unused /28 for the Serverless VPC Access connector. Must not overlap the Cloud Run subnet or the Private Services Access range."
  type        = string
  default     = "10.201.0.0/28"
}
