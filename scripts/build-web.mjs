/**
 * Assembles the public web deploy in `dist/`:
 *   dist/            ← marketing site (from website/) served at "/"
 *   dist/app/        ← the CoreTools tool app (from `vite build --mode web`)
 *
 * Run AFTER `vite build --mode web` (see the `build:web` npm script). Zero
 * dependencies so it runs the same locally and on Vercel (Linux).
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const website = join(root, "website");

if (!existsSync(join(dist, "app"))) {
  console.error(
    "Expected dist/app to exist. Run `vite build --mode web` before this script."
  );
  process.exit(1);
}

mkdirSync(dist, { recursive: true });

// Copy the static marketing assets to the dist root. `dist/app` is left intact.
// Installer binaries are NOT part of the web deploy (they live on GitHub
// Releases); the filter keeps any locally-built ones out of dist so local and
// Vercel builds stay identical.
const isInstaller = (p) => /\.(exe|dmg|AppImage)$/i.test(p) || /SHA256SUMS\.txt$/.test(p);
for (const entry of ["index.html", "privacy.html", "styles", "scripts", "assets", "downloads"]) {
  const from = join(website, entry);
  if (existsSync(from)) {
    cpSync(from, join(dist, entry), { recursive: true, filter: (src) => !isInstaller(src) });
    console.log(`copied website/${entry} -> dist/${entry}`);
  }
}

console.log("Web deploy assembled: marketing at '/', app at '/app/'.");
