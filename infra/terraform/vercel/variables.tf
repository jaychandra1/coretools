variable "team" {
  description = "Vercel team id (team_…) or slug that owns the project. Leave null to use the token's default team."
  type        = string
  default     = null
}

variable "project_name" {
  description = "Vercel project name. The site is served at https://coretools-chi.vercel.app."
  type        = string
  default     = "coretools"
}

variable "git_repository" {
  description = "GitHub repository Vercel builds from (the Vercel GitHub app must have access to it)."
  type        = string
  default     = "jaychandra1/coretools"
}

variable "production_branch" {
  description = "Branch Vercel deploys to production. CI (ci.yml promote-web) moves it to a master commit only after the web checks pass."
  type        = string
  default     = "production"
}
