/* ============================================================
   CoreTools — download configuration (single source of truth)
   ------------------------------------------------------------
   This is the ONLY file you need to edit to publish new builds.

   How downloads resolve:
   • If a platform's `url` is a real HTTPS link, the button downloads it
     directly.
   • If a platform's `url` is empty, the button falls back to `releaseUrl`
     (the GitHub Releases page) so it always works — the visitor just picks
     the matching asset. Fill in the direct `url`s for one-click downloads.

   See website/README.md and DEPLOYMENT.md for the full workflow.
   ============================================================ */
window.CORETOOLS_DOWNLOADS = {
  // Current release version, shown across the site.
  version: "0.1.0",

  // Releases page (HTTPS). Buttons fall back here when a direct url is empty.
  // GitHub Actions publishes installers here when you push a version tag.
  releaseUrl: "https://github.com/jaychandra1/coretools/releases/latest",

  // In-browser version of the tool (no install). Served at /app on the deploy.
  webAppUrl: "/app/",

  // Per-platform artifacts. `key` must match the `data-os` on the card.
  // Leave `url` as "" to fall back to the Releases page; set a direct HTTPS
  // link (e.g. a release asset) for a one-click download.
  // Direct one-click download links to the GitHub Release assets for the
  // version above. These become live once you publish the `v0.1.0` release
  // (built by .github/workflows/release.yml).
  //
  // IMPORTANT: after the first release is built, open it on GitHub and confirm
  // these filenames match the actual asset names. Tauri names them
  // `<productName>_<version>_<arch>...`; if yours differ, correct them here.
  // When you cut a new version, bump `version` above and the `v0.1.0` segment
  // in these three URLs.
  platforms: {
    windows: {
      label: "Windows",
      ext: ".exe",
      note: "Windows 10 / 11 (64-bit)",
      size: "",
      url: "https://github.com/jaychandra1/coretools/releases/download/v0.1.0/CoreTools_0.1.0_x64-setup.exe",
    },
    macos: {
      label: "macOS",
      ext: ".dmg",
      note: "macOS 11+ (Universal)",
      size: "",
      url: "https://github.com/jaychandra1/coretools/releases/download/v0.1.0/CoreTools_0.1.0_universal.dmg",
    },
    linux: {
      label: "Linux",
      ext: ".AppImage",
      note: "Linux (x86-64)",
      size: "",
      url: "https://github.com/jaychandra1/coretools/releases/download/v0.1.0/CoreTools_0.1.0_amd64.AppImage",
    },
  },
};
