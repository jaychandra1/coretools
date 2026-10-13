# Production Google Cloud project: the APIs CoreTools' cloud backup needs
# and protection against the project being deleted.
#
# Users' backups live in each user's Drive appDataFolder, which only OAuth
# clients of THIS project can read. If the project is deleted (and not
# restored within Google's 30-day window), installed copies can no longer
# reach the backups they made. See docs/runbooks/google-project-suspended-or-deleted.md.

data "google_project" "prod" {
  project_id = var.project_id
}

locals {
  prod_services = toset([
    "drive.googleapis.com",      # the backup transport (src-tauri/src/cloud.rs)
    "monitoring.googleapis.com", # alert policies in monitoring.tf
  ])
}

resource "google_project_service" "prod" {
  for_each = local.prod_services

  project = var.project_id
  service = each.value

  # Never disable an API from Terraform: turning off Drive would break
  # backup and restore for every installed copy at once.
  disable_on_destroy         = false
  disable_dependent_services = false

  lifecycle {
    prevent_destroy = true
  }
}

# F-24: a lien makes `projects.delete` fail for everyone, Owners included,
# until the lien itself is removed (which needs
# resourcemanager.projects.updateLiens). It does NOT stop Google suspending
# the project for a policy or billing reason.
resource "google_resource_manager_lien" "prevent_project_deletion" {
  parent       = "projects/${data.google_project.prod.number}"
  restrictions = ["resourcemanager.projects.delete"]
  origin       = "coretools-terraform"
  reason       = "Owns the CoreTools OAuth client; deleting it cuts every user off from their Drive backups. Remove this lien only on purpose (infra/terraform/google)."

  lifecycle {
    prevent_destroy = true
  }
}
