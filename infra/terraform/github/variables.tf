variable "owner" {
  description = "GitHub account that owns the source repository."
  type        = string
  default     = "jaychandra1"
}

variable "repository" {
  description = "Name of the private source repository (without the owner)."
  type        = string
  default     = "coretools"
}

variable "default_branch" {
  description = "Branch that releases are cut from and that CI promotes to `production`."
  type        = string
  default     = "master"
}

variable "required_status_checks" {
  description = <<-EOT
    Check names that must pass before anything merges into the default branch.
    These are the `name:` values of the jobs in .github/workflows/ci.yml (web,
    browser end-to-end, Linux Rust, Windows Rust). Renaming a job there without
    updating this list blocks every pull request, so change both together.
  EOT
  type        = list(string)
  default = [
    "Type-check, unit tests, dependency audit",
    "End-to-end smoke tests (browser)",
    "Rust lint (clippy), tests and format",
    "Rust build check (Windows)",
  ]

  validation {
    condition     = length(var.required_status_checks) > 0
    error_message = "List at least one required status check."
  }
}

variable "github_actions_app_id" {
  description = "App id of GitHub Actions (15368). Required checks must come from it, so a commit status set by anyone else cannot satisfy them."
  type        = number
  default     = 15368
}

variable "release_tag_pattern" {
  description = "fnmatch pattern for release tags. Used by the tag ruleset and the `release` environment's deployment policy."
  type        = string
  default     = "v*"
}

variable "release_branch_patterns" {
  description = <<-EOT
    Branches allowed to deploy to the `release` environment, in addition to
    release_tag_pattern tags. Empty by default, so only v* tag runs publish.
    release.yml's "Run workflow on master" re-publish mode needs ["master"].
  EOT
  type        = list(string)
  default     = []
}

variable "github_actions_creates_release_tags" {
  description = <<-EOT
    Let GitHub Actions (GITHUB_TOKEN) create v* tags. ci.yml's `tag-release`
    job tags a merged release pull request this way and then starts
    release.yml on the tag. Set to false if you only ever tag by hand
    (`npm version` + `git push --follow-tags`); `tag-release` then fails
    on a version you haven't tagged yourself.
  EOT
  type        = bool
  default     = true
}

variable "release_reviewers" {
  description = <<-EOT
    GitHub logins that must approve each publish in the `release` environment.
    Required reviewers on a PRIVATE repository need GitHub Enterprise Cloud; on
    Free/Pro/Team GitHub rejects them. Set to [] in that case (README.md
    explains the compensating controls).
  EOT
  type        = list(string)
  default     = ["jaychandra1"]

  validation {
    condition     = length(var.release_reviewers) <= 6
    error_message = "GitHub allows at most 6 required reviewers per environment."
  }
}

variable "required_secrets" {
  description = "Repository Actions secrets the workflows read. Terraform only checks that they exist; values are never managed here."
  type        = list(string)
  default = [
    "ARTIFACTS_REPO_TOKEN",
    "CORETOOLS_GOOGLE_CLIENT_ID",
    "CORETOOLS_GOOGLE_CLIENT_SECRET",
  ]
}

variable "artifacts_token_max_age_days" {
  description = "Warn when ARTIFACTS_REPO_TOKEN was last set more than this many days ago (its fine-grained PAT should expire within 90 days)."
  type        = number
  default     = 90
}
