# CoreTools — Product Website

A clean, minimal, **static** marketing/download site for CoreTools. Built with
plain HTML, CSS, and a little vanilla JavaScript — **no build step, no
framework, no dependencies, and no trackers.** This keeps the site fast,
auditable, and consistent with the product's privacy promise.

## Structure

```
website/
├── index.html            # All page markup (hero, features, privacy, download, footer)
├── styles/
│   └── main.css          # Single stylesheet; design tokens + responsive layout + dark mode
├── scripts/
│   ├── downloads.js      # ← EDIT THIS to publish builds (single source of truth)
│   └── main.js           # Progressive enhancement: OS detection, populate links, year/version
├── downloads/            # (Optional) host build artifacts here if self-serving
│   └── README.md
└── README.md             # This file
```

### Why plain HTML/CSS/JS?

- **Zero dependencies** → nothing to audit for supply-chain risk, nothing to
  update, smallest possible payload.
- **No trackers/analytics** by design — there is simply no third-party code.
- **Fully static** → serve from any static host or CDN over HTTPS.
- Still **modular**: content in `index.html`, presentation in `main.css`,
  configuration in `downloads.js`.

## Run locally

No tooling required — open `index.html` directly, or serve the folder:

```bash
# Python (any OS with Python installed)
cd website
python -m http.server 8080
# → http://localhost:8080

# or Node's one-liner
npx serve website
```

## How to add real download links

Everything lives in **`scripts/downloads.js`** — you do not need to touch the
HTML. Edit the `url`, `size`, and `version` fields:

```js
window.CORETOOLS_DOWNLOADS = {
  version: "0.1.0",
  releaseUrl: "https://github.com/<you>/coretools/releases/tag/v0.1.0",
  platforms: {
    windows: {
      label: "Windows",
      ext: ".msi",
      note: "Windows 10 / 11 (64-bit)",
      size: "~6.2 MB",
      url: "https://downloads.coretools.app/0.1.0/CoreTools_0.1.0_x64.msi",
    },
    macos:  { /* …set url + size… */ },
    linux:  { /* …set url + size… */ },
  },
};
```

Rules:

- A `url` of `"#"` renders the button as "not yet published" (marked
  `aria-disabled`). Replace it with a real **HTTPS** link to enable the download.
- The `data-os` attribute on each card in `index.html`
  (`windows` / `macos` / `linux`) must match the keys in `platforms`.
- `main.js` auto-fills the version label, footer year, release link, and
  highlights the card matching the visitor's detected OS.

### Where to host the build artifacts

Any HTTPS-served location works. Common options:

1. **GitHub Releases** (recommended): upload the installers produced by
   `npm run tauri build` as release assets and point each `url` at the asset's
   download link. GitHub serves them over HTTPS with checksums.
2. **Object storage / CDN**: e.g. an S3 bucket behind CloudFront, Cloudflare R2,
   etc. Enforce HTTPS-only access.
3. **Self-hosted** under `website/downloads/`: drop the files there and use
   relative URLs like `downloads/CoreTools_0.1.0_x64.msi`. Ensure your host
   forces HTTPS.

> The Tauri build outputs live under
> `src-tauri/target/release/bundle/` after `npm run tauri build`.

## Deploying securely (HTTPS)

The site is static, so any of these give you free automatic HTTPS:

- **GitHub Pages** — push `website/` (or set it as the Pages source).
- **Netlify / Vercel / Cloudflare Pages** — point at the repo; set the publish
  directory to `website`. No build command needed.
- **Any web server** (nginx/Apache) — serve the folder and enable TLS
  (e.g. via Let's Encrypt) with an HTTP→HTTPS redirect.

Recommended response headers for a hardened static deploy:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

(The site loads only same-origin assets, so a strict CSP works out of the box.)

## Editing content

- **Hero text / taglines** → `index.html`, `<section class="hero">`.
- **Feature copy** → `<section id="features">`.
- **Privacy points** → `<section id="privacy">`.
- **Contact email / copyright** → footer in `index.html`.
- **Colors / spacing / dark mode** → CSS variables at the top of `main.css`.
