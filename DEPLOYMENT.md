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
Dependabot branches (`dependabot/**`) get no preview deployments either
(audit M7): their builds would run freshly bumped dependencies' install
scripts on Vercel before anyone reviewed them. Other branches still get
previews.

### Security headers

`vercel.json` sets, for every path: HSTS (preload), `nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and
`Cross-Origin-Opener-Policy: same-origin`. Each path gets **exactly one**
Content-Security-Policy and Permissions-Policy — Vercel applies every rule
whose `source` matches, so the marketing rule's source excludes `/app`
(`/((?!app(?:/|$)).*)`) and the `/app/:path*` rule carries the app's own:

| Path | CSP differences | Permissions-Policy |
| --- | --- | --- |
| `/`, `/privacy.html`, … (marketing) | `connect-src` allows `raw.githubusercontent.com` (latest.json) | `camera=(), microphone=(), geolocation=()` |
| `/app`, `/app/…` (the tool) | `script-src` adds `'wasm-unsafe-eval'` (Argon2id) | `camera=(self), microphone=(), geolocation=()` — the QR scanner |

Both CSPs include `form-action 'none'`, `frame-ancestors 'none'`,
`object-src 'none'` and `base-uri 'self'`. Check after a deploy:
`curl -sI https://coretools-chi.vercel.app/app | grep -i -e content-security -e permissions-policy`
must print one line of each.

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

These workflows own quality and distribution:

- **`.github/workflows/ci.yml`** — every push/PR: `svelte-check`, the vitest
  suite (including the vault and backup state machines against a real
  IndexedDB), a production `npm audit` (must be clean; dev-only advisories
  are reported as a warning), a version-drift check, a guard against
  temporary test code, **browser end-to-end tests** of the production web
  build (Playwright), `cargo fmt --check`, `cargo clippy` (warnings are
  errors) + `cargo test` on Linux, and `cargo check` + `cargo clippy` on
  Windows (Windows Hello, WebView2 and the secure clipboard only compile
  there; it does real work only when Rust code changed). Once `Cargo.lock`
  is committed, every Rust job verifies it; until then CI warns. On
  `master` it moves the `production` branch for the website (§1) and, when
  `package.json` carries a version that has no tag yet, tags it and starts
  the release.
- **`.github/workflows/security.yml`** — RustSec advisories (`cargo-deny`),
  workflow lint (`actionlint`, `zizmor`) and, on a public repository,
  dependency review. See "Security scanning" below.
- **`.github/workflows/codeql.yml`** — CodeQL; runs only while the repository
  is public.
- **`.github/workflows/prepare-release.yml`** — opens the release pull request.
- **`.github/workflows/release.yml`** — builds, signs and publishes a tag.
- **`.github/workflows/promote-latest.yml`** — re-points `coretools-latest`
  at an already published version: rollback, widening a staged rollout,
  update-check back-off. Never rebuilds.
- **`.github/workflows/stop-updates.yml`** — kill switch: deletes both
  copies of the in-app update manifest (`docs/runbooks/bad-release.md`,
  step 1). Doesn't wait for a release in progress.
- **`.github/workflows/release-dry-run.yml`** — on demand: builds all three
  platforms as a release does, signs the update files with a throwaway key,
  runs the manifest, checksum and index scripts — and publishes nothing.
  Run it after changing the pipeline, the Tauri CLI or the toolchain.
- **`.github/workflows/release-canary.yml`** — every 6 hours, checks that
  what is published matches the newest tag (see "Release canary").
- **`.github/workflows/cargo-lock.yml`** — one-off: generates
  `src-tauri/Cargo.lock` for review.

**Cutting a release.** Write notes under `## [Unreleased]` in `CHANGELOG.md`
as you go. Respect the soak rule (below). To release, run **Actions →
Prepare release → Run workflow** from `master` with the new version (e.g.
`1.2.0`) — the preferred path over pushing a tag by hand: the version bump
goes through a reviewed pull request and CI, and the tag is created only
after every gate passed. It bumps the version in
`package.json`, `package-lock.json`, `Cargo.toml`, `tauri.conf.json` and
`website/scripts/downloads.js` (and `Cargo.lock` once committed), moves the
Unreleased notes under `## [1.2.0] — <date>`, and opens a `release: v1.2.0`
pull request; it refuses to run when there are no notes, when
`src-tauri/Cargo.lock` isn't committed yet, and for anything but an `x.y.z`
version (installed copies accept no pre-release versions). Review and merge
that PR. Once CI passes on `master`, its **tag-release** job tags the merge
commit `v1.2.0` and starts the Release workflow on that tag (a tag created by
Actions can't trigger workflows by itself). It tags nothing while
`Cargo.lock` is missing — the release would refuse to run — and tags the
version on the first green `master` run after the lockfile is merged.

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
   `package.json`, a version that isn't `x.y.z`, a commit that isn't on
   `master`, a version whose `CHANGELOG.md` section is missing or empty, a
   production dependency with a known advisory (`npm audit --omit=dev`;
   dev-only advisories don't block a hotfix — CI reports them), a Rust crate
   in the lockfile with a RustSec advisory (`cargo deny check advisories`,
   `deny.toml`), a malformed `TAURI_UPDATER_PUBKEY`, and a missing or stale
   `src-tauri/Cargo.lock` (audit S-3: run **Generate Cargo.lock** once and
   merge it, or nothing releases). A run started on `master` (re-publishing
   `package.json`'s version without a tag) is refused in seconds unless the
   `release` environment admits `master` (`release_branch_patterns` in
   `infra/terraform/github`, empty by default) — otherwise the environment
   would refuse it only after every platform was built. Release a new
   version, or run Release on the version's `v*` tag, instead.
2. Builds on **Windows, macOS, and Linux** runners — **code-signed** for each
   platform whose signing credentials exist (§3) — and a CycloneDX **SBOM**.
   Only the published installers are bundled (NSIS on Windows — no MSI —,
   the DMG, the AppImage). No build cache is restored in release builds.
3. With in-app updates on, a separate **`sign-updates`** job signs the update
   files with the updater key (see "In-app updates" below) — the only job
   that ever holds that key.
4. Publishes **everything or nothing** — a failed platform build, SBOM or
   signing fails the release; no mixed-version download sets.
5. Runs `sign-updates` and the publish job in the `release` environment (an
   approval pause where the repository is public or the plan supports it —
   see "Repository protection" below).
6. **Signs `SHA256SUMS.txt` with Sigstore** (keyless, bound to this
   workflow and tag). The checksums cover every published file: the
   installers, the SBOM and, with in-app updates, the update files and
   `updater.json` (only the signature bundle itself isn't listed). The
   publish step refuses any file they don't list.
7. Publishes to the **public** repository
   [`jaychandra1/artifacts`](https://github.com/jaychandra1/artifacts). This
   source repo stays private. Stable asset names (`CoreTools-Windows-Setup.exe`,
   `CoreTools-macOS.dmg`, `CoreTools-Linux.AppImage`, `CoreTools-sbom.cdx.json`)
   plus `SHA256SUMS.txt` and its signature bundle (and, with in-app updates,
   `CoreTools-macOS.app.tar.gz`, the `*.sig` files and `updater.json`).

Only one release (or promote run) runs at a time — they share one
concurrency group, and a running one is never cancelled. GitHub keeps at
most one more waiting, so start releases one at a time. A release paused
for approval in the `release` environment still holds the group: a
rollback started meanwhile queues behind it, and a third run cancels the
one waiting. To roll back then, reject or cancel the pending release first
(`docs/runbooks/bad-release.md`, step 3). *Stop in-app updates* is outside
the group and never waits.

**Soak rule.** No release ships a change that has been on `master` for less
than 24 hours — except a security fix (or the fix for a SEV1/SEV2 bad
release, `docs/runbooks/bad-release.md`). A day on `master` means the
website and `/app` already ran it (promote-web deploys every green push), the
weekly scans may have caught something, and you looked at it twice. Prefer
**Actions → Prepare release** over pushing a tag by hand, merge nothing else
until CI has tagged the release (a newer push would be tagged instead — see
the `concurrency` note in `ci.yml`), and consider a staged rollout (below)
for anything large.

**SBOM.** Every release publishes `CoreTools-sbom.cdx.json`, a CycloneDX
software bill of materials: the npm dependencies (from `package-lock.json`,
via `npm sbom`) and the Rust crates for every target platform (from the
committed `src-tauri/Cargo.lock`, via `cargo-cyclonedx`). It is listed in
`SHA256SUMS.txt`, so the Sigstore signature covers it. (Releases from
before the lockfile was required mark the Rust part
`coretools:cargo-lock = resolved-at-release`.)

**Dependabot auto-merge.** Dependabot proposes updates weekly, grouped per
ecosystem, once a release is at least 7 days old (security updates
immediately). For pull requests where every update is a semver patch, or a
GitHub Actions minor/patch, `dependabot-auto-merge.yml` enables auto-merge
(squash) **only when `master` requires status checks** — a ruleset or branch
protection, which a private repository on GitHub Free doesn't have. Without
required checks, auto-merge would merge immediately, before CI ran, so the
workflow approves the pull request instead and you merge it once CI is
green. Everything else needs a manual merge. Merges made by the workflow
don't start CI on `master`: the website is promoted with the next push, or
run **Actions → CI → Run workflow** on `master`. Needs: Settings → General →
*Allow auto-merge*, and Settings → Actions → General → *Allow GitHub Actions
to create and approve pull requests* (also used by Prepare release).

### Where releases live: `jaychandra1/artifacts`

One public repo serves the downloads for **several applications**. Code stays
in each app's private repo; only installers and a generated index go public.
For CoreTools each release produces:

| What | Example | Notes |
| --- | --- | --- |
| Versioned release | tag `coretools-v0.3.0` | Kept forever, **published once and never overwritten**: a re-run with identical files leaves it alone, different files fail the publish (unless the Release run's *overwrite-versioned-release* input is ticked). Notes come from this version's `CHANGELOG.md` section |
| Stable "latest" release | tag `coretools-latest` | Mirrors the newest version exactly: replaced on each **newer** release (an older hotfix never moves it), and files the newest version doesn't have are deleted. Never delete this release itself (see "Immutable releases") |
| Index folder | `coretools/releases/` | `README.md` (latest links, SHA-256, every version), `latest.json` (with optional `rollout` / `checkAfterHours`), `index.json`, and the newest version's `updater.json` |
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
publishes are safe: the index is committed before `coretools-latest` moves,
it regenerates and retries if another publish pushed first, and whether this
version is the newest — the only thing that moves `coretools-latest` — is
decided by the regeneration that is finally pushed. The token never appears
in a clone URL or in `.git/config`; git receives it as an HTTP header through
environment variables, masked in the log.

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
The pre-tag build (0.1.0, from the old `website/downloads/` flow) was
imported once; the one-off "Import old release" workflow that did it has
been removed (audit M1) — it could publish arbitrary historical commits
with the publishing token. (0.2.0 was never built, so there is no 0.2.0
download.)

All third-party actions are **pinned to full commit SHAs** with the exact
version in a comment; tools the workflows download (cargo-deny, actionlint)
are pinned by version and SHA-256, zizmor by version. Node comes only from
`.nvmrc` and Rust only from `rust-toolchain.toml` (see "Toolchains"). This
repo's `GITHUB_TOKEN` is read-only except where a job's comment says why
(tagging, promoting `production`, the Cargo.lock branch, Dependabot
approvals); publishing uses the scoped token above. Dependabot
(`.github/dependabot.yml`) keeps npm, cargo, and the pinned actions patched.

### Rollback, staged rollout and update back-off

- **Staged rollout.** Actions → Release → Run workflow (on the tag) takes a
  *rollout* percentage (1–100). It is written to `latest.json` as
  `"rollout": N`; installed copies offer the update only if they fall in
  that share (the app decides which copies; empty = everyone, no field).
  Releases started without inputs — CI's tag-release after a merged release
  PR, or a pushed tag — take the optional **`RELEASE_ROLLOUT` repository
  variable** (e.g. `10`; unset = everyone), so the usual flow can be staged
  too. Widen it later without rebuilding: Actions → **Promote or roll back
  latest** with *version* = the current version and *rollout* = 50, then
  empty (everyone).
- **Update-check back-off.** *check-after-hours* (1–168), on either
  workflow, is written as `"checkAfterHours": N`: installed copies check at
  most every N hours (e.g. during GitHub rate-limit trouble). Empty = the
  app's own schedule. It stays until the next publish or promote run.
- **Rollback.** Actions → **Promote or roll back latest** with *version* =
  the last good version and *withdraw* = the bad one. It re-publishes the
  good version's original, signature-checked files on `coretools-latest`,
  removes the bad version from the index and its `updater.json` from
  everywhere, and marks its release "Withdrawn". Nothing is rebuilt and no
  versioned release changes. Full procedure: `docs/runbooks/bad-release.md`.
- **Stop in-app updates at once.** Actions → **Stop in-app updates**
  deletes both copies of `updater.json` (the repository-tree copy installed
  copies try first, and the `coretools-latest` asset). The next release or
  promote run writes them again.

The fields live in the version's `index.json` entry; `latest.json` carries
the newest entry's. The app reads them (`rollout`: integer 1–100, absent =
everyone; `checkAfterHours`: integer 1–168, absent = default).

### Immutable releases

GitHub can make releases of `jaychandra1/artifacts` immutable (Settings →
General → Releases → *Enable release immutability*): a published release's
assets can't be changed or deleted and its tag can't move — so a stolen
`ARTIFACTS_REPO_TOKEN` can no longer swap a versioned installer, and GitHub
adds a release attestation. The pipeline already never overwrites a
versioned release, and `gh release create` uploads before publishing.

**Caveat — `coretools-latest`.** It is replaced in place on every release,
and installed copies poll its `updater.json`. GitHub applies immutability to
releases published *after* it is switched on; the existing
`coretools-latest` stays mutable. So: enable it only while
`coretools-latest` exists, **never delete or re-create `coretools-latest`
afterwards** (a re-created one would be immutable; an immutable release's tag
name can never be reused), and after enabling, run *Promote or roll back
latest* for the current version and confirm it succeeds. If it fails with
an immutability error, turn the setting off (releases created while it was on
stay immutable). Builds from this pipeline version on already read
`coretools/releases/updater.json` from the repository tree first and
`coretools-latest/updater.json` only as a fallback
(`src-tauri/tauri.conf.json` → `plugins.updater.endpoints`), so once copies
older than that are rare, the updater no longer depends on a mutable
release.

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

### Security scanning (free)

`security.yml` runs on every push to `master`, every pull request and
weekly (Monday):

- **RustSec advisories** — `cargo deny check advisories` with `deny.toml`:
  any known vulnerability in a Rust crate CoreTools compiles fails; crates
  marked unmaintained or unsound fail only when they are direct
  dependencies (Tauri's Linux GTK stack carries such notices we can't act
  on). Fix with `cargo update -p <crate>`, or add an `ignore` entry with a
  reason. Licenses and bans are not checked yet (see `deny.toml`). The
  release gate runs the same check against the committed `Cargo.lock`, so
  an advisory published since the last push stops a release too.
- **Workflow lint** — `actionlint` (with shellcheck warnings) and `zizmor`
  (Actions security). Accepted zizmor findings are listed with reasons in
  `.github/zizmor.yml`. It also fails if a workflow pins a Node or Rust
  version itself.
- **Dependency review** of pull requests — public repositories only.

`codeql.yml` (JavaScript/TypeScript, Rust, Actions) also runs only while
the repository is public: code scanning and dependency review need GitHub
Advanced Security on a private repository, a paid add-on. **Making
`jaychandra1/coretools` public turns both on, with no workflow change.**
npm advisories are covered by `npm audit` in CI and the release gate, and
Dependabot alerts (free on private repositories too).

These jobs are not required status checks. Once they've been green for a
while, add `Rust advisories (cargo-deny, RustSec)` and `Workflow lint
(actionlint, zizmor)` to the required checks (Terraform:
`required_status_checks`).

### Release canary

`release-canary.yml` runs every 6 hours (and on demand) with read-only
permissions and fails — GitHub emails a failed scheduled run to whoever
last edited its schedule — when:

- `coretools/releases/latest.json` doesn't name the newest `v*` tag 6 hours
  after it was created (a stuck approval, a failed publish, a release that
  wasn't the newest). A withdrawn version is skipped when its release notes
  start with "Withdrawn" (promote-latest writes that); list others in the
  `RELEASE_CANARY_IGNORE_VERSIONS` repository variable (comma-separated);
- any download in `latest.json` doesn't answer 200 with its listed size, on
  `coretools-latest` or the versioned release, or `coretools-latest`'s
  `SHA256SUMS.txt` doesn't match `latest.json` (the stable links serve other
  files);
- `coretools-latest/updater.json` is missing for a release signed for
  in-app updates, offers another version (e.g. a withdrawn build), points
  outside that version's release, or carries signatures without the
  version in the signed file name (the repository-tree copy,
  `coretools/releases/updater.json`, is checked the same way);
- `https://coretools-chi.vercel.app/` or `/app/` doesn't answer 200.

It runs on GitHub, so it can't tell you GitHub itself is down: keep a free
external uptime monitor on the site as well ("Manual steps").

**A tag that never published keeps it red** — correctly: the newest tag
isn't what people download. Ways out:

- **Ship the next version** (with `src-tauri/Cargo.lock` committed). Once it
  is published, the canary only looks at the newest tag and goes green.
- **A tag that was never published and never will be** (nothing in the
  artifacts repo under `coretools-v<version>`): delete it, on GitHub and
  locally — `git push origin :refs/tags/v<version>` and
  `git tag -d v<version>`. Never delete or move a tag whose release was
  published.
- **Ignore a version** meanwhile:
  `gh variable set RELEASE_CANARY_IGNORE_VERSIONS -R jaychandra1/coretools --body <version>`
  (comma-separated for several). Delete the variable once a newer version
  is out, so it can't hide a later problem.

### Toolchains

- **Node:** `.nvmrc` (24 — the newest LTS line; Node 20 reached end of life
  in April 2026). Every workflow uses `node-version-file: .nvmrc`. Node 26
  becomes Active LTS on 28 Oct 2026; move to it once the toolchain (Vite,
  Vitest, Playwright, svelte-check) is green on it. `package.json`'s
  `engines` says `24.x` — change it in the same commit as `.nvmrc`.
- **Rust:** `rust-toolchain.toml` pins one stable version (with rustfmt and
  clippy). rustup picks it up locally too; the workflows install exactly it
  with the runner's rustup (`scripts/setup-rust.sh`) — no third-party setup
  action. Bump it by hand: change `channel`, push, let CI (fmt, clippy,
  tests, the Windows check) prove it. New clippy lints can fail CI — fix
  them in the same pull request.
- Dependabot updates neither file; `security.yml` fails if a workflow pins
  a Node or Rust version of its own.

### Repository protection (one-time, in GitHub settings)

The workflows assume these settings; without them, the gates above are
advisory. They are also written as Terraform in `infra/terraform/github/`
(see "Infrastructure as code" below).

> **What your GitHub plan allows on a private repository.** Rulesets (and
> classic branch protection) need **GitHub Pro** (or Team/Enterprise).
> Environments — their secrets, branch/tag rules and reviewers — can't be
> configured on a private repository with GitHub Free at all; Pro allows
> them. **Required reviewers on an environment need GitHub Enterprise** on a
> private repository — on Free, Pro and Team they work only for public
> repositories. On a **public** repository GitHub Free has all of it, which
> is why making the source repository public is the first manual step
> below. Without them, the "approve each publish" pause doesn't happen; the
> Sigstore signature (bound to this repository's release workflow and a
> `v*` tag) and the other release gates still apply.

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
   where your plan offers it, *Required reviewers*: yourself. With in-app
   updates on, a release then asks twice: first for `Sign in-app updates`
   (after the builds), then, a couple of minutes later, for the publish.
   Move `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   into this environment's secrets (and delete the repository copies), so
   only the signing job on a `v*` tag can read them.
4. **Generate `Cargo.lock`** — Actions → **Generate Cargo.lock** → Run
   workflow, then open the pull request it links and merge it. From then on
   CI and releases build exactly the locked dependency set. **Releases are
   refused until this is merged.**
5. **Allow Actions to open pull requests and enable auto-merge** (see
   "Dependabot auto-merge" above).

### Infrastructure as code

The repository, Google Cloud and Vercel settings this page describes as
one-time clicks are also kept as Terraform under `infra/terraform/`, in three
root modules with separate state and credentials:

- `github/` holds the `master` rulesets, the `v*` tag ruleset, and the
  `release` environment with a deployment policy that only accepts `v*`
  tags. At plan time it checks that the Actions secrets exist (the updater
  signing secrets as repository secrets, or in the `release` environment
  once `updater_signing_secrets_in_release_environment = true`), that the
  `TAURI_UPDATER_PUBKEY` variable exists, and that `ARTIFACTS_REPO_TOKEN`
  is under 90 days old; secret values never pass through Terraform. It
  needs a public repository or GitHub Pro to apply.
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

The installer appears under:

```
src-tauri/target/release/bundle/nsis/CoreTools_<version>_x64-setup.exe
```

Double-click it to install. No MSI is built: `tauri.conf.json`'s bundle
targets name only the published installers (NSIS on Windows; the release
build also passes `--bundles nsis`), and the in-app updater installs the
NSIS setup. (This
machine can only build the **Windows** installer; macOS/Linux builds require
those OSes — use the tag-triggered release workflow for all three.) Locally-built installers are for your own
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
safely: add the credentials, run Actions → Release → Run workflow on the
newest **already published** `v*` tag, check the build logs and the
signature-verification steps, then reject the `release` environment's
approval. (Without required reviewers the publish still changes nothing:
it refuses to overwrite a published version whose files differ, before
the index or `coretools-latest` move. A run on `master` is refused before
it builds unless the environment admits `master`. The *Release dry run*
workflow has no secrets, so it builds unsigned.)

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

### Microsoft Store (Windows)

The website is ready for a Store listing. Until it exists nothing about the
Store shows. Once the app is live:

1. Copy its 12-character Store ID (Partner Center → the app → *Product
   identity*).
2. Set it as `microsoftStore.productId` in `website/scripts/downloads.js`.

The Windows card then offers *Get it from Microsoft Store* first and the
`.exe` second, and the download notes and privacy policy mention the Store.

Getting listed:

1. **Partner Center.** Register a developer account and reserve the name
   *CoreTools* (*Apps and games → New product*). Check Partner Center for
   the current registration terms.
2. **Choose how to submit.** This is the decision that matters:

   | Route | What the Store needs | Fits CoreTools today? |
   | --- | --- | --- |
   | **EXE/MSI app** | An HTTPS link to the installer for that exact version; the `coretools-v<version>` release asset fits. A silent-install switch (`/S` for the NSIS installer). The installer **signed with a certificate from a CA in Microsoft's Trusted Root Program** | Not yet: needs Windows code signing first. Azure Artifact Signing above is already wired |
   | **MSIX package** | An MSIX built from the app. The Store signs it during certification, so no certificate of your own is needed | Needs MSIX packaging added to the release; Tauri doesn't produce MSIX |

   The EXE route is the better fit once Windows signing is on. One signed
   installer serves the website and the Store, and signing also ends the
   SmartScreen warning on direct downloads.
3. **Updates.**
   - EXE/MSI listing: submit each release's new versioned link in Partner
     Center. Copies keep CoreTools' own update check.
   - MSIX: the Store updates the app, so a Store build must ship with the
     in-app updater switched off.

   Read the current Microsoft Store Policies before submitting either way.
4. **Listing details.** The privacy policy URL is
   `https://coretools-chi.vercel.app/privacy.html`; it already covers Store
   installs. You also need screenshots, a description, the age-rating
   questionnaire, and the support contact `coretools.works@gmail.com`.

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
takes effect in the next release** (Actions → Prepare release, §2).
Installers built before that still report "not configured".

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
app renders them. The pipeline itself writes `"rollout"` and
`"checkAfterHours"` when set (see "Rollback, staged rollout and update
back-off").

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
compiled into the app, which installs only files that verify against it —
and only if the signed file name carries the version.

**How a release signs (audit S-2).** The build jobs compile the public key
in and bundle *without* Tauri's `createUpdaterArtifacts` (which would need
the private key at bundle time, inside the jobs that run every npm and
crate build script); the macOS job also packs the `.app` as
`CoreTools-macOS.app.tar.gz`. A separate **`sign-updates`** job — Ubuntu,
nothing built, `npm ci --ignore-scripts`, in the `release` environment — is
the only job that reads the private key. It signs version-named copies with
`tauri signer sign`, so each signature's trusted comment says
`file:CoreTools_<version>_<target>.<ext>`:

| Platform | Update file (published name) | Signed as |
| --- | --- | --- |
| Windows | `CoreTools-Windows-Setup.exe` (the NSIS setup, run with `/UPDATE`) | `CoreTools_<version>_windows-x86_64-setup.exe` |
| macOS (universal) | `CoreTools-macOS.app.tar.gz` | `CoreTools_<version>_darwin-universal.app.tar.gz` |
| Linux | `CoreTools-Linux.AppImage` | `CoreTools_<version>_linux-x86_64.AppImage` |

The app refuses an update whose signed name lacks `_<version>_`, so an old,
validly signed file can't be served as a newer version. The job then
verifies every signature against `TAURI_UPDATER_PUBKEY` (a key pair that
doesn't match fails here, not on users' machines) and hands only the `.sig`
files to the publish job, which writes `updater.json`.

1. Generate it on your machine (it asks for a password; keep both safe):

   ```bash
   npx tauri signer generate -w ~/.tauri/coretools-updater.key
   ```

2. **Escrow it now**, before it reaches GitHub (GitHub never shows a secret
   again): two offline copies of the `.key` file in two places, the password
   stored separately — `docs/runbooks/updater-key-lost-or-leaked.md` →
   "Escrow".
3. In `jaychandra1/coretools` → Settings:
   - **Secret** `TAURI_SIGNING_PRIVATE_KEY` — the contents of
     `~/.tauri/coretools-updater.key` — and **Secret**
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password. Put both in
     **Environments → `release` → Environment secrets** when the repository
     is public (or on Pro); on a private Free repository environments can't
     be configured, so use repository secrets (Secrets and variables →
     Actions) until then.
   - **Variable** `TAURI_UPDATER_PUBKEY` — the contents of
     `~/.tauri/coretools-updater.key.pub`. Always a **repository** variable
     (Secrets and variables → Actions → Variables): the build jobs, which
     don't run in the environment, compile it in. It switches in-app
     updates on.
4. Release as usual. The release refuses a half setup (a repository key
   without the variable at once; a variable without a key, or a key that
   doesn't match it, in `sign-updates` before anything is published); the
   summary says "In-app updates: signed". Each release then also carries
   the update files' signatures (`*.sig`), `CoreTools-macOS.app.tar.gz`, and
   `updater.json` — all listed in the signed `SHA256SUMS.txt`. Installed
   copies poll the manifest at
   `https://raw.githubusercontent.com/jaychandra1/artifacts/main/coretools/releases/updater.json`
   (committed next to `latest.json`) and fall back to
   `https://github.com/jaychandra1/artifacts/releases/download/coretools-latest/updater.json`
   — the same file. To stop updates, both must go (Actions → *Stop in-app
   updates*).

The first release built with the key is the first that can update itself;
copies installed before it keep downloading the installer, once. Losing the
key, or a leak, means a new key — and every copy installed before the first
release with it must install that release by hand once:
`docs/runbooks/updater-key-lost-or-leaked.md`. Local builds have no updater
key, so they never update themselves.

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
      and store tests, audit, browser end-to-end tests, rustfmt, clippy,
      Rust tests, Windows check and clippy, version sync); `promote-web`
      then deploys the site. **Security scans** should be green too.
- [ ] Release (soak rule: every change ≥ 24 h on `master`, security fixes
      excepted): **Actions → Prepare release** → merge its PR → CI tags it
      and starts **Release** (or the manual `npm version` path in §2) →
      approve `Sign in-app updates` and the publish → verify
      `coretools-v<version>` and `coretools-latest` in
      `jaychandra1/artifacts` have the three installers, the SBOM,
      `SHA256SUMS.txt` and `SHA256SUMS.txt.sigstore.json` (plus the update
      files and `updater.json` with in-app updates) → Actions → **Release
      canary** → Run workflow is green.
- [ ] Something wrong with a release: `docs/runbooks/bad-release.md`
      (Actions → **Stop in-app updates**, then **Promote or roll back
      latest**).
- [ ] Changed the pipeline, the Tauri CLI or the toolchain: Actions →
      **Release dry run** is green before the next release.
- [ ] One-time: Vercel **Production Branch = `production`** (§1).
- [ ] One-time: *Allow auto-merge* and *Allow GitHub Actions to create and
      approve pull requests*.
- [ ] One-time: `ARTIFACTS_REPO_TOKEN` secret (fine-grained PAT, Contents
      read/write on `jaychandra1/artifacts` only, expiry ≤ 90 days) so
      releases can publish (§2).
- [ ] One-time: Google OAuth client + `CORETOOLS_GOOGLE_CLIENT_ID` /
      `CORETOOLS_GOOGLE_CLIENT_SECRET` repo secrets for cloud backup (§4).
- [ ] One-time: protect the Google Cloud project from deletion (free; run in
      Google Cloud Shell):
      `gcloud alpha resource-manager liens create --project=YOUR_PROJECT_ID --restrictions=resourcemanager.projects.delete --reason="CoreTools users' Drive backups depend on this project"`
- [ ] One-time: turn on private vulnerability reporting on
      `jaychandra1/artifacts` (Settings → Code security).
- [ ] When Drive usage grows: request a Drive API quota increase (free) in the
      Google Cloud console.
- [ ] (Optional) Purge historical binaries from git history (filter-repo).

### Manual steps only the owner can do

The workflows can't do these: they are account or repository settings, or
they involve secrets that must never pass through CI. All are free. In
order of value:

- [ ] **Generate `Cargo.lock`** — Actions → *Generate Cargo.lock* → Run
      workflow → open the linked pull request → merge. **Releases are
      refused until this is done** (audit S-3).
- [ ] **Create the updater key with an offline escrow copy** —
      "In-app updates: one-time key setup" above: generate on your machine,
      two offline copies of the key file plus the password stored
      separately, then the secrets and the `TAURI_UPDATER_PUBKEY` variable.
      Test a restore once a year (`docs/runbooks/updater-key-lost-or-leaked.md`).
- [ ] **Make `jaychandra1/coretools` public** (Settings → General → Danger
      Zone → Change visibility) — or pay for GitHub Pro. On a public
      repository GitHub Free provides rulesets, environments with secrets,
      tag policies and required reviewers, CodeQL and dependency review —
      `codeql.yml` and the dependency-review job switch on by themselves.
      Before you do: the history must hold no secrets (search it, e.g.
      `git log -p | grep -iE "secret|token|password|BEGIN .*PRIVATE"`), and
      the compiled-in Google client secret is not confidential by design
      (§4). Then apply `infra/terraform/github` (`terraform plan`,
      `apply`; `release_reviewers = ["jaychandra1"]` works on a public
      repository).
- [ ] **Move the signing secrets into the `release` environment** (once the
      repository is public or on Pro): Settings → Environments → `release`
      → add `TAURI_SIGNING_PRIVATE_KEY` and
      `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, delete the repository copies,
      and set `updater_signing_secrets_in_release_environment = true` in
      `infra/terraform/github`. Keep `TAURI_UPDATER_PUBKEY` a repository
      variable and `ARTIFACTS_REPO_TOKEN` a repository secret.
- [ ] **Hardware-key two-factor authentication** (a FIDO2/WebAuthn security
      key or passkey; two keys, one stored away) on the GitHub account, the
      Google account that owns the Cloud project, and the Vercel account.
      Remove SMS as a fallback where the service allows it. These three
      accounts can each ship code to users.
- [ ] **Replace `ARTIFACTS_REPO_TOKEN`** with a fine-grained token limited
      to `jaychandra1/artifacts` (Contents: read and write, nothing else,
      ≤ 90 days) if it isn't one already — or, better, a GitHub App
      installed only on `jaychandra1/artifacts` that mints a one-hour token
      per run (`actions/create-github-app-token`, pinned by SHA). Never a
      classic PAT.
- [ ] **Turn on immutable releases on `jaychandra1/artifacts`** — read
      "Immutable releases" above first: never delete or re-create
      `coretools-latest` afterwards, and run *Promote or roll back latest*
      once to confirm `coretools-latest` can still be updated. Also add a
      ruleset there blocking force pushes and deletion of `main`.
- [ ] **A free external uptime monitor** (e.g. UptimeRobot or Better Stack
      free tiers, or a free Cloudflare/Google Cloud uptime check) on
      `https://coretools-chi.vercel.app/`, `/app/` and
      `https://raw.githubusercontent.com/jaychandra1/artifacts/main/coretools/releases/latest.json`,
      alerting by email. The release canary runs on GitHub, so it can't
      report GitHub or itself being down.
- [ ] **Merge the pending Dependabot pull requests** (several pinned actions
      are a major version behind and run on Node 20, which reached end of
      life), and keep merging them — on a private Free repository nothing
      merges them automatically (see "Dependabot auto-merge").
- [ ] Optional: set `RELEASE_ROLLOUT` (e.g. `25`) to stage every release by
      default, and widen each with *Promote or roll back latest*.

### Accepted risks (free tier)

These need paid services, so they are accepted rather than planned. Each
still has a free control in place.

| Not done | Needs | Risk accepted | What still protects users |
| --- | --- | --- | --- |
| Code signing (F-01) | Azure Artifact Signing (~USD 10/month), Apple Developer (USD 99/year) | Windows SmartScreen and macOS Gatekeeper warnings; no auto-install updates | Sigstore-signed `SHA256SUMS.txt`; signing is wired and turns on when secrets exist |
| Branch and tag rulesets (F-04) | GitHub Pro for a private repo — free once the repo is public | Nothing enforces PR review on `master`; Dependabot patches aren't auto-merged | Website deploys only after CI; release refuses non-master commits |
| Release approval pause (F-03), signing secrets in the `release` environment (S-2) | GitHub Enterprise (reviewers) / Pro (environments) for a private repo — free once public | A release publishes without a manual approval; the updater key is a repository secret any workflow could read | Release gates (version, notes, lockfile, commit on `master`); Sigstore identity bound to this workflow; the key is used only in `sign-updates`, which runs no install scripts and verifies the key pair |
| CodeQL and dependency review (M5) | GitHub Advanced Security for a private repo — free once public | No static analysis or PR dependency review | `cargo-deny`, `npm audit`, Dependabot alerts, actionlint + zizmor; the workflows switch on when the repo is public |
| Cloud Monitoring alerts (F-16) | Billing on the Google project | No automatic email on Drive API errors or quota spikes | Drive API dashboard in the Google Cloud console; in-app diagnostics |
| Applying `infra/terraform` (F-25) | GitHub Pro for the GitHub module (or a public repo); billing for alerts | Settings stay manual and can drift | The Terraform files document the intended settings; no paid state storage is needed if it is ever applied |
| Organization accounts (F-11) | A paid domain for a Google Cloud organization | Account lockout stops releases and backups | Deletion lien; encrypted backup files restore without Google |
| Vercel Pro and an app subdomain (F-28, F-13) | Vercel Pro; a custom domain | Hobby terms are for non-commercial use; app shares the marketing origin | Marketing pages run only first-party scripts under `script-src 'self'` |
| Penetration test (F-30) | An external reviewer | No independent review | Signed SBOM, `security.txt`, disclosure policy, test suites |
