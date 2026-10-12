/* ============================================================
   CoreTools — download configuration (single source of truth)
   ------------------------------------------------------------
   Installers are built by GitHub Actions when a version tag is pushed
   (.github/workflows/release.yml) and published to GitHub Releases with
   STABLE asset names. The links below use the "latest" alias, so they always
   point at the newest release and never need to change across versions:

     https://github.com/<owner>/<repo>/releases/latest/download/<asset>

   `version` is kept in sync with package.json by scripts/sync-version.mjs
   (CI fails on drift) — never edit it by hand.

   Older versions remain downloadable from the Releases page, each with its
   own SHA256SUMS.txt.
   ============================================================ */
window.CORETOOLS_DOWNLOADS = {
  // Current release version, shown across the site (synced from package.json).
  version: "0.3.0",

  // All published versions + per-release checksums.
  releaseUrl: "https://github.com/jaychandra1/coretools/releases",

  // The latest release's checksum file.
  checksumsUrl:
    "https://github.com/jaychandra1/coretools/releases/latest/download/SHA256SUMS.txt",

  // In-browser version of the tool (no install). Served at /app on the deploy.
  webAppUrl: "/app/",

  // Stable "latest" asset URLs on GitHub Releases.
  platforms: {
    windows: {
      label: "Windows",
      ext: ".exe",
      note: "Windows 10 / 11 (64-bit)",
      size: "",
      url: "https://github.com/jaychandra1/coretools/releases/latest/download/CoreTools-Windows-Setup.exe",
    },
    macos: {
      label: "macOS",
      ext: ".dmg",
      note: "macOS 11+ (Universal)",
      size: "",
      url: "https://github.com/jaychandra1/coretools/releases/latest/download/CoreTools-macOS.dmg",
    },
    linux: {
      label: "Linux",
      ext: ".AppImage",
      note: "Linux (x86-64)",
      size: "",
      url: "https://github.com/jaychandra1/coretools/releases/latest/download/CoreTools-Linux.AppImage",
    },
  },
};
