# Changelog

All notable changes to CoreTools are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

Releases: write notes under `## [Unreleased]` as you go. Then run
**Actions → Prepare release** with the new version; it moves the notes under
the version heading, bumps every version string and opens a pull request.
Merging it lets CI tag the release, which builds, signs and publishes it.
Where `master` accepts direct pushes, `npm version X.Y.Z -m "release: v%s"`
followed by `git push origin HEAD --follow-tags` still works: `npm version`
moves the notes itself, into the same commit and tag, and refuses before
changing anything when `## [Unreleased]` is empty.

## [Unreleased]

## [1.2.6] — 2026-10-16

### Added

- **Update now, inside the app.** When a new version is out, *Update now*
  downloads it, checks its signature, installs it and restarts CoreTools —
  with progress in the banner, and your data kept. Only updates signed by
  the CoreTools release process install. Until updates are signed (and for
  copies installed before this version) the button downloads the installer
  for your system directly, instead of opening the release page.

## [1.2.5] — 2026-10-15

### Added

- **Put your logins in your own order.** *Reorder* (next to the space tabs)
  lets you drag logins by their handle or move them with the arrows; every
  view — All, each space — shows them in that order. *Sort A–Z* goes back to
  alphabetical. New logins are added at the end. The order is encrypted with
  your vault and kept on this computer. Reordering pauses while a search or
  filter is active.

### Changed

- **Update notifications check about once an hour** (was every 6 hours), and
  also when you switch back to the app, so a new version shows up soon after
  it's published. Each check reads one small public file; nothing about you
  is sent.

## [1.2.4] — 2026-10-15

### Fixed

- **Installing an update no longer risks your saved data.** Installing a
  newer version over an older one ran the old version's uninstaller with its
  "Delete the application data" checkbox, which erased your Authenticator
  accounts and saved logins if ticked. The installer now asks you to close
  CoreTools, then removes the old version as an update: your data, settings
  and shortcuts are always kept, and no such choice is shown. This protects
  the update *from* any earlier version.
- **Uninstalling asks before erasing your data.** In a real uninstall,
  ticking "Delete the application data" now shows what it permanently
  erases, with *No* as the default.

## [1.2.3] — 2026-10-15

### Added

- **Hide the All tab in the Credential Manager.** Once every login is in a
  space, a *Show All* switch appears at the right of the space tabs; turn it
  off to see only your spaces. The choice is remembered on this computer. A
  login without a space (added, edited or restored) brings All back on its
  own, so no login can drop out of sight.
- **Order your spaces.** Drag a space tab onto another to move it there, or
  use the arrows in *Manage spaces*. All stays first. Renaming or removing
  a space keeps the rest of your order; a new space goes at the end. The
  order is encrypted with your vault and kept on this computer (backups
  carry each login's space, not the tab order).

### Fixed

- **Update notifications now actually notice new versions.** The app only
  looked once a day, and only when it was opened, so a release could go
  unnoticed for a day or more, and never while the app stayed open. It now
  checks when it opens and every few hours while it's open (at most every
  6 hours; a failed check retries after an hour). A new version shows as a
  banner with *Download* and *Later* (which hides it until the next
  version), besides the header pill. A found update is remembered across
  restarts.

## [1.2.1] — 2026-10-14

### Added

- **Spaces in the Credential Manager.** Split your logins into tabs such as
  Personal, Dev team or Organisation. Each login can be in one space, and
  All always lists every login. Create a space from the tab bar or while
  adding or editing a login; rename, merge or remove spaces under *Manage
  spaces* (removing one never deletes logins). The space is encrypted with
  the rest of the login's details and included in backups. Backups and
  logins from earlier versions open with no space, under All.

### Changed

- **Uninstalling on Windows with "Delete the application data" ticked now
  also signs this computer out of Google Drive backup.** The sign-in is kept
  in Windows Credential Manager, which uninstalling never touched, so a
  reinstall showed the account as still connected. A plain uninstall, and
  every update, still keep it. To also revoke access at Google, use
  *Disconnect* before uninstalling.

## [1.2.0] — 2026-10-13

### Upgrade notes

- **Your vault upgrades the first time you type your master password.** It
  takes about a second, once. Windows Hello keeps working.
- **No going back to 1.1 after that.** Earlier versions can't open an
  upgraded vault (they report a wrong password) and can't read backups made
  by this version (they say it was made by a newer version). If you might
  need an older version, export an encrypted backup file first.
- New master passwords need at least 12 characters and must not be easily
  guessed. An existing shorter one keeps working; you'll be asked to change it.

### Security

- **Stronger protection for the master password (Argon2id).** It now
  unlocks a random data key through Argon2id (64 MiB of memory per guess)
  instead of PBKDF2. A stolen backup costs an attacker far more per
  password guess, and password changes re-key everything.
- **Account and login names are encrypted on disk.** Issuers, account names,
  platforms, URLs, usernames, categories, owners and tags are sealed with
  the vault key. They're decrypted into memory only while unlocked.
- **Copied passwords and codes stay out of clipboard history.** The desktop
  app marks them so Windows clipboard history (Win+V), the Windows cloud
  clipboard and clipboard managers on macOS and Linux skip them.
- **Tamper-evident activity log.** Credential Manager events are encrypted
  and hash-chained. The log shows whether its integrity is verified, and can
  be exported for an auditor.
- **Windows Hello asks for the master password every 14 days**, so it isn't
  forgotten — you need it to restore a backup on a new device.
- **The vault refuses to change its key if any part of it isn't loaded**,
  instead of risking saved logins that could no longer be decrypted.
- **JSON-Studio keeps its recovery copy for 24 hours only.** It doesn't write
  one at all when the document looks like it holds a credential (cloud keys,
  tokens, private keys, password fields), and recovery can be switched off.
- **Releases are signed and gated.** `SHA256SUMS.txt` is signed with Sigstore
  (keyless; `SHA256SUMS.txt.sigstore.json`), and each release ships a
  CycloneDX SBOM covered by that signature. A release builds only commits
  already on `master`, its CHANGELOG notes must exist, and installers are
  code-signed as soon as signing credentials are configured. The website
  deploys from a `production` branch that CI moves only after its checks pass.

### Added

- **Encrypted backup files.** Each section's settings can export its data to
  a file and restore one. Files use the same end-to-end encryption as the
  Drive backups and work without Google — on any device, with your password.
- **Update notifications (opt-in, desktop).** Once a day, if you allow it,
  CoreTools reads the public release index and tells you when a newer version
  is out. Nothing is downloaded or installed automatically.
- **About & diagnostics** (click the version in the header). Copy a support
  report with versions, states and recent error causes — never names,
  secrets or account details. Errors are now recorded locally with their
  cause instead of a generic "network" message.
- **Deletions carry across devices.** Deleting an account or permanently
  deleting a login is remembered (as a one-way hash) and travels in the
  backup, so merging an older backup no longer brings it back, and a merge
  applies deletions made on your other devices.

### Changed

- **Each module now backs up separately to Google Drive.** Authenticator
  accounts are saved as `coretools-authenticator-<time>-<device>.json` and
  Credential Manager logins as `coretools-credmanager-<time>-<device>.json`.
  Each series has its own versions, conflict check and "pending" state.
  Adding a login no longer re-uploads your 2FA accounts, and a conflict in one
  module never pauses backups of the other. Older single-file backups appear
  under the Authenticator and restore its accounts.
- **A year of backup history.** Instead of only the newest 10 versions, each
  series keeps the newest 10, then one per hour for a day, one per day for a
  month and one per month for a year. The last version before a big shrink
  (a mass deletion) is always kept.
- **Gentler on Google's quota.** Automatic backups are combined into at most
  one every 5 minutes, and retries after an outage are spread out randomly
  instead of every copy retrying at the same moment.
- **Each section shows only its own things.** The Authenticator's settings
  show its backup status, versions, "Back up now", restore and delete; the
  Credential Manager's settings show its own. The Google connection is shared.
- **The cloud backup panel no longer shows the Drive folder path or file
  name**, and the "Open Google Drive settings" button is gone.
- **Faster start.** JSON-Studio's editor, the YAML validator and the grammar
  tool load the first time you open them; the startup bundle is a tenth of
  its former size.
- CI runs browser end-to-end tests, tests of the vault and backup state
  machines against a real IndexedDB, the Rust unit tests and a Windows build
  check. Patch updates from Dependabot merge automatically once CI passes.

### Fixed

- **Data saved by a newer version** now shows a clear message instead of a
  generic failure, and is never modified.
- **The website shows the version you actually download.** The download
  cards read the newest published release (`coretools/releases/latest.json`)
  instead of a version baked in at build time.
- **Google Drive "403" errors are told apart.** Full storage, rate limiting
  (retried automatically), a Workspace administrator's policy, and revoked
  permission each get their own message.
- **No more "http://tauri.localhost wants to use your cameras" prompt** in
  the Windows app. The app answers WebView2's camera request itself when you
  start the QR scanner, for the camera only.

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
