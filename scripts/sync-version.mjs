/**
 * Single-source the app version.
 *
 * `package.json` is the source of truth; this script propagates its `version`
 * into the three other places that carry one:
 *   - src-tauri/Cargo.toml        (package.version)
 *   - src-tauri/tauri.conf.json   (version)
 *   - website/scripts/downloads.js (CORETOOLS_DOWNLOADS.version)
 *
 * Usage:
 *   npm version 0.3.0                       # bump package.json + lockfile,
 *                                           # sync the three targets, commit, tag
 *   node scripts/sync-version.mjs           # rewrite the three targets
 *   node scripts/sync-version.mjs --check   # exit 1 if any target disagrees
 *
 * `npm version` is the release command. It bumps package.json and
 * package-lock.json, then runs the `version` script (this file, plus
 * `git add` of the three targets) before it commits and tags. CI runs
 * --check on every push and before every release, so the four copies can
 * never drift again. Zero dependencies.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`package.json version "${version}" is not a valid semver string`);
  process.exit(1);
}

/** Each target: file path, a pattern locating its version, and a replacement. */
const targets = [
  {
    file: "src-tauri/Cargo.toml",
    pattern: /^version = "([^"]+)"/m,
    replace: `version = "${version}"`,
  },
  {
    file: "src-tauri/tauri.conf.json",
    pattern: /"version": "([^"]+)"/,
    replace: `"version": "${version}"`,
  },
  {
    file: "website/scripts/downloads.js",
    pattern: /version: "([^"]+)"/,
    replace: `version: "${version}"`,
  },
];

let drift = false;

for (const target of targets) {
  const path = join(root, target.file);
  const content = readFileSync(path, "utf8");
  const match = target.pattern.exec(content);
  if (!match) {
    console.error(`${target.file}: version pattern not found`);
    process.exit(1);
  }
  if (match[1] === version) {
    console.log(`${target.file}: ${version} ✓`);
    continue;
  }
  if (checkOnly) {
    console.error(`${target.file}: has ${match[1]}, expected ${version}`);
    drift = true;
  } else {
    writeFileSync(path, content.replace(target.pattern, target.replace));
    console.log(`${target.file}: ${match[1]} -> ${version}`);
  }
}

if (drift) {
  console.error(
    "\nVersion drift detected. Bump with `npm version <x.y.z>`, or run `node scripts/sync-version.mjs` if package.json is already set.",
  );
  process.exit(1);
}
