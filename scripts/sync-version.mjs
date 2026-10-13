/**
 * Single-source the app version.
 *
 * `package.json` is the source of truth; this script propagates its `version`
 * into the three other places that carry one:
 *   - src-tauri/Cargo.toml        (package.version)
 *   - src-tauri/tauri.conf.json   (version)
 *   - website/scripts/downloads.js (CORETOOLS_DOWNLOADS.version)
 *   - src-tauri/Cargo.lock        (the app crate's own entry — only once the
 *                                  lockfile is committed; a stale entry fails
 *                                  `cargo metadata --locked` in CI)
 *
 * Usage:
 *   npm version 0.3.0                       # bump package.json + lockfile,
 *                                           # sync the three targets, commit, tag
 *   node scripts/sync-version.mjs           # rewrite the three targets
 *   node scripts/sync-version.mjs --check   # exit 1 if any target disagrees
 *   node scripts/sync-version.mjs --git-add # rewrite, then `git add` every
 *                                           # target that exists (for the
 *                                           # npm `version` hook)
 *
 * `npm version` is the release command. It bumps package.json and
 * package-lock.json, then runs the `version` script (this file, plus
 * `git add` of the three targets) before it commits and tags. CI runs
 * --check on every push and before every release, so the four copies can
 * never drift again. Zero dependencies.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const gitAdd = process.argv.includes("--git-add") && !checkOnly;

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`package.json version "${version}" is not a valid semver string`);
  process.exit(1);
}

// The app crate's name, for its entry in Cargo.lock.
const crate =
  /^\[package\][\s\S]*?^name = "([\w-]+)"/m.exec(
    readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"),
  )?.[1] ?? "coretools";

/**
 * Each target: file path, a pattern locating its version, and a replacement.
 * `optional` targets are skipped while the file doesn't exist.
 */
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
  {
    file: "src-tauri/Cargo.lock",
    optional: true,
    pattern: new RegExp(`(?<=^\\[\\[package\\]\\]\\r?\\nname = "${crate}"\\r?\\n)version = "([^"]+)"`, "m"),
    replace: `version = "${version}"`,
  },
];

let drift = false;
const present = [];

for (const target of targets) {
  const path = join(root, target.file);
  if (target.optional && !existsSync(path)) continue;
  present.push(target.file);
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

// Stage exactly the files this script owns — including Cargo.lock once it
// exists — so `npm version` commits them with package.json.
if (gitAdd) execFileSync("git", ["add", "--", ...present], { cwd: root, stdio: "inherit" });
