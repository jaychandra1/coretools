variable "project_id" {
  description = "Id of the PRODUCTION Google Cloud project that owns the OAuth client compiled into releases (CORETOOLS_GOOGLE_CLIENT_ID) and its Drive API usage."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a Google Cloud project id (6-30 chars: lowercase letters, digits, hyphens)."
  }
}

# --- alerting ---------------------------------------------------------------

variable "enable_alerting" {
  description = "Create the email notification channel and the Drive API alert policies. Cloud Monitoring bills alerting per condition; see README.md."
  type        = bool
  default     = true
}

variable "alert_email" {
  description = "Address that receives Drive API alerts. Keep it in terraform.tfvars (git-ignored), not in a checked-in file."
  type        = string
  default     = null

  validation {
    condition     = var.alert_email == null || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "runbook_url" {
  description = "Runbook linked from every alert notification."
  type        = string
  default     = "https://github.com/jaychandra1/coretools/blob/master/docs/runbooks/drive-api-outage-or-quota.md"
}

variable "error_window" {
  description = "PromQL range over which Drive API error ratios are computed. Backups are bursty and low-volume, so short windows are noisy."
  type        = string
  default     = "30m"

  validation {
    condition     = can(regex("^[0-9]+[mh]$", var.error_window))
    error_message = "error_window must be a PromQL duration in minutes or hours, e.g. \"30m\" or \"1h\"."
  }
}

variable "drive_5xx_ratio_threshold" {
  description = "Alert when more than this fraction of Drive API requests fail with 5xx over error_window."
  type        = number
  default     = 0.05
}

variable "drive_throttle_ratio_threshold" {
  description = "Alert when more than this fraction of Drive API requests get 403 or 429 (rate limits, quota, policy) over error_window."
  type        = number
  default     = 0.10
}

variable "drive_min_error_count" {
  description = "Minimum number of failing requests in error_window before a ratio alert can fire, so one failed request out of three doesn't page anyone."
  type        = number
  default     = 5
}

variable "quota_usage_threshold" {
  description = "Alert when Drive API per-minute rate-quota usage exceeds this fraction of the limit."
  type        = number
  default     = 0.7

  validation {
    condition     = var.quota_usage_threshold > 0 && var.quota_usage_threshold < 1
    error_message = "quota_usage_threshold must be between 0 and 1."
  }
}

variable "quota_limit_name_regex" {
  description = "PromQL regex selecting the per-minute rate limits (limit_name label of serviceruntime.googleapis.com/quota/limit) to compare usage against. Google's documented default is \".*PerMinute.*\"; pin it to the exact project-level limit name once you've looked it up (README.md)."
  type        = string
  default     = ".*PerMinute.*"
}

variable "quota_limit_name_exclude_regex" {
  description = "PromQL regex of limit names to ignore. Usage is summed per project, so comparing it with a per-USER limit would alert far too early."
  type        = string
  default     = ".*PerUser.*"
}

# --- development project (F-25) -------------------------------------------------

variable "create_dev_project" {
  description = "Create a separate Google Cloud project for local and preview builds, so development never spends production Drive API quota or shares its OAuth client. Off by default."
  type        = bool
  default     = false
}

variable "dev_project_id" {
  description = "Globally unique id for the development project (required when create_dev_project is true). Must differ from project_id."
  type        = string
  default     = null
}

variable "dev_project_name" {
  description = "Display name of the development project."
  type        = string
  default     = "CoreTools (dev)"
}

variable "dev_org_id" {
  description = "Numeric organization id to create the dev project under. Leave null (and dev_folder_id null) for a personal account with no organization."
  type        = string
  default     = null
}

variable "dev_folder_id" {
  description = "Numeric folder id to create the dev project under. Mutually exclusive with dev_org_id."
  type        = string
  default     = null
}

variable "dev_billing_account" {
  description = "Billing account for the dev project. Not needed for the Drive API; leave null."
  type        = string
  default     = null
}
