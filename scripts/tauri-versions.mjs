/**
 * The Tauri packages on both sides are on the same major.minor release.
 *
 * `tauri build` refuses to run when the Rust crate `tauri` and the npm
 * package `@tauri-apps/api` (and each plugin crate and its npm package,
 * where both are installed) are on different major/minor releases. Only the
 * release builds the app, so a mismatch — say, a fresh Cargo.lock resolving
 * a newer `tauri` than package-lock.json's API — used to surface there, after
 * CI had passed. This makes CI (and the release's first job) refuse it in
 * seconds, with the fix in the message.
 *
 *   node scripts/tauri-versions.mjs
 */

import { readFileSync } from "node:fs";

const npmLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf8").replaceAll("\r\n", "\n");

/** Every version of each registry crate in Cargo.lock. */
const crates = new Map();
for (const block of cargoLock.split("\n[[package]]\n").slice(1)) {
  const name = /^name = "([^"]+)"/m.exec(block)?.[1];
  const version = /^version = "([^"]+)"/m.exec(block)?.[1];
  if (name && version) crates.set(name, [...(crates.get(name) ?? []), version]);
}

const npmVersion = (name) => npmLock.packages?.[`node_modules/${name}`]?.version;
const minor = (version) => version.split(".").slice(0, 2).join(".");

const pairs = [["tauri", "@tauri-apps/api"]];
for (const name of crates.keys()) {
  const plugin = /^tauri-plugin-(.+)$/.exec(name)?.[1];
  if (plugin) pairs.push([name, `@tauri-apps/plugin-${plugin}`]);
}

const problems = [];
for (const [crate, pkg] of pairs) {
  const rust = crates.get(crate);
  const js = npmVersion(pkg);
  if (!rust || !js) continue; // only one side installed: nothing to match
  for (const version of rust) {
    if (minor(version) !== minor(js)) {
      problems.push(
        `${crate} ${version} (Cargo.lock) and ${pkg} ${js} (package-lock.json) are on different releases — run \`npm install ${pkg}@~${minor(version)}\` (the latest ${minor(version)}.x), or move ${crate} to ${minor(js)}.x in src-tauri/Cargo.lock.`,
      );
    } else {
      console.log(`${crate} ${version} ↔ ${pkg} ${js} ✓`);
    }
  }
}

if (problems.length) {
  for (const problem of problems) {
    console.error(process.env.GITHUB_ACTIONS ? `::error::${problem}` : problem);
  }
  console.error("`tauri build` refuses mismatched Tauri packages (the release would fail).");
  process.exit(1);
}
