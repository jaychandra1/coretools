/* ============================================================
   CoreTools — download configuration (single source of truth)
   ------------------------------------------------------------
   The installers are built by GitHub Actions on real Windows/macOS/Linux
   machines and published into this site's `downloads/` folder, so these are
   plain same-site paths — visitors download straight from your domain.

   The GitHub Actions workflow (.github/workflows/build-installers.yml) writes
   the files under stable names, so these paths never need to change across
   versions. Just bump `version` for display.

   Note: the files won't exist until the workflow has run at least once and
   Vercel has redeployed with them.
   ============================================================ */
window.CORETOOLS_DOWNLOADS = {
  // Current release version, shown across the site.
  version: "0.1.0",

  // Fallback if a platform link is ever removed (kept same-site).
  releaseUrl: "/#download",

  // In-browser version of the tool (no install). Served at /app on the deploy.
  webAppUrl: "/app/",

  // Same-site installer paths, served by Vercel from website/downloads/.
  // Built and committed automatically by the installer workflow.
  platforms: {
    windows: {
      label: "Windows",
      ext: ".exe",
      note: "Windows 10 / 11 (64-bit)",
      size: "",
      url: "/downloads/CoreTools-Windows-Setup.exe",
    },
    macos: {
      label: "macOS",
      ext: ".dmg",
      note: "macOS 11+ (Universal)",
      size: "",
      url: "/downloads/CoreTools-macOS.dmg",
    },
    linux: {
      label: "Linux",
      ext: ".AppImage",
      note: "Linux (x86-64)",
      size: "",
      url: "/downloads/CoreTools-Linux.AppImage",
    },
  },
};
