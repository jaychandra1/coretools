# Changelog

All notable changes to CoreTools are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

Releases are cut with `npm version X.Y.Z -m "release: v%s"`, then
`git push origin HEAD --follow-tags`. That bumps `package.json` and copies
the version everywhere else. CI refuses a tag that doesn't match
`package.json`.

## [Unreleased]

### Changed

- **Each module now backs up separately to Google Drive.** Authenticator
  accounts are saved as `coretools-authenticator-<time>-<device>.json` and
  Credential Manager logins as `coretools-credmanager-<time>-<device>.json`.
  Each series keeps its own 10 versions, its own conflict check and its own
  "pending" state. Adding a login no longer re-uploads your 2FA accounts, and
  a conflict in one module never pauses backups of the other. Existing
  backups keep working: older single-file backups appear under the
  Authenticator and restore its accounts.
- **Each section shows only its own things.** The Authenticator's settings
  show its backup status, versions, "Back up now", restore and delete; the
  Credential Manager's settings show its own. Options that belong to the
  other section (code grouping, password-reveal confirmation) are no longer
  shown there. The Google connection itself is shared.
- **The cloud backup panel no longer shows the Drive folder path or file
  name.** The "Open Google Drive settings" button is gone too, along with
  the native command behind it.
- **Releases are signed and gated.** `SHA256SUMS.txt` is signed with Sigstore
  (keyless; `SHA256SUMS.txt.sigstore.json`) and the release notes print the
  verify command. A release builds only commits already on `master` and
  waits for approval in the `release` environment. The website deploys from
  a `production` branch that CI moves only after the web checks pass.
- CI verifies `src-tauri/Cargo.lock` once committed (`cargo metadata --locked`),
  runs the Rust unit tests, and refuses temporary test code. A one-click
  **Generate Cargo.lock** workflow proposes the lockfile for review.

### Fixed

- **The website shows the version you actually download.** The download
  cards read the newest published release (`coretools/releases/latest.json`)
  instead of a version baked in at build time. Before, the site could
  advertise a release that hadn't finished publishing.
- **Google Drive "403" errors are told apart.** Full storage, rate limiting
  (retried automatically), a Workspace administrator's policy, and revoked
  permission each get their own message. An unrecognised 403 no longer
  claims your access was revoked.

- **No more "http://tauri.localhost wants to use your cameras" prompt** in
  the Windows app. That address is Tauri's internal name for the app's own
  pages, so the prompt looked like a foreign site asking. The app now answers
  WebView2's camera request itself when you start the QR scanner. It covers
  the camera only, and only the app's own pages can be in the webview;
  Windows' camera privacy switch and in-use light still apply.

### Changed

- CI compiles the Windows-only Rust code (Windows Hello, WebView2) on every
  push, instead of discovering mistakes there only in a release build.

## [1.1.0] — 2026-10-13

### Added

- **Credential Manager** (new tab): store platform logins — name, login URL,
  username, password, notes, category, owner and tags — in the same
  encrypted vault as the Authenticator (one master password / Windows Hello
  unlock). Passwords and notes are AES-256-GCM encrypted and decrypted only
  on demand. Features:
  - a table on desktop and cards on narrow windows;
  - eye toggle to show or hide passwords (auto-hides after 20 s);
  - one-click copy of username, password and URL, with toasts;
  - open the login page in your browser;
  - hover tooltips on every action;
  - search (platform, URL, username, tags) and filters (category, owner,
    creation date);
  - add, edit and delete; delete moves to a Trash with undo, restore, and
    automatic purge after 30 days;
  - a strong-password generator with a strength meter.
- **Security for credentials**: showing or copying a password asks for
  Windows Hello or the master password, then trusts the session for a
  minute (can be turned off in settings). A local **activity log** records
  every create, edit, delete, restore, password view and copy, and never
  logs secrets. Credentials are included in the end-to-end encrypted Google
  Drive backup and restore.
- Cloud backup panel redesign: status pill, last-backup / versions / encryption
  tiles, an automatic-backup switch, and where the backup lives in Google
  Drive (hidden app data → CoreTools, newest file name) with a button to open
  Drive settings.

### Fixed

- **Authenticator drag-to-reorder** works in the desktop app. Tauri's
  file-drop handling was swallowing the page's drag events on Windows, which
  also blocked dropping a QR image into Add Account. Reordering now follows
  the order on screen, so pinned accounts no longer send a dropped card to
  the wrong place.

## [1.0.1] — 2026-10-12

### Added

- **Google Drive backup is switched on in the desktop app.** Release builds
  now include CoreTools' Google sign-in client, so *Connect Google Account*
  and *Restore from Google Drive* work in the Authenticator. Builds before
  this one reported the feature as "not configured".
- **Privacy policy** at `/privacy.html`: what stays on your device, exactly
  what the optional Drive backup can access (your email and a hidden
  app-only folder), how it is encrypted, and how to disconnect or delete it.
  Linked from the website footer.

### Changed

- The website's Privacy section now describes the optional, end-to-end
  encrypted Drive backup instead of claiming the app never goes online.

## [1.0.0] — 2026-10-12

### Changed

- **Downloads now come from the public `jaychandra1/artifacts` repository**
  while the source stays private. Each version is published as release
  `coretools-v<version>` and kept forever. `coretools-latest` gives the
  website stable links that only a newer version can move, and a generated
  `coretools/releases/` index lists every version with SHA-256 checksums. The
  same repo can host other applications. An "Import old release" workflow
  publishes the last pre-0.2.0 build (0.1.0) into that history.

- **Honest connectivity badge.** The header badge now reflects each section.
  It reads **Offline** in every tool, and **Online · Drive backup** only on
  the Authenticator tab while Google Drive backup is connected. It also reads
  **Online · Syncing…** on any tab while a backup or sign-in is actually
  running. Previously it always said "Offline" with a "No network access"
  tooltip, which stopped being true once cloud backup existed.
- Docs: README, SECURITY.md (§1 network model, §3 command table, §8 cloud
  backup threat model and trade-offs), DEPLOYMENT.md (§4 Google OAuth client
  setup; no billing needed) and the Authenticator README now cover cloud
  backup.

## [0.3.0] — 2026-10-12

### Added — Authenticator: Google Drive backup & restore (desktop, opt-in)

- **Connect Google Account** in Authenticator settings (requires an
  encryption password). Every change is backed up automatically, debounced, to
  a hidden app-only Drive folder (`drive.appdata` scope).
- **End-to-end encrypted**: the whole vault, secrets *and* account names,
  order and pins, is sealed as one AES-256-GCM blob under the vault key, with
  the header bound as authenticated data. Google stores an opaque file.
- **Integrity checks** at every step: local self-check before upload, Drive
  MD5 verification after upload, and on restore the verifier, GCM tag, entry
  count, SHA-256 digest and per-record validation.
- **Restore** after a reinstall or on a new device: sign in, pick a version,
  enter the backup's password, verify with Windows Hello, then **merge**
  (never duplicates) or **replace** (rollback). Restores are atomic.
- **10 versions** kept for rollback; settings show account, status, last
  backup and last restore, with Backup now / Restore / Disconnect / Delete
  cloud backups.
- **Multi-device safety**: a newer backup from another device pauses
  automatic backup until you merge it or keep this device's data.
- **Resilient**: offline and Google-side failures retry with back-off and on
  reconnect; revoked access shows a reconnect banner.
- OAuth (PKCE, loopback redirect) and all HTTP run in Rust; the refresh token
  is stored in the OS keychain and never reaches the webview, whose CSP is
  unchanged. Release builds need a Google OAuth client (DEPLOYMENT.md §4);
  without one, the feature reports "not configured".

### Changed

- **One-row header**: tool tabs now share the top bar with the status badge
  and theme toggle (the "CoreTools" title row was removed — the window title
  carries the name), giving each tool more vertical space.
- Changing or removing the encryption password now writes the vault config
  and all entries in a single IndexedDB transaction (previously two), so an
  interruption can't leave them out of step.

## [0.2.0] — 2026-09-02

First versioned release. Everything before this shipped as untagged "0.1.0"
builds; those installers remain only in old git history.

### Fixed — data corruption (P0)

- **YML-Validator no longer corrupts ConfigMap/Secret payloads**: blank lines
  inside block-scalar values (nginx.conf, shell scripts, certificate chains)
  are preserved byte-for-byte; formatting normalization now applies only at
  document edges.
- **YML-Validator treats user data as opaque**: keys named `uid`,
  `generation`, `finalizers` etc., `null` values, and empty containers inside
  `data`/`labels`/`annotations`/`stringData`/… are never stripped. Tooling
  noise annotations are still removed, but only as direct children of a
  schema-level `annotations` map.

### Fixed — JSON Studio (P0)

- The Monaco editor is no longer disposed and recreated on every keystroke;
  cursor, scroll, find state and the **undo/redo stack** now survive typing.
  The same defect was fixed in the Diff view's side-by-side editor.

### Fixed — Authenticator security & privacy (P0)

- Locking (manual or idle auto-lock) now closes every open dialog. Previously
  an open Export dialog kept rendering plaintext-secret QR codes on top of the
  lock screen.
- The camera can no longer stay live after the Add-account dialog closes while
  a permission prompt is pending.
- Clipboard auto-clear no longer erases the clipboard when its contents cannot
  be verified — it only clears when the copied code is provably still there.

### Security — native layer & supply chain

- **File-dialog trust is now enforced in Rust**: dialogs are opened by the
  backend, issued paths are canonicalized and single-use, and the read/write
  commands refuse any other path. The webview's dialog capability was removed.
  `write_text_file` gained the previously missing 100 MiB size cap.
- Installers are now published to **GitHub Releases** by a tag-triggered
  workflow with pinned actions, an all-or-nothing publish gate, and a
  per-release `SHA256SUMS.txt` — binaries are no longer committed to git.
- CI now gates every push: svelte-check, 271 unit tests, production
  `npm audit`, version-drift check, `cargo clippy`.

### Added

- App version displayed in the header (and injected at build time from
  `package.json`, which is now the single version source — see
  `scripts/sync-version.mjs`).
- `LICENSE` (MIT), this changelog, Dependabot configuration, `.nvmrc` and an
  `engines` field.

## [0.1.0]

Initial development builds (Diff-Checker, YML-Validator, Grammar-Polisher,
Authenticator, JSON-Studio), distributed unversioned.
