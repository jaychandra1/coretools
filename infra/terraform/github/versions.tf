terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.13"
    }
  }
}

# Credentials come from the environment, never from files:
#   GITHUB_TOKEN=<token>  (or, if unset, the provider falls back to `gh auth token`).
# Token permissions are listed in ../README.md → "GitHub".
provider "github" {
  owner = var.owner
}
