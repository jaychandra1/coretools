/**
 * The in-app updater's manifest (Tauri's `updater.json`) for a release.
 *
 *   node scripts/updater-manifest.mjs --dir incoming --version 1.2.6 \
 *     --base-url https://github.com/<owner>/<repo>/releases/download/<tag> \
 *     [--notes-file notes.md] [--require]
 *
 * Reads each platform's update file and its minisign signature (`<file>.sig`,
 * made by release.yml's sign-updates job with `tauri signer sign`) from --dir
 * and writes --dir/updater.json. Each signature must name a version-carrying
 * file (`CoreTools_<version>_<target>.<ext>` in its trusted comment): installed
 * copies refuse any other, so a stale or mismatched signature fails here. The installed app fetches it from the stable
 * `coretools-latest` release, downloads the file for its platform from the
 * versioned release, and installs it only if the signature verifies against
 * the public key compiled into it — so this manifest needs no other
 * protection. With no signatures at all (updater key not configured) it
 * writes nothing and checks nothing else; --require makes a missing platform
 * an error.
 *
 * Installed copies accept only plain x.y.z versions (src-tauri/src/updates.rs,
 * `valid_version`), so a manifest is written only for those; Prepare release
 * and the release gate refuse pre-release versions up front.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nameCarriesVersion, signedFileName } from "./verify-update-signature.mjs";

/** Release file → the Tauri updater platform keys it serves. */
const TARGETS = [
  { file: "CoreTools-Windows-Setup.exe", platforms: ["windows-x86_64"] },
  // Universal build: one bundle for both Mac architectures.
  { file: "CoreTools-macOS.app.tar.gz", platforms: ["darwin-x86_64", "darwin-aarch64"] },
  { file: "CoreTools-Linux.AppImage", platforms: ["linux-x86_64"] },
];

function fail(message) {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `updater-manifest: ${message}`);
  process.exit(1);
}

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i].replace(/^--/, "");
  if (key === "require") args.require = true;
  else args[key] = argv[++i];
}
for (const name of ["dir", "version", "base-url"]) {
  if (!args[name]) fail(`missing --${name}`);
}
if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w.-]+$/.test(args["base-url"])) {
  fail(`--base-url must be a GitHub release download URL, got "${args["base-url"]}"`);
}

const present = [];
const missing = [];
for (const target of TARGETS) {
  const path = join(args.dir, target.file);
  if (existsSync(path) && existsSync(`${path}.sig`)) present.push(target);
  else missing.push(target.file);
}

if (present.length === 0) {
  if (args.require) fail(`no signed update files in ${args.dir} (missing: ${missing.join(", ")})`);
  console.log("No update signatures — the updater key isn't configured; no updater.json written.");
  process.exit(0);
}
if (args.require && missing.length) fail(`signed update files missing: ${missing.join(", ")}`);
if (!/^\d+\.\d+\.\d+$/.test(args.version)) {
  fail(`--version must be x.y.z, got "${args.version}" — installed copies accept no other update version (src-tauri/src/updates.rs)`);
}

const platforms = {};
for (const { file, platforms: keys } of present) {
  const signature = readFileSync(join(args.dir, `${file}.sig`), "utf8").trim();
  // A minisign signature file, base64-encoded by Tauri.
  if (!/^[A-Za-z0-9+/=]{40,}$/.test(signature)) fail(`${file}.sig doesn't look like a Tauri update signature`);
  const signedName = signedFileName(signature);
  if (!nameCarriesVersion(signedName, args.version)) {
    fail(`${file}.sig signs "${signedName || "?"}", which doesn't carry _${args.version}_ — installed copies would refuse it`);
  }
  for (const key of keys) platforms[key] = { signature, url: `${args["base-url"]}/${file}` };
}

const notes = args["notes-file"] && existsSync(args["notes-file"]) ? readFileSync(args["notes-file"], "utf8").trim() : "";
const manifest = {
  version: args.version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms,
};
writeFileSync(join(args.dir, "updater.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`updater.json: v${args.version} for ${Object.keys(platforms).join(", ")}`);
