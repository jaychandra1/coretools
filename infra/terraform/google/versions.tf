terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.6"
    }
  }
}

# Credentials come from Application Default Credentials, never from files:
#   gcloud auth application-default login
# user_project_override + billing_project make the Service Usage, Resource
# Manager and Monitoring calls count against the CoreTools project, so user
# ADC works without a separately configured quota project.
provider "google" {
  project               = var.project_id
  billing_project       = var.project_id
  user_project_override = true
}
