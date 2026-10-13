# F-25: optional development project for local and preview builds.
#
# Local `npm run tauri dev/build` runs then use a dev OAuth client
# (CORETOOLS_GOOGLE_CLIENT_ID/SECRET set to the dev client in the shell),
# so testing never spends production Drive API quota, never shows up in the
# production alerts, and never touches real users' consent grants.
#
# Backups made with the dev client live in a DIFFERENT appDataFolder (it is
# per project): dev builds can't see production backups and vice versa.
#
# The dev OAuth consent screen and Desktop client are created by hand, like
# production (README.md → "What stays manual").

resource "google_project" "dev" {
  count = var.create_dev_project ? 1 : 0

  project_id      = var.dev_project_id
  name            = var.dev_project_name
  org_id          = var.dev_org_id
  folder_id       = var.dev_folder_id
  billing_account = var.dev_billing_account

  # Provider default, stated explicitly: Terraform refuses to delete the
  # project. Change to "DELETE" first if you really want `terraform destroy`
  # (or create_dev_project = false) to delete it.
  deletion_policy = "PREVENT"

  labels = {
    app = "coretools"
    env = "dev"
  }

  lifecycle {
    precondition {
      condition     = var.dev_project_id != null && var.dev_project_id != var.project_id
      error_message = "Set dev_project_id to a new project id that differs from project_id."
    }
    precondition {
      condition     = var.dev_org_id == null || var.dev_folder_id == null
      error_message = "Set at most one of dev_org_id and dev_folder_id."
    }
  }
}

resource "google_project_service" "dev_drive" {
  count = var.create_dev_project ? 1 : 0

  project = google_project.dev[0].project_id
  service = "drive.googleapis.com"

  disable_on_destroy         = false
  disable_dependent_services = false
}
