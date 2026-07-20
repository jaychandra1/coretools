# Build artifacts

This directory is an optional place to self-host CoreTools installers if you are
not using GitHub Releases or a CDN.

Drop the files produced by `npm run tauri build` here, for example:

```
downloads/
├── CoreTools_0.1.0_x64.msi              # Windows
├── CoreTools_0.1.0_universal.dmg        # macOS
└── CoreTools_0.1.0_amd64.AppImage       # Linux
```

Then set the matching `url` in `../scripts/downloads.js` to a relative path,
e.g. `downloads/CoreTools_0.1.0_x64.msi`.

**Always serve these over HTTPS.** Do not commit large binaries to git if you
can avoid it — prefer GitHub Releases or object storage (see `../README.md`).
