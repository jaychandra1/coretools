/**
 * The Microsoft Store package (MSIX) of the Windows app. Tauri makes no MSIX,
 * so this lays one out and packs it with the Windows SDK's makeappx:
 *
 *   node scripts/msix.mjs check [--print-manifest yes]
 *   node scripts/msix.mjs pack --exe src-tauri/target/release/coretools.exe --out-dir store
 *
 * `check` validates the package identity and fills in the manifest without
 * packing anything (the release's first job runs it, so a typo fails in
 * seconds, not after the builds); --print-manifest yes shows the result.
 * `pack` puts the app binary, the Store logos from src-tauri/icons
 * and src-tauri/msix/AppxManifest.xml (filled in) into a package named
 * CoreTools_<version>_x64.msix in --out-dir.
 *
 * The identity is the one Partner Center reserved for CoreTools (the app →
 * Product management → Product identity), from environment variables — the
 * release workflow passes the repository variables of the same names:
 *
 *   MSIX_IDENTITY_NAME            Package/Identity/Name
 *   MSIX_PUBLISHER                Package/Identity/Publisher (CN=…)
 *   MSIX_PUBLISHER_DISPLAY_NAME   Package/Properties/PublisherDisplayName
 *
 * All three or none: none means the Store package is switched off. The
 * version is package.json's as x.y.z.0 (the Store reserves the fourth part).
 * The package is not signed — the Store signs it during certification, and
 * an unsigned package installs nowhere else. makeappx is taken from MAKEAPPX
 * when set, else from the newest Windows SDK on this machine.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function fail(message) {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `msix: ${message}`);
  process.exit(1);
}

// ---- identity and version -------------------------------------------------------

const IDENTITY = {
  MSIX_IDENTITY_NAME: {
    // The manifest's ST_PackageName.
    valid: (v) => /^[A-Za-z0-9.-]{3,50}$/.test(v),
    rule: "3–50 letters, digits, dots and hyphens, e.g. 12345JDGInitiates.CoreTools",
  },
  MSIX_PUBLISHER: {
    valid: (v) => /^CN=\S/.test(v) && v.length <= 8192,
    rule: "the distinguished name Partner Center shows, starting CN=",
  },
  MSIX_PUBLISHER_DISPLAY_NAME: {
    valid: (v) => v.trim() === v && v.length >= 1 && v.length <= 256,
    rule: "your publisher display name, 1–256 characters",
  },
};

/** The identity from the environment, or null when none of it is set. */
function readIdentity() {
  const values = Object.fromEntries(Object.keys(IDENTITY).map((key) => [key, process.env[key] ?? ""]));
  const set = Object.keys(values).filter((key) => values[key] !== "");
  if (set.length === 0) return null;
  const missing = Object.keys(values).filter((key) => values[key] === "");
  if (missing.length) {
    fail(`The Microsoft Store identity is half-configured: set ${missing.join(", ")} as well, or none of them (DEPLOYMENT.md, Microsoft Store).`);
  }
  for (const [key, { valid, rule }] of Object.entries(IDENTITY)) {
    if (!valid(values[key])) fail(`${key} must be ${rule} (got "${values[key]}").`);
  }
  return values;
}

/** package.json's version as the Store wants it: x.y.z.0, each part 0–65535, x ≥ 1. */
function storeVersion() {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const parts = match ? match.slice(1).map(Number) : [];
  if (!match || parts[0] < 1 || parts.some((part) => part > 65535)) {
    fail(`package.json's version "${version}" can't be a Store version (x.y.z, x ≥ 1, each part up to 65535).`);
  }
  return { version, packageVersion: `${parts.join(".")}.0` };
}

// ---- pack ---------------------------------------------------------------------------

const xml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

/** The newest Windows SDK's makeappx, unless MAKEAPPX names one. */
function findMakeappx() {
  if (process.env.MAKEAPPX) {
    if (!existsSync(process.env.MAKEAPPX)) fail(`MAKEAPPX points to a missing file: ${process.env.MAKEAPPX}`);
    return process.env.MAKEAPPX;
  }
  const bin = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  const versions = existsSync(bin) ? readdirSync(bin).filter((name) => /^10\.\d+\.\d+\.\d+$/.test(name)) : [];
  const newestFirst = versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  for (const version of newestFirst) {
    const tool = join(bin, version, "x64", "makeappx.exe");
    if (existsSync(tool)) return tool;
  }
  fail("makeappx.exe wasn't found: install the Windows SDK, or set MAKEAPPX to its path.");
}

const ASSETS = ["StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png"];

/** src-tauri/msix/AppxManifest.xml with every {{field}} filled in, XML-escaped. */
function renderManifest(identity, packageVersion, executable) {
  const fields = {
    IDENTITY_NAME: identity.MSIX_IDENTITY_NAME,
    PUBLISHER: identity.MSIX_PUBLISHER,
    PUBLISHER_DISPLAY_NAME: identity.MSIX_PUBLISHER_DISPLAY_NAME,
    VERSION: packageVersion,
    EXECUTABLE: executable,
  };
  let manifest = readFileSync(join(root, "src-tauri", "msix", "AppxManifest.xml"), "utf8");
  for (const [key, value] of Object.entries(fields)) manifest = manifest.replaceAll(`{{${key}}}`, xml(value));
  const unfilled = /\{\{\w+\}\}/.exec(manifest);
  if (unfilled) fail(`AppxManifest.xml has a field this script doesn't fill: ${unfilled[0]}`);
  return manifest;
}

function pack(args) {
  const identity = readIdentity();
  if (!identity) fail("No Microsoft Store identity is set (MSIX_IDENTITY_NAME, MSIX_PUBLISHER, MSIX_PUBLISHER_DISPLAY_NAME).");
  if (!args.exe || !args["out-dir"]) fail("pack needs --exe <app binary> and --out-dir <folder>.");
  const exe = resolve(args.exe);
  if (!existsSync(exe)) fail(`The app binary ${args.exe} doesn't exist — build the app first.`);
  const { version, packageVersion } = storeVersion();
  const makeappx = findMakeappx();

  const layout = mkdtempSync(join(tmpdir(), "coretools-msix-"));
  try {
    copyFileSync(exe, join(layout, basename(exe)));
    mkdirSync(join(layout, "Assets"));
    for (const asset of ASSETS) copyFileSync(join(root, "src-tauri", "icons", asset), join(layout, "Assets", asset));

    writeFileSync(join(layout, "AppxManifest.xml"), renderManifest(identity, packageVersion, basename(exe)));

    const outDir = resolve(args["out-dir"]);
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, `CoreTools_${version}_x64.msix`);
    // makeappx validates the manifest against the schema while packing.
    execFileSync(makeappx, ["pack", "/o", "/d", layout, "/p", out], { stdio: "inherit" });

    const sha256 = createHash("sha256").update(readFileSync(out)).digest("hex");
    console.log(`\n${basename(out)} — version ${packageVersion}, ${statSync(out).size} bytes`);
    console.log(`SHA-256 ${sha256}`);
    console.log(`Identity ${identity.MSIX_IDENTITY_NAME} · ${identity.MSIX_PUBLISHER} · ${identity.MSIX_PUBLISHER_DISPLAY_NAME}`);
  } finally {
    rmSync(layout, { recursive: true, force: true });
  }
}

// ---- command line -------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i].startsWith("--")) fail(`Unexpected argument: ${rest[i]}`);
  args[rest[i].slice(2)] = rest[i + 1];
}

if (command === "check") {
  const identity = readIdentity();
  if (identity) {
    const { packageVersion } = storeVersion();
    const manifest = renderManifest(identity, packageVersion, "coretools.exe");
    if (args["print-manifest"] === "yes") console.log(manifest);
    console.log(`Microsoft Store package: on — ${identity.MSIX_IDENTITY_NAME}, version ${packageVersion}.`);
  } else {
    console.log("Microsoft Store package: off (no MSIX_* repository variables).");
  }
} else if (command === "pack") {
  pack(args);
} else {
  fail("usage: node scripts/msix.mjs check | pack --exe <app binary> --out-dir <folder>");
}
