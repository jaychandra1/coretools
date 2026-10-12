/* ============================================================
   CoreTools — download configuration (single source of truth)
   ------------------------------------------------------------
   The source repo is private; installers are published by GitHub Actions
   (.github/workflows/release.yml) to the PUBLIC repository
   jaychandra1/artifacts, which hosts several applications:

     release coretools-v<version>   one per version, kept forever
     release coretools-latest       same files, replaced by every newer
                                    release — the links below point here,
                                    so they never change across versions
     coretools/releases/            generated index: version history,
                                    checksums, latest.json

   `version` is kept in sync with package.json by scripts/sync-version.mjs
   (CI fails on drift) — never edit it by hand.
   ============================================================ */
window.CORETOOLS_DOWNLOADS = {
  // Current release version, shown across the site (synced from package.json).
  version: "1.0.0",

  // All published versions + per-release checksums.
  releaseUrl: "https://github.com/jaychandra1/artifacts/tree/main/coretools/releases",

  // The latest release's checksum file.
  checksumsUrl:
    "https://github.com/jaychandra1/artifacts/releases/download/coretools-latest/SHA256SUMS.txt",

  // In-browser version of the tool (no install). Served at /app on the deploy.
  webAppUrl: "/app/",

  // Stable "latest" asset URLs in the public artifacts repository.
  platforms: {
    windows: {
      label: "Windows",
      ext: ".exe",
      note: "Windows 10 / 11 (64-bit)",
      size: "",
      url: "https://github.com/jaychandra1/artifacts/releases/download/coretools-latest/CoreTools-Windows-Setup.exe",
    },
    macos: {
      label: "macOS",
      ext: ".dmg",
      note: "macOS 11+ (Universal)",
      size: "",
      url: "https://github.com/jaychandra1/artifacts/releases/download/coretools-latest/CoreTools-macOS.dmg",
    },
    linux: {
      label: "Linux",
      ext: ".AppImage",
      note: "Linux (x86-64)",
      size: "",
      url: "https://github.com/jaychandra1/artifacts/releases/download/coretools-latest/CoreTools-Linux.AppImage",
    },
  },
};
