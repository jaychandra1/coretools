# Deployment & Downloads

This explains how the public site is served and how to publish real,
downloadable installers ("setup files") for CoreTools.

## What lives where

CoreTools is one repo with two deliverables:

| Path in repo | What it is | Where it ends up |
| --- | --- | --- |
| `/` (`src`, `index.html`, `vite.config.ts`) | The **tool app** (Svelte) | Web deploy at **`/app`**, and the Tauri desktop bundle |
| `website/` | The **marketing / product page** (static HTML) | Web deploy at **`/`** |
| `src-tauri/` | The native desktop shell (Rust) | The installers you download & run |

## 1. The website (Vercel) — landing page + in-browser app

Previously Vercel auto-detected the root Vite app and served **only the tool**
at your URL. The included **`vercel.json`** fixes this so a single deploy serves
both:

- **`https://<your-site>/`** → the marketing landing page
- **`https://<your-site>/app`** → the actual tool, usable right in the browser

### How it works

`vercel.json` runs `npm run build:web`, which:

1. `vite build --mode web` → builds the app into `dist/app/` (with base `/app/`).
2. `node scripts/build-web.mjs` → copies `website/` into `dist/` root.

Result: `dist/` (marketing) + `dist/app/` (tool) → Vercel serves it as
`outputDirectory: dist`.

### How the site deploys (only after CI passes)

Vercel does **not** deploy `master` directly: `vercel.json` sets
`git.deploymentEnabled.master: false`. When a push to `master` passes CI's
web checks (types, tests, audit, the no-test-code guard), the `promote-web`
job in `ci.yml` moves a **`production`** branch to that commit. Vercel
deploys `production`. A commit that fails CI never reaches the public site.

> **One-time Vercel setting — do it before merging a `vercel.json` with that
> `git` block:** Project → Settings → Git → **Production Branch =
> `production`**. Without it, Vercel still treats `master` as production.
> With master deployments disabled, the site would then stop updating. The
> first green push to `master` creates the `production` branch.

After a green push, confirm:

- `/` shows the landing page, with the version and sizes of the newest
  published release (read from `coretools/releases/latest.json`).
- `/app` shows the tool.

> **Check the Vercel project settings** once: Build & Development Settings should
> be "Other" / respect `vercel.json` (Framework Preset = **Other**, or leave
> Vercel to read `vercel.json`). Root Directory must be the repo root (not
> `website`).

The build was verified locally — `npm run build:web` produces:

```
dist/index.html          ← landing page
dist/styles/…  dist/scripts/…
dist/app/index.html      ← tool app
dist/app/assets/…
```

## 2. The downloadable installers ("setup files")

A real `.exe` / `.dmg` / `.AppImage` is compiled native code produced by
**`tauri build`**, which needs **Rust** and must run **on each target OS**. This
can't happen on Vercel (web-only) — Vercel only builds web assets.

### How installers are released (release PR → tag → signed publish)

Three workflows own quality and distribution:

- **`.github/workflows/ci.yml`** — every push/PR: `svelte-check`, the vitest
  suite (including the vault and backup state machines against a real
  IndexedDB), a production `npm audit` (must be clean), a version-drift
  check, a guard against temporary test code, **browser end-to-end tests** of
  the production web build (Playwright), `cargo clippy` + `cargo test` on
  Linux, and a `cargo check` on Windows (Windows Hello, WebView2 and the
  secure clipboard only compile there; it does real work only when Rust code
  changed). Once `Cargo.lock` is committed, every Rust job verifies it. On
  `master` it moves the `production` branch for the website (§1) and, when
  `package.json` carries a version that has no tag yet, tags it and starts
  the release.
- **`.github/workflows/prepare-release.yml`** — opens the release pull request.
- **`.github/workflows/release.yml`** — builds, signs and publishes a tag.

**Cutting a release.** Write notes under `## [Unreleased]` in `CHANGELOG.md`
as you go. To release, run **Actions → Prepare release → Run workflow** from
`master` with the new version (e.g. `1.2.0`). It bumps the version in
`package.json`, `package-lock.json`, `Cargo.toml`, `tauri.conf.json` and
`website/scripts/downloads.js` (and `Cargo.lock` once committed), moves the
Unreleased notes under `## [1.2.0] — <date>`, and opens a `release: v1.2.0`
pull request; it refuses to run when there are no notes. Review and merge
that PR. Once CI passes on `master`, its **tag-release** job tags the merge
commit `v1.2.0` and starts the Release workflow on that tag (a tag created by
Actions can't trigger workflows by itself).

Where `master` accepts direct pushes (no ruleset), the manual path also
works:

```bash
npm version 1.2.0 -m "release: v%s"
git push origin HEAD --follow-tags
```

`npm version` does the whole cut through `package.json`'s hooks:
`preversion` stops it before any file changes when `## [Unreleased]` has no
notes, and `version` syncs every version string and moves the notes under
`## [1.2.0] — <today>`, all in the `release: v1.2.0` commit and tag.

The release workflow then:

1. Re-runs the quality gates. It **refuses** a tag that doesn't match
   `package.json`, a commit that isn't on `master`, and a version whose
   `CHANGELOG.md` section is missing or empty.
2. Builds on **Windows, macOS, and Linux** runners — **code-signed** for each
   platform whose signing credentials exist (§3) — and a CycloneDX **SBOM**.
3. Publishes **all three or nothing** — a failed platform build fails the
   release; no mixed-version download sets.
4. Runs the publish job in the `release` environment (an approval pause where
   your GitHub plan supports it — see "Repository protection" below).
5. **Signs `SHA256SUMS.txt` with Sigstore** (keyless, bound to this
   workflow and tag). The checksums cover the installers and the SBOM.
6. Publishes to the **public** repository
   [`jaychandra1/artifacts`](https://github.com/jaychandra1/artifacts). This
   source repo stays private. Stable asset names (`CoreTools-Windows-Setup.exe`,
   `CoreTools-macOS.dmg`, `CoreTools-Linux.AppImage`, `CoreTools-sbom.cdx.json`)
   plus `SHA256SUMS.txt` and its signature bundle.

**SBOM.** Every release publishes `CoreTools-sbom.cdx.json`, a CycloneDX
software bill of materials: the npm dependencies (from `package-lock.json`,
via `npm sbom`) and the Rust crates for every target platform (from
`src-tauri/Cargo.lock`, via `cargo-cyclonedx`). It is listed in
`SHA256SUMS.txt`, so the Sigstore signature covers it. Until `Cargo.lock`
is committed, the Rust part is resolved at release time and marked
`coretools:cargo-lock = resolved-at-release`.

**Dependabot auto-merge.** Dependabot proposes updates weekly, grouped per
ecosystem, once a release is at least 3 days old. Pull requests where every
update is a semver patch, or a GitHub Actions minor/patch, get auto-merge
(squash); everything else needs a manual merge. Auto-merge still waits for CI
(and a Code Owner approval where required). Those merges don't start CI on
`master`: the website is promoted with the next push, or run **Actions → CI →
Run workflow** on `master`. Needs: Settings → General → *Allow auto-merge*,
and Settings → Actions → General → *Allow GitHub Actions to create and approve
pull requests* (also used by Prepare release).

### Where releases live: `jaychandra1/artifacts`

One public repo serves the downloads for **several applications**. Code stays
in each app's private repo; only installers and a generated index go public.
For CoreTools each release produces:

| What | Example | Notes |
| --- | --- | --- |
| Versioned release | tag `coretools-v0.3.0` | Kept forever; notes come from this version's `CHANGELOG.md` section |
| Stable "latest" release | tag `coretools-latest` | Same files, replaced on each **newer** release (an older hotfix never moves it) |
| Index folder | `coretools/releases/` | `README.md` (latest links, SHA-256, every version), `latest.json`, `index.json` |
| Root README | `README.md` | Table of all apps, between `<!-- apps:start/end -->` markers |

Stable link the website uses (never changes):
`https://github.com/jaychandra1/artifacts/releases/download/coretools-latest/CoreTools-Windows-Setup.exe`.
Any version:
`https://github.com/jaychandra1/artifacts/releases/download/coretools-v0.3.0/CoreTools-Windows-Setup.exe`.

The installers are **release assets, not git files**. The artifacts repo
stays a few KB however many apps and versions it holds, assets can be up to
2 GB each, and downloads have no bandwidth quota. The old per-push flow
committed binaries and grew `.git` by ~90 MB per release; tag-only releases
also keep macOS CI minutes (billed at 10×) for actual releases.

The publishing logic is a reusable local action
(`.github/actions/publish-artifacts`) plus an app-agnostic script
(`scripts/artifacts-release.mjs`). To publish another app to the same repo,
copy both and call the action with that app's slug and name. Concurrent
publishes from different apps are safe: the index commit regenerates and
retries if another app pushed first.

**One-time setup: the `ARTIFACTS_REPO_TOKEN` secret.** In GitHub, create a
**fine-grained personal access token** (Settings → Developer settings →
Personal access tokens → Fine-grained):
- Repository access: **Only select repositories → `jaychandra1/artifacts`**.
- Permissions: **Contents: Read and write**. That covers creating releases,
  uploading assets and pushing the index.
- Expiry: **90 days or less**. The release fails with a clear error when it
  lapses — renew it then. A short-lived token limits the damage if it ever
  leaks, and the Sigstore signature means a leaked token still can't
  produce installers that verify.

Add it to **this** (private) repo under Settings → Secrets and variables →
Actions as **`ARTIFACTS_REPO_TOKEN`**. The artifacts repo can start completely
empty; the first publish initializes it.

**Keeping old releases.** Every version stays published; nothing is pruned.
Builds from before tagged releases (committed to `website/downloads/` by the
old flow, all labelled 0.1.0) can be imported once with **Actions → Import old
release → Run workflow**. The defaults publish the final pre-0.2.0 build
(commit `8f016a5`, 2 Sep 2026) as `coretools-v0.1.0`, after checking its
committed SHA-256 sums. It won't move the `coretools-latest` links if newer
versions exist. (0.2.0 was never built, so there is no 0.2.0 download.)

All workflow actions are **pinned to commit SHAs**, this repo's `GITHUB_TOKEN`
is read-only in every job (publishing uses the scoped token above), and
Dependabot (`.github/dependabot.yml`) keeps npm, cargo, and the pinned actions
patched.

### Verifying a download

Releases signed by this workflow ship `SHA256SUMS.txt.sigstore.json`.
With [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
installed, download it together with `SHA256SUMS.txt` and the installer,
then run:

```bash
cosign verify-blob SHA256SUMS.txt --bundle SHA256SUMS.txt.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/jaychandra1/coretools/\.github/workflows/release\.yml@refs/(tags/v.+|heads/master)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum --check --ignore-missing SHA256SUMS.txt
```

The release notes and `coretools/releases/README.md` print the same command.

### Repository protection (one-time, in GitHub settings)

The workflows assume these settings; without them, the gates above are
advisory. They are also written as Terraform in `infra/terraform/github/`
(see "Infrastructure as code" below).

> **What your GitHub plan allows on a private repository.** Rulesets (and
> classic branch protection) need **GitHub Pro** (or Team/Enterprise).
> Environments with branch/tag rules need Pro too. **Required reviewers on an
> environment need GitHub Enterprise** on a private repository — on Free,
> Pro and Team they work only for public repositories. Without them, the
> "approve each publish" pause below doesn't happen; the Sigstore signature
> (bound to this repository's release workflow and a `v*` tag) and the
> other release gates still apply.

1. **Protect `master`** — Settings → Rules → Rulesets. Use two rulesets so
   your bypass can't skip CI:
   - *Require a pull request before merging* with *Require review from Code
     Owners* (`.github/CODEOWNERS` names the owner); bypass: you, **for pull
     requests only**.
   - *Require status checks to pass* — `Type-check, unit tests, dependency
     audit`, `End-to-end smoke tests (browser)`, `Rust lint (clippy), tests
     and format` and `Rust build check (Windows)`, from the GitHub Actions
     app — plus *Block force pushes* and *Restrict deletions*; no bypass.

   With these on, releases go through **Prepare release** (the manual
   `npm version` push to `master` is refused).
2. **Protect release tags** — New tag ruleset, target `v*`: *Restrict
   updates* and *Restrict deletions*, and *Restrict creations* with you and
   **GitHub Actions** on the bypass list (the tag-release job creates tags).
   If GitHub Actions can't be added as a bypass actor, leave *Restrict
   creations* off.
3. **Approve each publish** — Settings → Environments → New environment
   `release` → *Deployment branches and tags*: tags matching `v*`; and,
   where your plan offers it, *Required reviewers*: yourself.
4. **Generate `Cargo.lock`** — Actions → **Generate Cargo.lock** → Run
   workflow, then open the pull request it links and merge it. From then on
   CI and releases build exactly the locked dependency set.
5. **Allow Actions to open pull requests and enable auto-merge** (see
   "Dependabot auto-merge" above).

### Infrastructure as code

The repository, Google Cloud and Vercel settings this page describes as
one-time clicks are also kept as Terraform under `infra/terraform/`, in three
root modules with separate state and credentials:

- `github/` holds the `master` rulesets, the `v*` tag ruleset, and the
  `release` environment with a deployment policy that only accepts `v*`
  tags. At plan time it checks that the Actions secrets exist and that
  `ARTIFACTS_REPO_TOKEN` is under 90 days old; secret values never pass
  through Terraform.
- `google/` holds the APIs, the deletion lien, alerting and an optional dev
  project.
- `vercel/` holds Production Branch `production`, Framework Other, the
  repo-root build and the `vercel.json` commands.

Provider versions are pinned and locked. Nothing applies automatically: you
import what already exists, then run `terraform plan` and `apply` locally.
`infra/terraform/README.md` lists the import commands and what has to stay
manual — chiefly the Google OAuth consent screen and the Desktop OAuth client.

### Google project protection and alerting

A Resource Manager lien on `resourcemanager.projects.delete` makes the
production Google Cloud project impossible to delete, even for an Owner,
until someone deliberately removes the lien (audit F-24). That matters
because each user's backups live in a Drive appDataFolder that only this
project's OAuth clients can read. As a second line, every section can export
an **encrypted backup file** that restores without Google at all.

Cloud Monitoring emails the owner when, over 30 minutes with at least five
failures, more than 5% of Drive API requests fail with 5xx or more than 10%
get 403/429; when a per-minute Drive rate quota stays above 70% of its limit
for five minutes; or when a quota is exceeded. Google charges for alerting
policies from 1 May 2026, so the project may need a billing account (or set
`enable_alerting = false`).

Local and preview builds can use a separate dev project with its own OAuth
client (`create_dev_project`, audit F-25), so development never spends
production quota; backups made that way live only in the dev project.

Runbooks for project loss, a pipeline compromise, a bad release and Drive
outages are in `docs/runbooks/`.

> **Optional:** purge the historical binaries from git history
> (`git filter-repo --path website/downloads --invert-paths` + coordinated
> force-push) to reclaim the ~680 MB `.git`.

### Faster: build a Windows installer locally (Windows only)

On this machine you can build the Windows installer yourself:

```bash
# 1. Install Rust (one-time): https://rustup.rs  → run rustup-init.exe
#    Also ensure "Microsoft Visual Studio C++ Build Tools" are installed.

# 2. Build:
npm install
npm run tauri build
```

Output installers appear under:

```
src-tauri/target/release/bundle/msi/CoreTools_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/CoreTools_0.1.0_x64-setup.exe
```

Double-click either to install. (This machine can only build the **Windows**
installer; macOS/Linux builds require those OSes — use the tag-triggered
release workflow for all three.) Locally-built installers are for your own
testing; distribution goes through GitHub Releases so every published binary
has a version, release notes, and a checksum file.

## 3. SmartScreen blocks & code signing

### Why downloads get flagged

The installer is **unsigned**, and Microsoft SmartScreen judges unsigned files
by the reputation of the **exact file hash**. Every CI build produces a new
hash with zero reputation, so any release can be labeled "unverified" or
"suspicious download blocked" — which build trips it is essentially luck.
Three factors stack against us:

1. No Authenticode signature (the dominant factor).
2. NSIS installers draw extra heuristic suspicion (malware often uses NSIS).
3. A shared `*.vercel.app` subdomain carries no domain reputation.

### The real fix: sign the Windows installer

Reputation attaches to the **signing certificate**, so it persists across
releases. Options, cheapest first:

| Option | Cost (approx.) | SmartScreen effect |
| --- | --- | --- |
| **Azure Trusted Signing** | ~$10/month | Signed + Microsoft-managed identity; reputation builds quickly. Tauri supports it via `bundle.windows.signCommand` (use `trusted-signing-cli`). Requires identity validation (org, or individual where available). |
| **OV certificate** (Sectigo, SSL.com, …) | ~$100–400/yr | Signed; reputation builds over weeks of downloads. |
| **EV certificate** | ~$250–700/yr | Near-instant SmartScreen reputation. |

**Already wired in `release.yml`** — it signs a platform's installer once all
of that platform's credentials exist, and builds it unsigned otherwise. A
half-configured platform fails the release instead of quietly shipping
unsigned.

- **Windows** — Azure Artifact Signing (the new name of Trusted Signing), via
  `artifact-signing-cli` as Tauri's `signCommand`. Repository secrets
  `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` (an app
  registration with the certificate-profile signer role) and repository
  variables `AZURE_ARTIFACT_SIGNING_ENDPOINT` (e.g.
  `https://eus.codesigning.azure.net`), `AZURE_ARTIFACT_SIGNING_ACCOUNT`,
  `AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE`.
- **macOS** — Developer ID ($99/yr) + notarization. Repository secrets
  `APPLE_CERTIFICATE` (`openssl base64 -A -in DeveloperIDApplication.p12`),
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`
  (app-specific), `APPLE_TEAM_ID`, optionally `APPLE_SIGNING_IDENTITY`.

Signed platforms compile without the credentials in the environment, then
bundle and sign in a separate step; the signature is verified before upload,
and the release notes say which installers are signed. The Linux AppImage
stays unsigned; the signed `SHA256SUMS.txt` covers it. To trial signing
safely: add the credentials, run Actions → Release on `master`, check the
build logs, and let the environment policy stop the publish.

### Mitigations until you sign

- **Report false positives to Microsoft** (helps the *current* build only):
  submit the `.exe` at <https://www.microsoft.com/en-us/wdsi/filesubmission>
  as a developer; in Edge you can also right-click the blocked download →
  *Report this file as safe*.
- The download page explains the warning, points users at each release's
  `SHA256SUMS.txt`, and deliberately does **not** walk them through bypassing
  SmartScreen — the guidance is: verify the checksum or use the in-browser app.
- A **custom domain** (instead of `*.vercel.app`) modestly improves URL
  reputation.
- Releases are already tag-only, so each installer hash lives long enough to
  accumulate reputation instead of being replaced on every push.

## 4. Cloud backup: Google sign-in setup

The Authenticator's Google Drive backup needs a Google **OAuth client**. Its id
is compiled into the desktop app at build time. Without it, the build still
succeeds and the feature simply says "not configured in this build".

**Cost: none.** You need a Google account, but no billing account or credit
card. Creating a Cloud project, enabling the Drive API and creating an OAuth
client are all free; if the console offers a "free trial", you can dismiss
it. Each user's backups (a few KB each) count against *their own* Drive
storage, not yours.

### One-time setup (about 10 minutes)

1. Go to <https://console.cloud.google.com>, sign in, and **create a project**
   (e.g. "CoreTools").
2. **APIs & Services → Library →** search **Google Drive API → Enable**.
3. **Google Auth Platform** (older consoles: *OAuth consent screen*) →
   **Get started**: app name `CoreTools`, a user-support email,
   **Audience: External**, a developer contact email.
4. **Data access → Add or remove scopes**: add `openid`,
   `.../auth/userinfo.email` and `.../auth/drive.appdata`. All three are
   **non-sensitive**, so Google's app verification isn't required. Skip
   uploading a logo for now, because a logo sends the app through Google's
   brand verification.
5. **Clients → Create client → Application type: Desktop app** → copy the
   **Client ID** and **Client secret**. No redirect URI is needed, because
   desktop clients accept the app's `http://127.0.0.1:<port>` loopback
   redirect automatically.
6. **Audience → Publish app** (status *In production*). **Don't skip this:**
   while the app is in *Testing*, only listed test users can sign in, and
   Google expires their sign-in after **7 days**, so everyone's backups would
   stop weekly with "reconnect".

### Wire it into releases

In GitHub: **Settings → Secrets and variables → Actions → New repository
secret**:

| Secret | Value |
| --- | --- |
| `CORETOOLS_GOOGLE_CLIENT_ID` | the Client ID (`…apps.googleusercontent.com`) |
| `CORETOOLS_GOOGLE_CLIENT_SECRET` | the Client secret |

`release.yml` passes both to `tauri build`. Google documents desktop-app
client secrets as *not confidential*, since they ship inside the app and PKCE
is what protects sign-in. Keeping them in secrets just keeps them out of the
repo.

Because the client is compiled in, **adding or changing the secrets only
takes effect in the next release** (`npm version patch -m "release: v%s"` →
`git push origin HEAD --follow-tags`). Installers built before that still
report "not configured".

### Local builds

Set the variables in the shell that runs the build (PowerShell shown):

```powershell
$env:CORETOOLS_GOOGLE_CLIENT_ID = "<client id>"
$env:CORETOOLS_GOOGLE_CLIENT_SECRET = "<client secret>"
npm run tauri build
```

`build.rs` declares both with `rerun-if-env-changed`, so changing them
triggers a rebuild. The browser build (`/app` on Vercel) never includes cloud
backup.

## Updates for installed copies

Installed copies learn about new releases through **opt-in update
notifications** (desktop): on first run the app asks once; when on, it reads
`coretools/releases/latest.json` from the public release repository when the
app opens and about once an hour while it's open (through Rust, one fixed URL,
nothing about the user sent) and shows a banner and an "Update x.y.z" pill.
To flag a release as a **security** update or show a one-line notice, add
`"security": true` / `"notice": "…"` to that version's `latest.json`; the
app renders them.

**Update now** installs the update inside the app: Tauri's updater downloads
this platform's file from the versioned release, verifies its signature
against the public key compiled into the app, installs it — on Windows as an
update (`/UPDATE`, so the vault is kept) — and restarts CoreTools. Nothing
happens until the user clicks. Without a signed update (updater key not set
up, or a build without the key) the button downloads this platform's
installer straight from the release instead.

### In-app updates: one-time key setup (free)

The updater key is a minisign key pair, separate from OS code signing (§3)
and free. Its private half signs every update file in CI; its public half is
compiled into the app, which installs only files that verify against it.

1. Generate it on your machine (it asks for a password; keep both safe):

   ```bash
   npx tauri signer generate -w ~/.tauri/coretools-updater.key
   ```

2. In `jaychandra1/coretools` → Settings → Secrets and variables → Actions:
   - **Secret** `TAURI_SIGNING_PRIVATE_KEY` — the contents of
     `~/.tauri/coretools-updater.key`.
   - **Secret** `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password.
   - **Variable** (Variables tab) `TAURI_UPDATER_PUBKEY` — the contents of
     `~/.tauri/coretools-updater.key.pub`.
3. Release as usual. The release gate refuses a half setup; the summary says
   "In-app updates: signed". Each release then also carries the update files'
   signatures (`*.sig`), `CoreTools-macOS.app.tar.gz`, and `updater.json` —
   the manifest installed copies poll at
   `https://github.com/jaychandra1/artifacts/releases/download/coretools-latest/updater.json`.

The first release built with the key is the first that can update itself;
copies installed before it keep downloading the installer, once. **Back up the
private key and password offline.** Losing the key means installed copies
can't verify later updates and must reinstall by hand once from a build with
a new key; leaking it means rotate it the same way and treat it like a
release-pipeline compromise (`docs/runbooks/release-pipeline-compromise.md`).
Local builds have no updater key, so they never update themselves.

- The app shows its version in the header (click it for *About &
  diagnostics*); each release lists changes in `CHANGELOG.md` and on its
  `coretools-v<version>` release in `jaychandra1/artifacts`.
- Users update with **Update now**, or by downloading the new installer over
  the old one; vault and JSON-Studio data live in the webview profile and
  survive both. **No
  downgrade past 1.2:** older versions can't open an upgraded vault.
- **Updates never delete the vault.** Installing over an older version runs
  that version's uninstaller; Tauri's stock installer opens it with its
  "Delete the application data" checkbox, which erased the vault for people
  who ticked it while updating. Our installer is Tauri's template plus two
  patches (`src-tauri/installer/installer.nsi`, generated by
  `scripts/installer-template.mjs`): it asks to close CoreTools, then runs
  the previous uninstaller with `/UPDATE /P` — data and shortcuts kept, no
  window. Every Tauri uninstaller already understands those flags, so this
  protects updates from any earlier version. A real uninstall (Windows
  Settings) still offers the checkbox, and confirms in plain words, default
  *No*, before erasing anything (`src-tauri/installer/hooks.nsh`).
- **After bumping `@tauri-apps/cli`**, CI fails at "Installer template is
  upstream + CoreTools patches". Run `node scripts/installer-template.mjs
  --update` and commit the regenerated `installer.nsi`; if the script says
  an anchor is missing, upstream changed that part of the template — re-read
  it and adapt the patch. CI then builds the real installer on Windows.
- **Watch releases**: on `jaychandra1/artifacts`, GitHub → Watch → Custom →
  Releases gives an email/notification feed;
  `https://github.com/jaychandra1/artifacts/releases.atom` is the Atom feed.
- For a security fix, also announce it on the download page and publish a
  GitHub Security Advisory (see `docs/runbooks/README.md`).

## Summary checklist

CoreTools runs on free services only. Everything below is free; what would
need a paid service is listed after it as an accepted risk.

- [ ] Push to `master` (or merge a PR) → **CI** must be green (types, unit
      and store tests, audit, browser end-to-end tests, clippy, Rust tests,
      Windows check, version sync); `promote-web` then deploys the site.
- [ ] Release: **Actions → Prepare release** → merge its PR → CI tags it and
      starts **Release** (or the manual `npm version` path in §2) → verify
      `coretools-v<version>` and `coretools-latest` in
      `jaychandra1/artifacts` have the three installers, the SBOM,
      `SHA256SUMS.txt` and `SHA256SUMS.txt.sigstore.json`.
- [ ] One-time: Vercel **Production Branch = `production`** (§1).
- [ ] One-time: *Allow auto-merge* and *Allow GitHub Actions to create and
      approve pull requests*.
- [ ] One-time: `ARTIFACTS_REPO_TOKEN` secret (fine-grained PAT, Contents
      read/write on `jaychandra1/artifacts` only, expiry ≤ 90 days) so
      releases can publish (§2).
- [ ] One-time: Actions → **Generate Cargo.lock** → merge its pull request.
- [ ] One-time: Google OAuth client + `CORETOOLS_GOOGLE_CLIENT_ID` /
      `CORETOOLS_GOOGLE_CLIENT_SECRET` repo secrets for cloud backup (§4).
- [ ] One-time: protect the Google Cloud project from deletion (free; run in
      Google Cloud Shell):
      `gcloud alpha resource-manager liens create --project=YOUR_PROJECT_ID --restrictions=resourcemanager.projects.delete --reason="CoreTools users' Drive backups depend on this project"`
- [ ] One-time: turn on private vulnerability reporting on
      `jaychandra1/artifacts` (Settings → Code security).
- [ ] When Drive usage grows: request a Drive API quota increase (free) in the
      Google Cloud console.
- [ ] (Optional) Actions → **Import old release**; purge historical binaries
      from git history (filter-repo).

### Accepted risks (free tier)

These need paid services, so they are accepted rather than planned. Each
still has a free control in place.

| Not done | Needs | Risk accepted | What still protects users |
| --- | --- | --- | --- |
| Code signing (F-01) | Azure Artifact Signing (~USD 10/month), Apple Developer (USD 99/year) | Windows SmartScreen and macOS Gatekeeper warnings; no auto-install updates | Sigstore-signed `SHA256SUMS.txt`; signing is wired and turns on when secrets exist |
| Branch and tag rulesets (F-04) | GitHub Pro for a private repo | Nothing enforces PR review on `master` | Website deploys only after CI; release refuses non-master commits |
| Release approval pause (F-03) | GitHub Enterprise, or a public source repo | A release publishes without a manual approval | Release gates (version, notes, commit on `master`); Sigstore identity bound to this workflow |
| Cloud Monitoring alerts (F-16) | Billing on the Google project | No automatic email on Drive API errors or quota spikes | Drive API dashboard in the Google Cloud console; in-app diagnostics |
| Applying `infra/terraform` (F-25) | GitHub Pro for the GitHub module; billing for alerts | Settings stay manual and can drift | The Terraform files document the intended settings; no paid state storage is needed if it is ever applied |
| Organization accounts (F-11) | A paid domain for a Google Cloud organization | Account lockout stops releases and backups | Deletion lien; encrypted backup files restore without Google |
| Vercel Pro and an app subdomain (F-28, F-13) | Vercel Pro; a custom domain | Hobby terms are for non-commercial use; app shares the marketing origin | Marketing pages run only first-party scripts under `script-src 'self'` |
| Penetration test (F-30) | An external reviewer | No independent review | Signed SBOM, `security.txt`, disclosure policy, test suites |
