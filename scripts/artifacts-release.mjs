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
 *     README.md                   app list between <!-- apps:start/end -->
 *
 * App-agnostic and dependency-free so other applications can reuse it as is.
 *
 * Usage:
 *   node scripts/artifacts-release.mjs notes --app coretools --name CoreTools \
 *     --version 0.3.0 --artifacts-repo jaychandra1/artifacts \
 *     --assets-dir incoming [--changelog CHANGELOG.md] [--summary "text"] \
 *     --out release-notes.md --latest-out latest-notes.md
 *
 *   node scripts/artifacts-release.mjs index --app coretools --name CoreTools \
 *     --version 0.3.0 --artifacts-repo jaychandra1/artifacts \
 *     --assets-dir incoming --repo-dir artifacts-repo [--date 2026-10-12]
 *
 * `--assets-dir` must contain the installers plus SHA256SUMS.txt
 * ("<sha256>  <file>" per line, as written by sha256sum).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

if (!/^[a-z0-9][a-z0-9-]*$/.test(app)) fail(`--app must be a lowercase slug, got "${app}"`);
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) fail(`--version must be semver, got "${version}"`);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`--artifacts-repo must be owner/name, got "${repo}"`);

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
  const sumsSize = statSync(sumsPath).size;
  return { assets, sumsSize };
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Short platform hint from a file extension (display only). */
function kind(file) {
  if (/\.(exe|msi)$/i.test(file)) return "Windows";
  if (/\.(dmg|pkg)$/i.test(file)) return "macOS";
  if (/\.(AppImage|deb|rpm)$/i.test(file)) return "Linux";
  return "";
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
    "| File | Size | Platform |",
    "| --- | --- | --- |",
    ...assets.map((a) => `| \`${a.name}\` | ${formatSize(a.size)} | ${kind(a.name)} |`),
  ].join("\n");
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
    verifyText(),
    "",
    "Installers are currently unsigned; Windows SmartScreen or macOS Gatekeeper may warn.",
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
      const links = [
        ...v.assets.map((a) => `[${kind(a.name) || a.name}](${downloadUrl(releaseTag, a.name)})`),
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
  const date = args.date || new Date().toISOString().slice(0, 10);
  const { assets } = readAssets();
  const dir = join(repoDir, app, "releases");
  mkdirSync(dir, { recursive: true });

  const indexPath = join(dir, "index.json");
  const index = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, "utf8"))
    : { app, name, versions: [] };
  index.app = app;
  index.name = name;
  // Re-publishing a version replaces its entry (e.g. a re-run release).
  index.versions = index.versions.filter((v) => v.version !== version);
  index.versions.push({ version, date, assets, signed });
  index.versions.sort((a, b) => compareSemver(b.version, a.version));

  const newest = index.versions[0];
  const latest = {
    app,
    name,
    version: newest.version,
    date: newest.date,
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

  // Only the newest version may move the stable <app>-latest links — a
  // hotfix for an older line must not roll everyone back.
  const isNewest = newest.version === version;
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `is_newest=${isNewest}\n`, { flag: "a" });
  }
  console.log(
    `Indexed ${tag} in ${app}/releases (newest: v${newest.version}; ` +
      `${isNewest ? "updates" : "does not update"} ${latestTag})`,
  );
}

// ---- dispatch -----------------------------------------------------------------------

if (command === "notes") writeNotes();
else if (command === "index") writeIndex();
else fail(`unknown command "${command ?? ""}" (expected "notes" or "index")`);
