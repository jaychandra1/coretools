/**
 * Release index + notes for the shared public artifacts repository.
 *
 * Source code stays in a private repo; installers are published as GitHub
 * Releases of the PUBLIC artifacts repo (e.g. jaychandra1/artifacts), which
 * serves several applications side by side:
 *
 *   Releases (the binaries — never committed to git):
 *     <app>-v<version>   one immutable release per version
 *     <app>-latest       same files, overwritten on every release, so
 *                        .../releases/download/<app>-latest/<file> is a
 *                        stable link per application
 *
 *   Files in the repo (small, generated — do not edit by hand):
 *     <app>/releases/README.md    latest links, checksums, version history
 *     <app>/releases/latest.json  machine-readable latest release
 *     <app>/releases/index.json   every published version (source of truth)
 *     <app>/releases/updater.json the newest version's in-app update manifest
 *                                 (when it has one) — committed together with
 *                                 latest.json, so the two always agree
 *     README.md                   app list between <!-- apps:start/end -->
 *
 * App-agnostic and dependency-free so other applications can reuse it as is.
 *
 * Usage:
 *   node scripts/artifacts-release.mjs notes --app coretools --name CoreTools \
 *     --version 0.3.0 --artifacts-repo jaychandra1/artifacts \
 *     --assets-dir incoming [--changelog CHANGELOG.md] [--summary "text"] \
 *     [--signer <workflow url>] [--code-signed Windows,macOS] \
 *     --out release-notes.md --latest-out latest-notes.md
 *
 *   node scripts/artifacts-release.mjs index --app coretools --name CoreTools \
 *     --version 0.3.0 --artifacts-repo jaychandra1/artifacts \
 *     --assets-dir incoming --repo-dir artifacts-repo [--date 2026-10-12] \
 *     [--rollout 1-100] [--check-after-hours 1-168] \
 *     [--withdraw 0.2.9[,0.2.8]] [--require-newest true]
 *
 * `--assets-dir` must contain the installers plus SHA256SUMS.txt
 * ("<sha256>  <file>" per line, as written by sha256sum). Other files listed
 * there — e.g. a CycloneDX SBOM (*.cdx.json), in-app update files (*.sig,
 * updater.json, a macOS *.app.tar.gz) — are published and indexed alongside
 * the installers. Every file in --assets-dir must be listed, except
 * SHA256SUMS.txt itself and its Sigstore bundle: whatever is published is
 * covered by the signed checksums.
 *
 * index options:
 *   --date               release date; default: the version's existing date in
 *                        the index (a re-publish keeps it), else today (UTC)
 *   --rollout N          staged rollout: installed copies read `rollout` from
 *                        latest.json and only N% of them offer this update.
 *                        Omitted = everyone (no field written)
 *   --check-after-hours  server back-off: installed copies check for updates
 *                        at most every N hours (`checkAfterHours`). Omitted =
 *                        the app's own schedule
 *   --withdraw V[,V…]    drop these versions from the index first (rollback:
 *                        the previous version becomes the newest again)
 *   --require-newest     fail (writing nothing) unless --version ends up the
 *                        newest version — for promote/rollback runs, whose only
 *                        purpose is to move the stable links
 * The rollout fields belong to the version's index entry; latest.json carries
 * the newest entry's.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- arguments ---------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i].startsWith("--")) fail(`Unexpected argument: ${rest[i]}`);
  args[rest[i].slice(2)] = rest[i + 1];
}

function fail(message) {
  console.error(`artifacts-release: ${message}`);
  process.exit(1);
}

function need(name) {
  const value = args[name];
  if (!value) fail(`--${name} is required`);
  return value;
}

const app = need("app");
const name = need("name");
const version = need("version");
const repo = need("artifacts-repo");
const assetsDir = need("assets-dir");

const SEMVER = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
if (!/^[a-z0-9][a-z0-9-]*$/.test(app)) fail(`--app must be a lowercase slug, got "${app}"`);
if (!SEMVER.test(version)) fail(`--version must be semver, got "${version}"`);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`--artifacts-repo must be owner/name, got "${repo}"`);

/** Optional whole number in [min, max]; absent or "" = undefined. */
function optionalInt(name, min, max) {
  const raw = args[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    fail(`--${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return Number(raw);
}

const tag = `${app}-v${version}`;
const latestTag = `${app}-latest`;
const downloadUrl = (releaseTag, file) =>
  `https://github.com/${repo}/releases/download/${releaseTag}/${file}`;
const folderUrl = `https://github.com/${repo}/tree/main/${app}/releases`;

// ---- assets ----------------------------------------------------------------------

/** Installers + checksum file from --assets-dir, checksums cross-checked. */
function readAssets() {
  const sumsPath = join(assetsDir, "SHA256SUMS.txt");
  if (!existsSync(sumsPath)) fail(`${sumsPath} not found`);
  const sums = new Map();
  for (const line of readFileSync(sumsPath, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  if (sums.size === 0) fail("SHA256SUMS.txt lists no files");

  const assets = [];
  for (const [file, sha256] of sums) {
    const path = join(assetsDir, file);
    if (!existsSync(path)) fail(`SHA256SUMS.txt lists ${file}, but it is missing`);
    assets.push({ name: file, size: statSync(path).size, sha256 });
  }
  // Everything in --assets-dir is uploaded, so everything must be covered.
  const unlisted = readdirSync(assetsDir).filter((file) => file !== "SHA256SUMS.txt" && file !== BUNDLE && !sums.has(file));
  if (unlisted.length) {
    fail(`${unlisted.join(", ")} would be published but ${unlisted.length > 1 ? "aren't" : "isn't"} listed in SHA256SUMS.txt — every published file must be covered by the checksums`);
  }
  const sumsSize = statSync(sumsPath).size;
  return { assets, sumsSize };
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Software bill of materials: CycloneDX/SPDX file, or "sbom" in the name. */
function isSbom(file) {
  return /\.(cdx|spdx)\.(json|xml)$/i.test(file) || /(^|[-_.])sbom([-_.]|$)/i.test(file);
}

/** In-app update files (Tauri): signatures, the manifest, macOS's .app archive. */
function isUpdateFile(file) {
  return /\.sig$/i.test(file) || file === "updater.json" || /\.app\.tar\.gz$/i.test(file);
}

/** Short platform hint from a file extension, or "SBOM" / "In-app update" (display only). */
function kind(file) {
  if (isUpdateFile(file)) return "In-app update";
  if (/\.(exe|msi)$/i.test(file)) return "Windows";
  if (/\.(dmg|pkg)$/i.test(file)) return "macOS";
  if (/\.(AppImage|deb|rpm)$/i.test(file)) return "Linux";
  if (isSbom(file)) return "SBOM";
  return "";
}

const PLATFORMS = ["Windows", "macOS", "Linux"];

/** "a", "a and b", "a, b and c" */
function listText(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Code-signing status line. --code-signed names the platforms whose
 * installers the release workflow signed (e.g. "Windows,macOS"); without it
 * every installer is reported as unsigned.
 */
function signingText(assets) {
  const signedPlatforms = (args["code-signed"] || "").split(",").map((s) => s.trim());
  const platforms = PLATFORMS.filter((p) => assets.some((a) => kind(a.name) === p));
  const yes = platforms.filter((p) => signedPlatforms.includes(p));
  const no = platforms.filter((p) => !signedPlatforms.includes(p));
  if (yes.length === 0) {
    return "Installers are currently unsigned; Windows SmartScreen or macOS Gatekeeper may warn.";
  }
  if (no.length === 0) return `The ${listText(yes)} installers are code-signed.`;
  return (
    `The ${listText(yes)} installer${yes.length > 1 ? "s are" : " is"} code-signed; ` +
    `the ${listText(no)} one${no.length > 1 ? "s are" : " is"} not — verify ${no.length > 1 ? "them" : "it"} against \`SHA256SUMS.txt\`.`
  );
}

/** One line per SBOM, saying what it is and that the checksums cover it. */
function sbomText(assets) {
  return assets
    .filter((a) => isSbom(a.name))
    .map((a) => {
      const format = /\.cdx\./i.test(a.name) ? "CycloneDX" : /spdx/i.test(a.name) ? "SPDX" : "";
      return (
        `\`${a.name}\` is the software bill of materials${format ? ` (${format})` : ""} for this release — ` +
        "every dependency it was built from, with versions. `SHA256SUMS.txt` lists it too, so the same checks cover it."
      );
    })
    .join("\n\n");
}

const BUNDLE = "SHA256SUMS.txt.sigstore.json";
/** Sigstore bundle present = the release workflow signed SHA256SUMS.txt. */
const signed = existsSync(join(assetsDir, BUNDLE));

/**
 * How to verify: checksums always; plus the Sigstore signature when the
 * release was signed (--signer = the signing workflow's URL, no ref). The
 * signature proves the checksums came from that workflow on a release tag —
 * the protection against a stolen publishing token (audit F-03).
 */
function verifyText(isSigned = signed) {
  const lines = [
    "Verify a download against `SHA256SUMS.txt`:",
    "",
    "- Windows (PowerShell): `Get-FileHash <file> -Algorithm SHA256`",
    "- macOS / Linux: `shasum -a 256 <file>`",
  ];
  if (isSigned && args.signer) {
    const identity = args.signer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    lines.push(
      "",
      `\`SHA256SUMS.txt\` is signed with [Sigstore](https://www.sigstore.dev/) by the release workflow. Check the signature first ([cosign](https://docs.sigstore.dev/cosign/system_config/installation/)), with \`${BUNDLE}\` beside it:`,
      "",
      "```",
      `cosign verify-blob SHA256SUMS.txt --bundle ${BUNDLE} \\`,
      `  --certificate-identity-regexp '^${identity}@refs/(tags/v.+|heads/master)$' \\`,
      "  --certificate-oidc-issuer https://token.actions.githubusercontent.com",
      "```",
      "",
      "A file that fails this check did not come from the CoreTools release pipeline — don't install it.",
    );
  }
  return lines.join("\n");
}

// ---- notes -----------------------------------------------------------------------

/** The "## [x.y.z]" section of a Keep-a-Changelog file, without its heading. */
function changelogSection(path) {
  if (!path || !existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

function writeNotes() {
  const { assets } = readAssets();
  const table = [
    "| File | Size | Type |",
    "| --- | --- | --- |",
    ...assets.map((a) => `| \`${a.name}\` | ${formatSize(a.size)} | ${kind(a.name)} |`),
  ].join("\n");
  const sboms = sbomText(assets);
  // --summary wins (e.g. imported historical builds with no changelog entry).
  const changes = args.summary || changelogSection(args.changelog);

  const versioned = [
    `## ${name} v${version}`,
    "",
    changes || "_See the changelog for details._",
    "",
    "### Downloads",
    "",
    table,
    "",
    ...(sboms ? [sboms, ""] : []),
    verifyText(),
    "",
    signingText(assets),
    "",
    `All versions and checksums: ${folderUrl}`,
    "",
  ].join("\n");

  const latest = [
    `Always the newest ${name} release — currently **v${version}**.`,
    "",
    "These links never change; they always serve the newest version:",
    "",
    ...assets.map((a) => `- [\`${a.name}\`](${downloadUrl(latestTag, a.name)})`),
    `- [\`SHA256SUMS.txt\`](${downloadUrl(latestTag, "SHA256SUMS.txt")})`,
    ...(signed ? [`- [\`${BUNDLE}\`](${downloadUrl(latestTag, BUNDLE)}) (Sigstore signature)`] : []),
    "",
    `Release notes for this version: https://github.com/${repo}/releases/tag/${tag}`,
    "",
    `Version history: ${folderUrl}`,
    "",
  ].join("\n");

  writeFileSync(need("out"), versioned);
  writeFileSync(need("latest-out"), latest);
  console.log(`Wrote release notes for ${tag}`);
}

// ---- index -----------------------------------------------------------------------

function compareSemver(a, b) {
  const parse = (v) => v.split("-")[0].split(".").map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  // A release (no suffix) sorts after its pre-releases.
  return (a.includes("-") ? 0 : 1) - (b.includes("-") ? 0 : 1);
}

function appReadme(index) {
  const latest = index.versions[0];
  const lines = [
    `# ${index.name} releases`,
    "",
    `Latest: **v${latest.version}** — ${latest.date}`,
    "",
    "## Download the latest",
    "",
    "These links never change; they always serve the newest version.",
    "",
    "| File | Size | SHA-256 |",
    "| --- | --- | --- |",
    ...latest.assets.map(
      (a) => `| [${a.name}](${downloadUrl(latestTag, a.name)}) | ${formatSize(a.size)} | \`${a.sha256}\` |`,
    ),
    "",
    verifyText(latest.signed === true),
    "",
    "## All versions",
    "",
    "| Version | Date | Downloads |",
    "| --- | --- | --- |",
    ...index.versions.map((v) => {
      const releaseTag = `${index.app}-v${v.version}`;
      // In-app update files stay off this table (they're on the release).
      const links = [
        ...v.assets
          .filter((a) => !isUpdateFile(a.name))
          .map((a) => `[${kind(a.name) || a.name}](${downloadUrl(releaseTag, a.name)})`),
        `[SHA256SUMS](${downloadUrl(releaseTag, "SHA256SUMS.txt")})`,
        ...(v.signed ? [`[signature](${downloadUrl(releaseTag, BUNDLE)})`] : []),
      ].join(" · ");
      return `| [v${v.version}](https://github.com/${repo}/releases/tag/${releaseTag}) | ${v.date} | ${links} |`;
    }),
    "",
    "_Generated by the release workflow — do not edit by hand._",
    "",
  ];
  return lines.join("\n");
}

const APPS_START = "<!-- apps:start -->";
const APPS_END = "<!-- apps:end -->";

/** Rebuild the app list in the root README from every <app>/releases/index.json. */
function rootReadme(repoDir) {
  const rows = [];
  for (const entry of readdirSync(repoDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const indexPath = join(repoDir, entry.name, "releases", "index.json");
    if (!existsSync(indexPath)) continue;
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    const latest = index.versions?.[0];
    if (!latest) continue;
    rows.push(
      `| ${index.name} | v${latest.version} (${latest.date}) | [${entry.name}/releases](${entry.name}/releases) |`,
    );
  }
  rows.sort();
  const block = [
    APPS_START,
    "| Application | Latest | Downloads & history |",
    "| --- | --- | --- |",
    ...rows,
    APPS_END,
  ].join("\n");

  const path = join(repoDir, "README.md");
  const current = existsSync(path)
    ? readFileSync(path, "utf8")
    : `# ${repo.split("/")[1]}\n\nPublic release downloads.\n`;
  const start = current.indexOf(APPS_START);
  const end = current.indexOf(APPS_END);
  const next =
    start >= 0 && end > start
      ? current.slice(0, start) + block + current.slice(end + APPS_END.length)
      : `${current.trimEnd()}\n\n## Applications\n\n${block}\n`;
  writeFileSync(path, next);
}

function writeIndex() {
  const repoDir = need("repo-dir");
  const rollout = optionalInt("rollout", 1, 100);
  const checkAfterHours = optionalInt("check-after-hours", 1, 168);
  const withdraw = (args.withdraw || "")
    .split(",")
    .map((v) => v.trim().replace(/^v/, ""))
    .filter(Boolean);
  for (const v of withdraw) {
    if (!SEMVER.test(v)) fail(`--withdraw takes versions like 1.2.3, got "${v}"`);
    if (v === version) fail(`--withdraw ${v} is the version being published`);
  }
  const { assets } = readAssets();
  const dir = join(repoDir, app, "releases");
  mkdirSync(dir, { recursive: true });

  const indexPath = join(dir, "index.json");
  const index = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, "utf8"))
    : { app, name, versions: [] };
  index.app = app;
  index.name = name;
  const previous = index.versions.find((v) => v.version === version);
  for (const v of withdraw) {
    if (!index.versions.some((e) => e.version === v)) console.log(`v${v} is not in the index (already withdrawn?)`);
  }
  // Re-publishing a version replaces its entry (e.g. a re-run release) but
  // keeps the date it was first published; withdrawn versions drop out.
  index.versions = index.versions.filter((v) => v.version !== version && !withdraw.includes(v.version));
  const entry = { version, date: args.date || previous?.date || new Date().toISOString().slice(0, 10), assets, signed };
  if (rollout !== undefined) entry.rollout = rollout;
  if (checkAfterHours !== undefined) entry.checkAfterHours = checkAfterHours;
  index.versions.push(entry);
  index.versions.sort((a, b) => compareSemver(b.version, a.version));

  // Only the newest version may move the stable <app>-latest links — a
  // hotfix for an older line must not roll everyone back.
  const newest = index.versions[0];
  const isNewest = newest.version === version;
  if (args["require-newest"] === "true" && !isNewest) {
    fail(
      `v${version} would not be the newest version — v${newest.version} is still listed. ` +
        `Withdraw v${newest.version} too (--withdraw), or promote v${newest.version} instead. Nothing was changed.`,
    );
  }

  const manifest = join(assetsDir, "updater.json");
  if (existsSync(manifest)) {
    const offered = JSON.parse(readFileSync(manifest, "utf8")).version;
    if (offered !== version) fail(`updater.json in --assets-dir offers v${offered}, not v${version}`);
  }

  const latest = {
    app,
    name,
    version: newest.version,
    date: newest.date,
    ...(newest.rollout !== undefined ? { rollout: newest.rollout } : {}),
    ...(newest.checkAfterHours !== undefined ? { checkAfterHours: newest.checkAfterHours } : {}),
    releaseUrl: `https://github.com/${repo}/releases/tag/${app}-v${newest.version}`,
    checksumsUrl: downloadUrl(latestTag, "SHA256SUMS.txt"),
    assets: newest.assets.map((a) => ({
      ...a,
      url: downloadUrl(latestTag, a.name),
      versionedUrl: downloadUrl(`${app}-v${newest.version}`, a.name),
    })),
  };

  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
  writeFileSync(join(dir, "README.md"), appReadme(index));
  rootReadme(repoDir);

  // The newest version's in-app update manifest, next to latest.json. A
  // newest version without one removes the file, so a withdrawn build's
  // manifest never outlives a rollback. Older versions leave it alone.
  if (isNewest) {
    const target = join(dir, "updater.json");
    if (existsSync(manifest)) {
      copyFileSync(manifest, target);
    } else if (existsSync(target)) {
      rmSync(target);
      console.log(`Removed ${app}/releases/updater.json (v${version} has no in-app update manifest)`);
    }
  }

  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `is_newest=${isNewest}\n`, { flag: "a" });
  }
  const extras = [
    withdraw.length ? `withdrew v${withdraw.join(", v")}` : "",
    rollout !== undefined ? `rollout ${rollout}%` : "",
    checkAfterHours !== undefined ? `checkAfterHours ${checkAfterHours}` : "",
  ].filter(Boolean);
  console.log(
    `Indexed ${tag} in ${app}/releases (newest: v${newest.version}; ` +
      `${isNewest ? "updates" : "does not update"} ${latestTag})${extras.length ? `; ${extras.join("; ")}` : ""}`,
  );
}

// ---- dispatch -----------------------------------------------------------------------

if (command === "notes") writeNotes();
else if (command === "index") writeIndex();
else fail(`unknown command "${command ?? ""}" (expected "notes" or "index")`);
