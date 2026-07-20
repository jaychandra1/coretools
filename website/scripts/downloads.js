/* ============================================================
   CoreTools — download configuration (single source of truth)
   ------------------------------------------------------------
   This is the ONLY file you need to edit to publish new builds.
   Replace each `url` with the HTTPS link to the real artifact and
   update `version` / `size`. See website/README.md for details.

   Using "#" as a url keeps the button visibly disabled-looking and
   prevents a broken download until a real link is provided.
   ============================================================ */
window.CORETOOLS_DOWNLOADS = {
  // Current release version, shown across the site.
  version: "0.1.0",

  // Link to release notes / checksums (HTTPS). Placeholder for now.
  releaseUrl: "#",

  // Per-platform artifacts. `key` must match the `data-os` on the card.
  platforms: {
    windows: {
      label: "Windows",
      ext: ".msi",
      note: "Windows 10 / 11 (64-bit)",
      size: "", // e.g. "~6.2 MB" — leave "" if unknown
      url: "#", // TODO: https://downloads.coretools.app/0.1.0/CoreTools_0.1.0_x64.msi
    },
    macos: {
      label: "macOS",
      ext: ".dmg",
      note: "macOS 11+ (Universal)",
      size: "",
      url: "#", // TODO: https://downloads.coretools.app/0.1.0/CoreTools_0.1.0_universal.dmg
    },
    linux: {
      label: "Linux",
      ext: ".AppImage",
      note: "AppImage / .deb",
      size: "",
      url: "#", // TODO: https://downloads.coretools.app/0.1.0/CoreTools_0.1.0_amd64.AppImage
    },
  },
};
