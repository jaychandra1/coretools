# Actions secrets and variables are DECLARED here, never managed: Terraform
# would have to hold the values in state to manage them. Values are set by
# hand in GitHub → Settings → Secrets and variables → Actions (or, for the
# signing secrets, Settings → Environments → release):
#
#   Repository secrets
#     ARTIFACTS_REPO_TOKEN            fine-grained PAT, Contents read/write on
#                                     jaychandra1/artifacts only, expiry <= 90 days
#                                     (stays a repository secret so release.yml's
#                                     quality job can fail fast on an expired token)
#     CORETOOLS_GOOGLE_CLIENT_ID      Google OAuth "Desktop app" client id
#     CORETOOLS_GOOGLE_CLIENT_SECRET  that client's secret (not confidential by
#                                     Google's definition; kept out of the repo)
#     AZURE_*, APPLE_*                optional OS code signing (DEPLOYMENT.md §3)
#   Updater signing secrets — repository secrets, or `release` environment
#   secrets once updater_signing_secrets_in_release_environment = true
#     TAURI_SIGNING_PRIVATE_KEY           the in-app updater's minisign private key
#     TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password
#   Repository variables (vars.*)
#     TAURI_UPDATER_PUBKEY            the updater's public key; switches in-app
#                                     updates on (checked below)
#     AZURE_ARTIFACT_SIGNING_*        optional Windows signing (DEPLOYMENT.md §3)
#     RELEASE_CANARY_IGNORE_VERSIONS  optional, release-canary.yml
#
# These checks read names and update times only (the API never returns
# secret values). A failed check is a warning on plan/apply; it never blocks one.

locals {
  updater_signing_secrets = ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"]

  repository_secrets = var.updater_signing_secrets_in_release_environment ? setsubtract(toset(var.required_secrets), toset(local.updater_signing_secrets)) : toset(var.required_secrets)

  release_environment_secrets = var.updater_signing_secrets_in_release_environment ? setintersection(toset(var.required_secrets), toset(local.updater_signing_secrets)) : toset([])
}

check "actions_secrets" {
  data "github_actions_secrets" "repo" {
    name = var.repository
  }

  assert {
    condition = length(setsubtract(
      local.repository_secrets,
      toset([for s in data.github_actions_secrets.repo.secrets : s.name]),
    )) == 0
    error_message = "Missing repository Actions secrets on ${var.owner}/${var.repository}: ${join(", ", sort(tolist(setsubtract(local.repository_secrets, toset([for s in data.github_actions_secrets.repo.secrets : s.name])))))}. Add them in GitHub (DEPLOYMENT.md §2, §4 and \"In-app updates\"). Values never go in Terraform."
  }

  # Once the signing secrets live in the environment, a leftover repository
  # copy would still be readable by every workflow — delete it.
  assert {
    condition = length(setintersection(
      local.release_environment_secrets,
      toset([for s in data.github_actions_secrets.repo.secrets : s.name]),
    )) == 0
    error_message = "TAURI_SIGNING_* are also still repository secrets on ${var.owner}/${var.repository}. Delete the repository copies so only the `release` environment holds them."
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

check "release_environment_secrets" {
  data "github_actions_environment_secrets" "release" {
    name        = var.repository
    environment = github_repository_environment.release.environment
  }

  assert {
    condition = length(setsubtract(
      local.release_environment_secrets,
      toset([for s in data.github_actions_environment_secrets.release.secrets : s.name]),
    )) == 0
    error_message = "Missing `release` environment secrets on ${var.owner}/${var.repository}: ${join(", ", sort(tolist(setsubtract(local.release_environment_secrets, toset([for s in data.github_actions_environment_secrets.release.secrets : s.name])))))}. Add them under Settings → Environments → release (DEPLOYMENT.md, \"Manual steps\")."
  }
}

check "actions_variables" {
  data "github_actions_variables" "repo" {
    name = var.repository
  }

  assert {
    condition = length(setsubtract(
      toset(var.required_variables),
      toset([for v in data.github_actions_variables.repo.variables : v.name]),
    )) == 0
    error_message = "Missing repository Actions variables on ${var.owner}/${var.repository}: ${join(", ", sort(tolist(setsubtract(toset(var.required_variables), toset([for v in data.github_actions_variables.repo.variables : v.name])))))}. Without TAURI_UPDATER_PUBKEY releases ship without in-app updates (DEPLOYMENT.md, \"In-app updates\")."
  }
}
