# The website + in-browser app (marketing at /, tool at /app).
#
# vercel.json in the repository is what actually drives each build; the
# commands below mirror it so the project settings say the same thing. Keep
# the two in step. Headers, the CSP and `git.deploymentEnabled.master: false`
# live in vercel.json only.
#
# The settings this file exists for: Production Branch = `production`
# (DEPLOYMENT.md §1), Framework Preset = Other, Root Directory = repo root.

resource "vercel_project" "coretools" {
  name = var.project_name

  # framework is omitted on purpose: that is Vercel's "Other" preset, so
  # Vercel doesn't auto-detect the root Vite app and serve only the tool.

  # null = the repository root, not website/ (build-web.mjs assembles dist/).
  root_directory = null

  install_command  = "npm ci --include=dev"
  build_command    = "npm run build:web"
  output_directory = "dist"

  git_repository = {
    type              = "github"
    repo              = var.git_repository
    production_branch = var.production_branch
  }

  lifecycle {
    # Destroying the project takes the public site and its URL offline.
    prevent_destroy = true
  }
}
