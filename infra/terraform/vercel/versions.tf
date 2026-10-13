terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 5.21"
    }
  }
}

# Credentials come from the environment, never from files:
#   VERCEL_API_TOKEN=<token>  (Vercel → Account Settings → Tokens, scoped to the team)
provider "vercel" {
  team = var.team
}
