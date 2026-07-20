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

A real `.msi` / `.dmg` / `.AppImage` is produced by **`tauri build`**, which
needs **Rust** and must run **on each target OS**. This can't happen on Vercel
(web-only). Two supported ways to produce them:

### Option A — Automated builds via GitHub Actions (recommended)

`.github/workflows/release.yml` builds installers for **Windows, macOS, and
Linux** and attaches them to a GitHub Release. No local Rust needed.

```bash
# 1. Push the code (including the workflow):
git push

# 2. Tag a version and push the tag — this triggers the build:
git tag v0.1.0
git push origin v0.1.0
```

Then:

3. Watch the **Actions** tab until all three jobs finish (~5–15 min).
4. Go to **Releases** — a **draft** release `CoreTools v0.1.0` will hold the
   built assets. Review and click **Publish**.
5. Done. The website's download buttons already point at
   `…/releases/latest`, so visitors can immediately grab their installer.

> The workflow regenerates icons (`npm run icon`) before building, so no icon
> files need to be committed for CI to succeed.

**For one-click, per-OS direct downloads** (optional), copy each published asset
URL into `website/scripts/downloads.js` → `platforms.<os>.url`, e.g.:

```js
windows: { …, url: "https://github.com/jaychandra1/coretools/releases/download/v0.1.0/CoreTools_0.1.0_x64_en-US.msi" }
```

### Option B — Build a Windows installer locally (fastest, Windows only)

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
installer; macOS/Linux builds require those OSes — use Option A for all three.)

## 3. Code signing (optional but recommended)

Unsigned installers trigger OS warnings ("unknown publisher" / Gatekeeper).
For a public release, sign them:

- **Windows:** an Authenticode certificate (see Tauri "Windows Code Signing").
- **macOS:** an Apple Developer ID + notarization.

These require paid certificates and are configured via secrets in the workflow.
Until then, users can still install by accepting the OS prompt.

## Summary checklist

- [ ] `git push` the changes → Vercel serves `/` (site) and `/app` (tool).
- [ ] `git tag v0.1.0 && git push origin v0.1.0` → Actions builds installers.
- [ ] Publish the draft GitHub Release.
- [ ] (Optional) paste direct asset URLs into `website/scripts/downloads.js`.
- [ ] (Optional) set up code signing.
