# Repository protection for jaychandra1/coretools (audit F-03 / F-04).
# DEPLOYMENT.md → "Repository protection" describes the same settings for
# the UI; this file is the source of truth once applied.
#
# Rulesets on a private repository need GitHub Pro (or Team/Enterprise).

locals {
  # Built-in "Repository admin" role. On a personal-account repository only
  # the owner holds it, so this means "the owner".
  repository_admin_role_id = 5
}

# --- master: review ----------------------------------------------------------
# Every change reaches master through a pull request with a code-owner review
# (.github/CODEOWNERS). The owner works solo, so the owner may merge their
# own pull request without a second approval, but only through a pull
# request. This bypass covers ONLY this ruleset's rules: the checks below
# live in a separate ruleset that nobody can bypass.
resource "github_repository_ruleset" "master_review" {
  name        = "${var.default_branch}: pull request + code-owner review"
  repository  = var.repository
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/${var.default_branch}"]
      exclude = []
    }
  }

  bypass_actors {
    actor_id    = local.repository_admin_role_id
    actor_type  = "RepositoryRole"
    bypass_mode = "pull_request"
  }

  rules {
    pull_request {
      required_approving_review_count   = 1
      require_code_owner_review         = true
      dismiss_stale_reviews_on_push     = true
      require_last_push_approval        = false
      required_review_thread_resolution = false
      allowed_merge_methods             = ["merge", "squash", "rebase"]
    }
  }
}

# --- master: integrity --------------------------------------------------------
# No bypass actors: nobody, the owner included, can merge with red CI,
# force-push master or delete it. Changing that means changing this file.
resource "github_repository_ruleset" "master_integrity" {
  name        = "${var.default_branch}: required checks, no force push, no deletion"
  repository  = var.repository
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/${var.default_branch}"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true

    required_status_checks {
      strict_required_status_checks_policy = false

      dynamic "required_check" {
        for_each = toset(var.required_status_checks)
        content {
          context        = required_check.value
          integration_id = var.github_actions_app_id
        }
      }
    }
  }
}

# --- release tags --------------------------------------------------------------
# A v* tag starts a release, so only the owner may create, move or delete
# one, plus GitHub Actions for ci.yml's `tag-release` job when
# github_actions_creates_release_tags is true. That job only tags a master
# commit after every CI gate passed, and changing any workflow needs a
# reviewed merge to master.
resource "github_repository_ruleset" "release_tags" {
  name        = "release tags (${var.release_tag_pattern})"
  repository  = var.repository
  target      = "tag"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/tags/${var.release_tag_pattern}"]
      exclude = []
    }
  }

  bypass_actors {
    actor_id    = local.repository_admin_role_id
    actor_type  = "RepositoryRole"
    bypass_mode = "always"
  }

  dynamic "bypass_actors" {
    for_each = var.github_actions_creates_release_tags ? [var.github_actions_app_id] : []
    content {
      actor_id    = bypass_actors.value
      actor_type  = "Integration"
      bypass_mode = "always"
    }
  }

  rules {
    creation = true
    update   = true
    deletion = true
  }
}

# --- release environment ---------------------------------------------------------
# release.yml's `sign-updates` and `publish` jobs run in this environment.
# Only runs on a v* tag may deploy (a manual run from master is refused
# unless release_branch_patterns lists it). Each of those jobs waits for a
# listed reviewer when release_reviewers is non-empty — two approvals per
# release with in-app updates on: signing, then publishing.
#
# The updater's private key (TAURI_SIGNING_PRIVATE_KEY + _PASSWORD) belongs
# in this environment's secrets (audit S-2): then only sign-updates, on a v*
# tag run, can read it. Set
# updater_signing_secrets_in_release_environment = true once moved, and the
# checks in secrets.tf look for them here instead of in the repository.
# GitHub Free configures environments (secrets, policies, reviewers) only for
# public repositories; a private repository needs GitHub Pro — like every
# resource in this module.
# promote-latest.yml deliberately doesn't use this environment (it runs from
# master and only re-publishes files release.yml already signed).

data "github_user" "release_reviewer" {
  for_each = toset(var.release_reviewers)
  username = each.value
}

resource "github_repository_environment" "release" {
  repository  = var.repository
  environment = "release"

  # The owner both pushes the tag and approves the publish.
  prevent_self_review = false
  # Admins (the owner) can't skip the approval: every publish is an
  # explicit click.
  can_admins_bypass = false

  dynamic "reviewers" {
    for_each = length(var.release_reviewers) > 0 ? [1] : []
    content {
      users = [for login in sort(var.release_reviewers) : tonumber(data.github_user.release_reviewer[login].id)]
    }
  }

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "release_tags" {
  repository  = var.repository
  environment = github_repository_environment.release.environment
  tag_pattern = var.release_tag_pattern
}

# Optional, off by default: lets release.yml's "Run workflow on master"
# re-publish mode reach the environment (both sign-updates and publish).
resource "github_repository_environment_deployment_policy" "release_branches" {
  for_each = toset(var.release_branch_patterns)

  repository     = var.repository
  environment    = github_repository_environment.release.environment
  branch_pattern = each.value
}
