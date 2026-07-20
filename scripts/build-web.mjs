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
for (const entry of ["index.html", "styles", "scripts"]) {
  const from = join(website, entry);
  if (existsSync(from)) {
    cpSync(from, join(dist, entry), { recursive: true });
    console.log(`copied website/${entry} -> dist/${entry}`);
  }
}

console.log("Web deploy assembled: marketing at '/', app at '/app/'.");
