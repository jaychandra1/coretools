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

### How installers are released (tag-triggered, public artifacts repo)

Two workflows own quality and distribution:

- **`.github/workflows/ci.yml`** — every push/PR: `svelte-check`, the full
  vitest suite, a production `npm audit` (must be clean), a version-drift
  check, a guard against temporary test code, `cargo clippy` + `cargo test`
  on Linux, and a `cargo check` on Windows (Windows Hello and WebView2 code
  only compiles there). Once `Cargo.lock` is committed, every Rust job
  verifies it. CI publishes nothing. Its only write is moving the
  `production` branch for the website (§1).
- **`.github/workflows/release.yml`** — runs when you push a version tag:

```bash
# One command. package.json is the source of truth; npm bumps it and
# package-lock.json, scripts/sync-version.mjs copies that version into
# Cargo.toml, tauri.conf.json, and website/scripts/downloads.js, then
# npm commits and tags (v0.3.0). The working tree must be clean.
npm version 0.3.0 -m "release: v%s"

# Push the commit and the tag — this is the entire release action:
git push origin HEAD --follow-tags
```

The release workflow then:

1. Re-runs the quality gates. It **refuses tags that don't match
   `package.json`**, and tags on a commit that isn't on `master`.
2. Builds on **Windows, macOS, and Linux** runners.
3. Publishes **all three or nothing** — a failed platform build fails the
   release; no mixed-version download sets.
4. **Waits for approval** in the `release` environment (once you add a
   required reviewer — see "Repository protection" below).
5. **Signs `SHA256SUMS.txt` with Sigstore** (keyless, bound to this
   workflow), then publishes the signature bundle
   `SHA256SUMS.txt.sigstore.json` with the installers.
6. Publishes to the **public** repository
   [`jaychandra1/artifacts`](https://github.com/jaychandra1/artifacts). This
   source repo stays private. Stable asset names (`CoreTools-Windows-Setup.exe`,
   `CoreTools-macOS.dmg`, `CoreTools-Linux.AppImage`) plus a `SHA256SUMS.txt`
   generated over the exact published files.

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

The workflows assume these settings. Without them, the gates above are
advisory.

1. **Protect `master`** — Settings → Rules → Rulesets → New branch ruleset,
   target `master`. Enable *Restrict deletions*, *Block force pushes*,
   *Require a pull request before merging* (with *Require review from Code
   Owners*; `.github/CODEOWNERS` names the owner) and *Require status checks
   to pass*. The required checks are the `ci.yml` jobs **Web**, **Rust lint
   (clippy), tests and format** and **Rust build check (Windows)**. Working
   solo? Put yourself on the bypass list for pull requests only, so the status
   checks still apply.
2. **Protect release tags** — New tag ruleset, target `v*`: *Restrict
   creations*, *Restrict updates*, *Restrict deletions*, with yourself on the
   bypass list. Only you can cut a release.
3. **Approve each publish** — Settings → Environments → New environment
   `release` → *Required reviewers*: yourself. Under *Deployment branches and
   tags*, allow only tags matching `v*`. Every release then pauses at
   "Publish" until you approve it.
4. **Generate `Cargo.lock`** — Actions → **Generate Cargo.lock** → Run
   workflow, then open the pull request it links and merge it. From then on
   CI and releases build exactly the locked dependency set.

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

Wiring it in: add the signing secrets to the repo (Settings → Secrets), then
configure `src-tauri/tauri.conf.json` → `bundle.windows.signCommand` (Trusted
Signing / custom signtool) or `certificateThumbprint` per the Tauri
"Windows – Code signing" guide. `release.yml` needs no structural change —
Tauri signs during `tauri build`; expose the secrets as env vars on the build
job's "Build the desktop app" step.

**macOS:** the `.dmg` is also unsigned — Gatekeeper shows a similar prompt.
The fix there is an Apple Developer ID ($99/yr) + notarization.

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

There is no auto-updater: apart from the opt-in Authenticator cloud backup,
the app makes no network requests, and it never phones home to check for
versions (see SECURITY.md). The manual-update policy is:

- The app shows its version in the header; each release lists changes in
  `CHANGELOG.md` and on its `coretools-v<version>` release in
  `jaychandra1/artifacts`.
- Users update by downloading the new installer over the old one; Authenticator
  and JSON-Studio data live in the webview profile and survive reinstalls.
- **Watch releases**: on `jaychandra1/artifacts`, GitHub → Watch → Custom →
  Releases gives an email/notification feed (it covers every app published
  there); `https://github.com/jaychandra1/artifacts/releases.atom` is the
  Atom feed.
- If a security fix ever ships, announce it prominently on the download page —
  there is no other channel to reach installed copies. Revisit
  `tauri-plugin-updater` (opt-in prompt, signed manifests) if the user base
  grows.

## Summary checklist

- [ ] Push to `master` → **CI** must be green (types, tests, audit, clippy,
      Windows check, version sync); `promote-web` then deploys the site.
- [ ] Release: `npm version X.Y.Z -m "release: v%s"` → `git push origin HEAD --follow-tags`
      → approve the **release** environment → verify `coretools-v<version>`
      and `coretools-latest` in `jaychandra1/artifacts` have all three
      installers + `SHA256SUMS.txt` + `SHA256SUMS.txt.sigstore.json`, and
      `coretools/releases/README.md` lists the new version.
- [ ] One-time: Vercel **Production Branch = `production`** (§1).
- [ ] One-time: `master` and `v*` rulesets, and a `release` environment with
      a required reviewer (§2, "Repository protection").
- [ ] One-time: `ARTIFACTS_REPO_TOKEN` secret (fine-grained PAT, Contents
      read/write on `jaychandra1/artifacts` only, expiry ≤ 90 days) so
      releases can publish (§2).
- [ ] (Optional) Actions → **Import old release** to publish the last 0.1.0
      build into the public history.
- [ ] One-time: Google OAuth client + `CORETOOLS_GOOGLE_CLIENT_ID` /
      `CORETOOLS_GOOGLE_CLIENT_SECRET` repo secrets for cloud backup (§4).
- [ ] One-time: Actions → **Generate Cargo.lock** → merge its pull request.
- [ ] (Optional) purge historical binaries from git history (filter-repo).
- [ ] (Recommended) set up code signing — Windows cert + macOS Developer ID —
      to remove OS "unknown publisher" warnings.
