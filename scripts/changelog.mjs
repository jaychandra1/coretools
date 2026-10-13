/**
 * CHANGELOG.md release-notes gate and release cut (audit F-26).
 *
 * v1.1.0 shipped with empty release notes because its section was still
 * "## [Unreleased]" when it was tagged. This script makes that impossible:
 *
 *   node scripts/changelog.mjs check <version>
 *       Exit 1 unless CHANGELOG.md has a "## [<version>]" section with real
 *       content (release.yml and CI's tag-release job run this).
 *
 *   node scripts/changelog.mjs release <version> [<YYYY-MM-DD>]
 *       Rename "## [Unreleased]" to "## [<version>] — <date>" (default: today,
 *       UTC) and open a fresh, empty "## [Unreleased]" above it. Refuses when
 *       there is nothing to release. If the notes were already moved by hand
 *       (empty Unreleased + a filled "## [<version>]"), only the date is set.
 *       (The Prepare release workflow runs this.)
 *
 *   node scripts/changelog.mjs notes <version>
 *       Print the section body (used for the release pull request).
 *
 *   --file <path>   another changelog instead of the repo's CHANGELOG.md
 *
 * A section runs from its "## [" heading to the next "## [" heading — the
 * same bounds scripts/artifacts-release.mjs uses for the published notes.
 * Headings, blank lines and HTML comments alone don't count as content.
 * Keeps the file's line endings. Zero dependencies.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `changelog: ${message}`);
  process.exit(1);
}

const positional = [];
let file = join(root, "CHANGELOG.md");
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--file") file = argv[++i];
  else positional.push(argv[i]);
}
const [command, version, dateArg] = positional;

if (!["check", "release", "notes"].includes(command)) {
  fail('usage: changelog.mjs <check|release|notes> <version> [<YYYY-MM-DD>] [--file CHANGELOG.md]');
}
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  fail(`<version> must be semver without a leading v, got "${version ?? ""}"`);
}

const text = readFileSync(file, "utf8");
const eol = text.includes("\r\n") ? "\r\n" : "\n";
const lines = text.split(/\r?\n/);

/** { start, end, body } of the first section whose heading matches, or null. */
function section(isHeading) {
  const start = lines.findIndex(isHeading);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
  if (end < 0) end = lines.length;
  return { start, end, body: lines.slice(start + 1, end) };
}

/** True when the body has something besides blank lines, headings and comments. */
function hasContent(body) {
  return body
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .some((l) => l.trim() !== "" && !/^#{1,6}(\s|$)/.test(l.trim()));
}

const isVersionHeading = (l) => l.startsWith(`## [${version}]`);
const isUnreleasedHeading = (l) => /^## \[unreleased\]/i.test(l);

if (command === "check") {
  const s = section(isVersionHeading);
  if (!s) {
    fail(
      `CHANGELOG.md has no "## [${version}]" section — move the notes from "## [Unreleased]" ` +
        `under "## [${version}] — <date>" (Actions → Prepare release does this).`,
    );
  }
  if (!hasContent(s.body)) {
    fail(`The "## [${version}]" section of CHANGELOG.md is empty — write the release notes first.`);
  }
  console.log(`CHANGELOG.md: "## [${version}]" has release notes ✓`);
} else if (command === "notes") {
  const s = section(isVersionHeading);
  if (!s) fail(`CHANGELOG.md has no "## [${version}]" section.`);
  console.log(s.body.join("\n").trim());
} else {
  const date = dateArg ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`<date> must be YYYY-MM-DD, got "${date}"`);
  const heading = `## [${version}] — ${date}`;
  const unreleased = section(isUnreleasedHeading);
  const existing = section(isVersionHeading);
  const pending = unreleased !== null && hasContent(unreleased.body);

  if (existing) {
    if (pending) {
      fail(
        `Both "## [Unreleased]" and "## [${version}]" have notes in CHANGELOG.md — ` +
          "merge them into one section by hand first.",
      );
    }
    if (!hasContent(existing.body)) {
      fail(`"## [${version}]" in CHANGELOG.md is empty and "## [Unreleased]" has nothing to release.`);
    }
    // Notes were already moved by hand: just date them for today's release.
    lines[existing.start] = heading;
    if (!unreleased) lines.splice(existing.start, 0, "## [Unreleased]", "");
    console.log(`CHANGELOG.md: "## [${version}]" already had its notes; dated it ${date}.`);
  } else {
    if (!unreleased) fail('CHANGELOG.md has no "## [Unreleased]" section to release.');
    if (!pending) {
      fail(
        `"## [Unreleased]" in CHANGELOG.md is empty — there is nothing to release. ` +
          `Add the notes for ${version} there first.`,
      );
    }
    lines.splice(unreleased.start, 1, "## [Unreleased]", "", heading);
    console.log(`CHANGELOG.md: "## [Unreleased]" → "${heading}", fresh "## [Unreleased]" above it.`);
  }
  writeFileSync(file, lines.join(eol));
}
