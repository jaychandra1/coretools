# Actions secrets are DECLARED here, never managed: Terraform would have to
# hold the values in state to manage them. Values are set by hand in
# GitHub → Settings → Secrets and variables → Actions:
#
#   ARTIFACTS_REPO_TOKEN            fine-grained PAT, Contents read/write on
#                                   jaychandra1/artifacts only, expiry <= 90 days
#   CORETOOLS_GOOGLE_CLIENT_ID      Google OAuth "Desktop app" client id
#   CORETOOLS_GOOGLE_CLIENT_SECRET  that client's secret (not confidential by
#                                   Google's definition; kept out of the repo)
#
# The workflows use no Actions variables (`vars.*`) and no environment
# secrets; ARTIFACTS_REPO_TOKEN stays a repository secret so release.yml's
# quality job can fail fast on an expired token.
#
# This check reads secret NAMES and update times only (the API never returns
# values). A failed check is a warning on plan/apply; it never blocks one.
check "actions_secrets" {
  data "github_actions_secrets" "repo" {
    name = var.repository
  }

  assert {
    condition = length(setsubtract(
      toset(var.required_secrets),
      toset([for s in data.github_actions_secrets.repo.secrets : s.name]),
    )) == 0
    error_message = "Missing Actions secrets on ${var.owner}/${var.repository}: ${join(", ", sort(tolist(setsubtract(toset(var.required_secrets), toset([for s in data.github_actions_secrets.repo.secrets : s.name])))))}. Add them in GitHub (DEPLOYMENT.md §2 and §4). Values never go in Terraform."
  }

  # The provider reports times as "2006-01-02 15:04:05 +0000 UTC"; the first
  # 19 characters become RFC 3339 so they can be compared with the plan time.
  assert {
    condition = alltrue([
      for s in data.github_actions_secrets.repo.secrets :
      try(
        timecmp(
          timeadd("${replace(substr(s.updated_at, 0, 19), " ", "T")}Z", "${var.artifacts_token_max_age_days * 24}h"),
          plantimestamp(),
        ) > 0,
        false,
      )
      if s.name == "ARTIFACTS_REPO_TOKEN"
    ])
    error_message = "ARTIFACTS_REPO_TOKEN was last set more than ${var.artifacts_token_max_age_days} days ago (or its update time couldn't be read). Its PAT has probably expired: create a new one and update the secret (DEPLOYMENT.md §2)."
  }
}
