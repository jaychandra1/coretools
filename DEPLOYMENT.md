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

### How installers reach the site (automated, no GitHub Releases)

`.github/workflows/build-installers.yml` runs on every push to `master`:

1. Builds the app on **Windows, macOS, and Linux** runners (real machines).
2. Renames each installer to a **stable name** and commits them into
   `website/downloads/`:
   - `CoreTools-Windows-Setup.exe`
   - `CoreTools-macOS.dmg`
   - `CoreTools-Linux.AppImage`
3. That commit triggers a Vercel redeploy, so the files are served at
   `https://<your-site>/downloads/CoreTools-Windows-Setup.exe` (etc.).

The site's download buttons already point at these same-site paths (see
`website/scripts/downloads.js`), so visitors download **straight from your
domain** — GitHub Releases is never involved. Because the names are stable, the
buttons keep working across versions with no edits.

```bash
# Trigger it just by pushing (or run it from the Actions tab):
git push
```

Watch the **Actions** tab; when the `publish` job finishes it commits the
installers and Vercel redeploys. First run takes ~10–15 min.

> The workflow regenerates icons (`npm run icon`) before building, so no icon
> files need to be committed for CI to succeed. The auto-commit uses
> `[skip ci]` and the trigger ignores `website/downloads/**`, so it never loops.

**Trade-offs to know:**

- **CI minutes.** macOS runners bill at **10×** minutes. Building on *every*
  push can use your free quota quickly. To build less often, change the trigger
  in the workflow from `push` to tags only (`on: push: tags: ['v*']`) and build
  by running `git tag v0.1.0 && git push origin v0.1.0`.
- **Repo/deploy size.** Committing binaries grows git history over time. If that
  becomes a problem, host them on **Vercel Blob** instead (upload from the
  workflow, point `downloads.js` at the Blob URLs) — same "download from your
  site" experience without the git bloat.

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
installer; macOS/Linux builds require those OSes — use the automated workflow
above for all three.) You can drop a locally-built installer into
`website/downloads/` under the stable name to publish it manually.

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
"Windows – Code signing" guide. The existing workflow needs no structural
change — Tauri signs during `tauri build`.

**macOS:** the `.dmg` is also unsigned — Gatekeeper shows a similar prompt.
The fix there is an Apple Developer ID ($99/yr) + notarization.

### Mitigations until you sign

- **Report false positives to Microsoft** (helps the *current* build only):
  submit the `.exe` at <https://www.microsoft.com/en-us/wdsi/filesubmission>
  as a developer; in Edge you can also right-click the blocked download →
  *Report this file as safe*.
- The download page now explains the warning and points users to the SHA-256
  checksums and the "Keep anyway" flow — and offers the in-browser app as the
  zero-friction alternative.
- A **custom domain** (instead of `*.vercel.app`) modestly improves URL
  reputation.
- Avoid rebuilding installers on every push (tag-only trigger) — fewer fresh
  hashes means each build accumulates more reputation before being replaced.

## Summary checklist

- [ ] `git push` the changes → Vercel serves `/` (site) and `/app` (tool), and
      the installer workflow starts building.
- [ ] Wait for the **Actions** run to finish → it commits installers into
      `website/downloads/` → Vercel redeploys → download buttons work.
- [ ] (Optional) switch the workflow to tag-only triggers to save CI minutes.
- [ ] (Optional) set up code signing to remove OS "unknown publisher" warnings.
