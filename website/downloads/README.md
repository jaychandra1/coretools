# website/downloads

**Installers are no longer committed here.** They are built by
`.github/workflows/release.yml` when a version tag is pushed and published to
**GitHub Releases** with stable asset names; the site's download buttons
(`website/scripts/downloads.js`) point at the
`releases/latest/download/<asset>` URLs, so nothing in this directory is
served to visitors anymore.

Why the change (2026-09-02): committing ~90 MB of binaries per release grew
`.git` without bound, gave SmartScreen a fresh unknown hash on every push, and
made rollback impossible. Releases are now versioned, permanent, and each
ships its own `SHA256SUMS.txt` generated over the exact published files.

This directory exists only for the tracked README you are reading.
`*.exe`, `*.dmg`, `*.AppImage` and `SHA256SUMS.txt` here are gitignored —
anything you drop in locally stays local.

Historical note: installers committed before this change are still present in
old git history. Purging them (git filter-repo + force-push) is a coordinated,
history-rewriting operation — see DEPLOYMENT.md.
