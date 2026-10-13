# CoreTools infrastructure as code

> **Status: not applied.** CoreTools runs on free services only, so this is
> kept as documentation of the intended settings, not applied. Parts of it
> need paid plans (GitHub Pro for the rulesets, billing for Cloud Monitoring
> alerts); those are accepted risks — see DEPLOYMENT.md → "Accepted risks
> (free tier)". Nothing here runs automatically, and it needs no remote state
> storage: state stays local and git-ignored if it is ever applied.

Terraform for the settings CoreTools depends on outside its own code:
repository protection on GitHub, the Google Cloud project behind Drive
backup, and the Vercel project that serves the site. It covers audit
findings F-04, F-16, F-24 and F-25.

Nothing here has been applied. Until you run `terraform apply`, the live
settings are whatever was configured by hand (DEPLOYMENT.md).

| Directory | Provider (pinned) | Manages | Credentials |
| --- | --- | --- | --- |
| [`github/`](github) | `integrations/github ~> 6.13` | `master` rulesets, `v*` tag ruleset, `release` environment + `v*` deployment policy; checks that the Actions secrets exist | `GITHUB_TOKEN` |
| [`google/`](google) | `hashicorp/google ~> 8.6` | Drive + Monitoring APIs, a lien blocking project deletion (F-24), an email channel, four Drive API alert policies, optional dev project (F-25) | gcloud ADC |
| [`vercel/`](vercel) | `vercel/vercel ~> 5.21` | The Vercel project: production branch `production`, root directory, build/install/output commands | `VERCEL_API_TOKEN` |

The three directories are separate root modules, each with its own state,
so a GitHub change can never touch Google or Vercel and each one needs only
its own credentials. `.terraform.lock.hcl` in each pins the exact provider
build (with hashes for every platform); commit it.

## Prerequisites

- **Terraform 1.6 or newer, 64-bit build** (`terraform -version` should say
  `windows_amd64`, `linux_amd64` or `darwin_arm64`). The 32-bit
  `windows_386` build on the maintainer's machine crashes while loading
  these providers (`exit status 0xc0000409`).
- **GitHub Pro** (or Team/Enterprise) on the account that owns
  `jaychandra1/coretools`: rulesets and environment deployment policies on a
  *private* repository need it. See [Limits](#limits) for required reviewers.
- **gcloud CLI** for Google, signed in as an Owner of the production project.
- Optional: **gh CLI** for the import commands below (run them in Git Bash;
  the `--jq` filters don't survive PowerShell quoting).

## Workflow (each directory)

```bash
cd infra/terraform/<github|google|vercel>
cp terraform.tfvars.example terraform.tfvars   # google: required; others: optional
terraform init
terraform plan -out=tfplan        # read it: "will be created / updated in-place" only
terraform apply tfplan
```

If a plan ever shows `must be replaced` (`-/+`) or `destroy` for something
that exists, stop and import it instead (below). The Vercel project, the
lien and the enabled APIs carry `prevent_destroy`, so Terraform refuses to
delete them rather than doing it silently.

### State

State stays local (`terraform.tfstate`, git-ignored). It holds resource ids,
the alert email address and settings, and no secrets, because no resource
here has a secret value. Keep a copy somewhere private (a password manager
attachment is fine). If it's lost, nothing breaks: re-run the imports below
and `plan` shows no changes. To share it later, add a `backend` block (for
example HCP Terraform's free tier; a GCS bucket needs a billing account).

## GitHub

**Token.** A fine-grained personal access token, *Only select repositories →
`jaychandra1/coretools`*, with **Administration: Read and write** and
**Secrets: Read-only** (Metadata read is automatic), expiry 7 days. Revoke it
when you're done.

```powershell
$env:GITHUB_TOKEN = "<token>"      # PowerShell
# export GITHUB_TOKEN=<token>      # bash
```

Without `GITHUB_TOKEN` the provider falls back to `gh auth token`.

**What it sets up**

- `master: pull request + code-owner review`: pull request required, one
  approval, *Require review from Code Owners*, stale approvals dismissed.
  Bypass: repository admin (you) **for pull requests only**, so you can
  merge your own PR, but nobody can push to `master` directly.
- `master: required checks, no force push, no deletion`: the four `ci.yml`
  checks (`Type-check, unit tests, dependency audit`, `End-to-end smoke tests
  (browser)`, `Rust lint (clippy), tests and format`, `Rust build check
  (Windows)`), which must come from the
  GitHub Actions app; force pushes and deletion blocked. **No bypass.**
  This is a separate ruleset because a bypass applies to every rule in a
  ruleset: with one combined ruleset, your PR bypass would also let you
  merge with red CI.
- `release tags (v*)`: creating, moving and deleting `v*` tags is restricted
  to the repository admin and, while `github_actions_creates_release_tags`
  is `true` (the default), the GitHub Actions app (id 15368). `ci.yml`'s
  `tag-release` job pushes the tag for a merged release pull request with
  `GITHUB_TOKEN` and needs that bypass. If GitHub refuses GitHub Actions as a
  bypass actor on your plan, or you only tag by hand (`npm version` + `git
  push --follow-tags`), set it to `false`.
- Environment `release`: only `v*` tags may deploy to it, admins can't
  bypass it, and `release_reviewers` must approve each publish (but see
  [Limits](#limits)). release.yml's third mode, *Run workflow on master* to
  re-publish `package.json`'s version, is refused at the publish job unless
  you set `release_branch_patterns = ["master"]`. Re-publishing from the tag
  (`gh workflow run release.yml --ref vX.Y.Z`) works either way.
- `secrets.tf` warns on plan if `ARTIFACTS_REPO_TOKEN`,
  `CORETOOLS_GOOGLE_CLIENT_ID` or `CORETOOLS_GOOGLE_CLIENT_SECRET` is
  missing, or if `ARTIFACTS_REPO_TOKEN` was last set more than 90 days ago.
  It reads names and dates only; values never pass through Terraform.

> If you rename a job in `ci.yml`, change `required_status_checks` and apply
> **before** merging the rename, or every pull request waits forever for the
> old check name.

> Once these rulesets are active, nothing can be pushed straight to
> `master`, the owner included. The documented manual release
> (`npm version X.Y.Z` then `git push origin HEAD --follow-tags`) is
> rejected because it pushes the version commit to `master`. Release
> through **Actions → Prepare release** and merge its pull request. To tag
> by hand, merge the version bump through a pull request first, then push
> only the tag (`git tag -a vX.Y.Z -m "release: vX.Y.Z" && git push origin vX.Y.Z`).

**Importing what already exists.** List what's there:

```bash
gh api repos/jaychandra1/coretools/rulesets --jq '.[] | "\(.id)\t\(.target)\t\(.name)"'
gh api repos/jaychandra1/coretools/environments/release/deployment-branch-policies \
  --jq '.branch_policies[] | "\(.id)\t\(.type)\t\(.name)"'
```

Then, for each one that exists:

```bash
terraform import github_repository_ruleset.master_review     coretools:<id of the master ruleset>
terraform import github_repository_ruleset.release_tags      coretools:<id of the v* tag ruleset>
terraform import github_repository_environment.release       coretools:release
terraform import github_repository_environment_deployment_policy.release_tags coretools:release:<policy id>
```

If you followed DEPLOYMENT.md, `master` has **one** ruleset holding both
the review and the checks. Import it as `master_review` and create the
checks ruleset first, so `master` is never without required checks:

```bash
terraform apply -target=github_repository_ruleset.master_integrity
terraform apply        # then renames the old ruleset and drops its check/force-push rules
```

Instead of `terraform import`, you can put `import { to = …  id = "…" }`
blocks in a temporary `imports.tf` (git-ignored), run `plan`/`apply`, then
delete the file. That avoids shell quoting on PowerShell.

## Google

**Credentials.** Application Default Credentials from your own account
(an Owner of the production project):

```bash
gcloud auth application-default login
# Usually already enabled; Terraform needs them to manage anything else:
gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com --project <project_id>
```

The provider sends `X-Goog-User-Project: <project_id>`
(`user_project_override`), so no separate ADC quota project is needed.
Creating the optional dev project also needs permission to create
projects (any personal Google account has it, up to its project quota).

**`terraform.tfvars`.** `project_id` is the project that owns the OAuth
client in `CORETOOLS_GOOGLE_CLIENT_ID` (console → project picker → *ID*).
`alert_email` receives alerts.

**What it sets up**

- `drive.googleapis.com` and `monitoring.googleapis.com` enabled, with
  `disable_on_destroy = false`: Terraform never turns an API off.
- **Lien (F-24)** with restriction `resourcemanager.projects.delete`.
  Deleting the project then fails, for Owners too, until someone removes
  the lien (`resourcemanager.projects.updateLiens`). It doesn't protect
  against Google *suspending* the project.
- **Email notification channel** to `alert_email`.
- **Alert policies** on the Drive API, all filtered to
  `service="drive.googleapis.com"`:

  | Policy | Query | Default |
  | --- | --- | --- |
  | Drive API 5xx ratio | `api/request_count` with `response_code_class="5xx"` ÷ all requests over 30 min, **and** at least 5 failures | > 5% |
  | Drive API 403/429 ratio | `api/request_count` with `response_code` 403 or 429 ÷ all, **and** at least 5 | > 10% |
  | Drive API quota usage | `increase(quota/rate/net_usage[1m])` ÷ `quota/limit` (per-minute limits, per-user limits excluded), by `quota_metric`, for 5 min | > 70% |
  | Drive API quota exceeded | `quota/exceeded` true (`ALIGN_COUNT_TRUE`), any limit | > 0 |

  The ratios are PromQL, the form Google's quota-alerting guide uses; the
  last one is a plain metric threshold and works even if the ratio can't be
  computed. `request_count` data can arrive up to 30 minutes late, so these
  alerts are for sustained trouble, which matches the app's own retry
  back-off.
- **Optional dev project (F-25):** `create_dev_project = true` plus
  `dev_project_id` creates a second project with only the Drive API
  enabled. Use it for local and preview builds (see "What stays manual").
  Backups made by a dev build live in the dev project's appDataFolder and
  are invisible to release builds, and the reverse.

**Before relying on the quota alert**, look up the Drive limit names. In
Metrics Explorer → PromQL, run:

```promql
max by (limit_name, quota_metric) ({"serviceruntime.googleapis.com/quota/limit", monitored_resource="consumer_quota", service="drive.googleapis.com"})
```

If the project-level per-minute limit is, say, `defaultPerMinutePerProject`,
set `quota_limit_name_regex = "defaultPerMinutePerProject"`. Pasting each
policy's query into the same tab (without the final comparison) shows
whether it returns data.

**Importing.** Nothing needs importing in an existing project: enabling an
API that's already on is a no-op, and the channel and policies are new. If
you already created a lien by hand, a second one is harmless; delete the
manual one afterwards if you like
(`gcloud alpha resource-manager liens list` / `… liens delete <name>`). If
you created the dev project by hand:

```bash
terraform import 'google_project.dev[0]' <dev_project_id>
```

**Cost.** The APIs, lien, metrics and email channel are free. Cloud
Monitoring started charging for alerting policies no sooner than
1 May 2026 (per condition per month, plus per time series returned; four
conditions here). Check the current price on Google's Cloud Monitoring
pricing page. If the project has no billing account and Google refuses
the policies, either link one or set `enable_alerting = false`.

## Vercel

**Token.** Vercel → Account Settings → Tokens → create one scoped to the
team that owns the project, with a short expiry.

```powershell
$env:VERCEL_API_TOKEN = "<token>"
```

Set `team` in `terraform.tfvars` (Team Settings → General → *Team ID*) if the
token can see more than one team.

**What it sets up:** project `coretools`, Framework Preset *Other*
(`framework` omitted), Root Directory = repository root, install
`npm ci --include=dev`, build `npm run build:web`, output `dist` (all
mirroring `vercel.json`), Git repository `jaychandra1/coretools` with
**Production Branch `production`**. Headers, the CSP and
`git.deploymentEnabled.master: false` stay in `vercel.json`.

**Importing** (the project certainly exists). Project → Settings → General
→ *Project ID*:

```bash
terraform import vercel_project.coretools <team_id>/<prj_id>
terraform plan
```

The provider gives some settings defaults when they're not in the config
(for example `auto_assign_custom_domains`, `git_fork_protection`,
`vercel_authentication`). If the first plan wants to change one of those,
copy the current value into `main.tf` rather than letting Terraform flip it.

## What stays manual

### Google OAuth consent screen and client

Google offers no API for the OAuth consent screen ("Google Auth Platform")
or for Desktop-app OAuth clients of an app outside a Google Workspace
organization. `google_iap_brand` and `google_iap_client` only create
*Internal* brands for Identity-Aware Proxy, can't create a Desktop client,
and sit on an IAP OAuth Admin API that Google has deprecated. So these
steps stay in the console. Do them once for production (already done;
re-check the settings) and once more in the dev project if you create one.

1. <https://console.cloud.google.com> → pick the project → **Google Auth
   Platform** → **Get started** (older consoles: *APIs & Services → OAuth
   consent screen*).
2. **Branding:** App name `CoreTools`; user support email; developer contact
   email. Leave the **logo empty**: a logo sends the app through Google's
   brand verification. App-domain links are optional for these scopes and
   need an authorized domain you own (a `*.vercel.app` address can't be one).
3. **Audience:** *External*.
   - Production: **Publish app** → status *In production*. In *Testing*,
     only listed test users can sign in and their sign-in expires after
     7 days.
   - Dev: stay in *Testing* and add your own Google accounts under *Test
     users*. Reconnecting weekly is fine for development.
4. **Data access → Add or remove scopes:** `openid`,
   `.../auth/userinfo.email`, `.../auth/drive.appdata`. All three are
   non-sensitive, so no app verification is needed. Add nothing else.
5. **Clients → Create client → Application type: Desktop app**, named e.g.
   `CoreTools desktop (prod)` / `(dev)`. No redirect URI: Desktop clients
   accept the app's `http://127.0.0.1:<port>` loopback redirect. **Copy the
   client secret now**; the console shows it only once.
6. Wire it in:
   - Production: GitHub → `jaychandra1/coretools` → Settings → Secrets and
     variables → Actions → `CORETOOLS_GOOGLE_CLIENT_ID` and
     `CORETOOLS_GOOGLE_CLIENT_SECRET`. Takes effect from the next release.
   - Dev: **never** as GitHub secrets. Set them only in the shell that runs
     local builds:

     ```powershell
     $env:CORETOOLS_GOOGLE_CLIENT_ID = "<dev client id>"
     $env:CORETOOLS_GOOGLE_CLIENT_SECRET = "<dev client secret>"
     npm run tauri dev
     ```
7. Google deletes OAuth clients with no token exchange for six months
   (restorable for 30 days after it notifies you). A dev client that sits
   idle will disappear; restore it or create a new one.

Don't rotate or disable the **production** client secret casually: every
installed copy has it compiled in, and refreshing tokens with a disabled
secret fails (the app then reports cloud backup as not configured). Rotate
only after a new release ships with the new secret, or in an incident
(docs/runbooks).

### Everything else

| Item | Where | Why not Terraform |
| --- | --- | --- |
| Values of `ARTIFACTS_REPO_TOKEN`, `CORETOOLS_GOOGLE_CLIENT_ID/SECRET` | GitHub → Settings → Secrets and variables → Actions | Managing a secret puts its value in state. `secrets.tf` checks they exist. |
| The fine-grained PAT behind `ARTIFACTS_REPO_TOKEN` | GitHub → Settings → Developer settings | GitHub has no API to create PATs. |
| Private vulnerability reporting on **`jaychandra1/artifacts`** | Settings → Code security → *Private vulnerability reporting* → Enable, or `gh api -X PUT repos/jaychandra1/artifacts/private-vulnerability-reporting` | Managing that repository would mean importing all of its settings; one toggle doesn't justify it. `website/.well-known/security.txt` and `security.html` send reporters there. |
| The `jaychandra1/artifacts` repository itself | GitHub | The publish job pushes to its `main` with the PAT; a ruleset there would need to allow that. |
| A ruleset on the `production` branch | GitHub | `ci.yml`'s `promote-web` force-moves it with `GITHUB_TOKEN`; protecting it needs a bypass for GitHub Actions. Revisit separately. |
| GitHub plan; Vercel GitHub app access to the private repo | Account settings | Account-level, not resources. |
| Drive API quota increases | IAM & Admin → Quotas & System Limits → Drive API → *Edit quota* | Requests go through Google review; Terraform can only lower quotas. |
| Billing account link (if alerting needs it) | Billing | Account-level. |
| Vercel Instant Rollback | Vercel dashboard / `vercel rollback` | An operational action (docs/runbooks/bad-release.md). |

## Limits

- **Required reviewers on the `release` environment need GitHub
  Enterprise Cloud for a private repository.** On Free, Pro and Team they
  only work on public repositories, and GitHub rejects them. Pro still
  gives you the rulesets and the `v*` deployment policy. If `apply` fails
  on the reviewers, set `release_reviewers = []`. The publish gate is then:
  only you, or CI's `tag-release` job after every gate passed, can create
  `v*` tags (tag ruleset); only `v*` tag runs can reach the `release`
  environment (deployment policy); the tagged commit must be on `master`
  (release.yml); and `master` only takes reviewed, green changes
  (rulesets). The `release.yml` comments and DEPLOYMENT.md step 3 assume an
  approval pause that GitHub won't enforce in that case.
- The lien blocks deletion through the API and console. It does nothing
  against a suspension by Google, a lost Google account, or the OAuth client
  being deleted (clients aren't covered by project liens).
- Alerts reach one email address. There is no on-call rotation.
