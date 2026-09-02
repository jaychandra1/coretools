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

### To apply it

Commit and push these changes to the branch Vercel deploys (your `master`):

```bash
git add .
git commit -m "Serve landing page at / and app at /app; add release pipeline & icons"
git push
```

Vercel will redeploy automatically. Confirm:

- `/` shows the landing page.
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

### How installers are released (tag-triggered, GitHub Releases)

Two workflows own quality and distribution:

- **`.github/workflows/ci.yml`** — every push/PR: `svelte-check`, the full
  vitest suite, a production `npm audit` (must be clean), a version-drift
  check, and `cargo clippy` on the Rust backend. Nothing publishes from CI.
- **`.github/workflows/release.yml`** — runs when you push a version tag:

```bash
# 1. Set the version once (package.json is the single source):
#    edit package.json "version", then propagate it:
node scripts/sync-version.mjs
git commit -am "release: v0.3.0"

# 2. Tag and push — this is the entire release action:
git tag v0.3.0
git push origin master v0.3.0
```

The release workflow then:

1. Re-runs the quality gates and **refuses tags that don't match
   `package.json`**.
2. Builds on **Windows, macOS, and Linux** runners.
3. Publishes **all three or nothing** — a failed platform build fails the
   release; no mixed-version download sets.
4. Creates a GitHub Release for the tag with stable asset names
   (`CoreTools-Windows-Setup.exe`, `CoreTools-macOS.dmg`,
   `CoreTools-Linux.AppImage`) plus a `SHA256SUMS.txt` generated over the
   exact published files, auto-generated release notes, and the source commit.

The site's download buttons (`website/scripts/downloads.js`) point at the
stable **`releases/latest/download/<asset>`** URLs, so they always serve the
newest release with no site edit; every previous version stays downloadable
from the Releases page. **Binaries are never committed to git** — the old
per-push publish flow grew `.git` by ~90 MB per release and gave SmartScreen a
fresh unknown hash on every push; tag-only releases also keep macOS CI minutes
(billed at 10×) for actual releases.

All workflow actions are **pinned to commit SHAs**, the default token is
read-only (`contents: write` exists only on the publish job), and Dependabot
(`.github/dependabot.yml`) keeps npm, cargo, and the pinned actions patched.

> **One-time follow-ups:** commit `src-tauri/Cargo.lock`
> (`cd src-tauri && cargo generate-lockfile`) so builds are reproducible, and
> optionally purge the historical binaries from git history
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

## Updates for installed copies

There is no auto-updater (by design, the app makes no network requests — see
SECURITY.md). The manual-update policy is:

- The app shows its version in the header; each release lists changes in
  `CHANGELOG.md` and on the GitHub Release.
- Users update by downloading the new installer over the old one; Authenticator
  and JSON-Studio data live in the webview profile and survive reinstalls.
- **Watch releases**: GitHub → Watch → Custom → Releases gives an
  email/notification feed; the Releases page also serves an Atom feed
  (`/releases.atom`).
- If a security fix ever ships, announce it prominently on the download page —
  there is no other channel to reach installed copies. Revisit
  `tauri-plugin-updater` (opt-in prompt, signed manifests) if the user base
  grows.

## Summary checklist

- [ ] Push to `master` → **CI** must be green (types, tests, audit, clippy,
      version sync).
- [ ] Release: bump `package.json` version → `node scripts/sync-version.mjs`
      → commit → `git tag vX.Y.Z && git push origin vX.Y.Z` → verify the
      GitHub Release has all three installers + `SHA256SUMS.txt`.
- [ ] One-time: commit `src-tauri/Cargo.lock` from a machine with Rust.
- [ ] (Optional) purge historical binaries from git history (filter-repo).
- [ ] (Recommended) set up code signing — Windows cert + macOS Developer ID —
      to remove OS "unknown publisher" warnings.
