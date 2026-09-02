# Changelog

All notable changes to CoreTools are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

Releases are cut by tagging: `git tag vX.Y.Z && git push origin vX.Y.Z`
(after `node scripts/sync-version.mjs` — CI refuses tags that don't match
`package.json`).

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
