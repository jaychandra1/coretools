output "ruleset_ids" {
  description = "Ids of the managed rulesets (as shown in Settings → Rules → Rulesets)."
  value = {
    master_review    = github_repository_ruleset.master_review.ruleset_id
    master_integrity = github_repository_ruleset.master_integrity.ruleset_id
    release_tags     = github_repository_ruleset.release_tags.ruleset_id
  }
}

output "release_environment" {
  description = "Environment that release.yml's publish job deploys to."
  value       = github_repository_environment.release.environment
}
