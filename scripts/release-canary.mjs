/**
 * Release canary (.github/workflows/release-canary.yml): read-only checks
 * that what people download and what installed copies poll is the newest
 * release, whole and consistent. Exit status 1 on any problem, so a
 * scheduled run fails and GitHub emails the maintainer.
 *
 *   GITHUB_TOKEN=… node scripts/release-canary.mjs
 *
 * Checks:
 *   1. <app>/releases/latest.json (what the website and the app read) names
 *      the newest v* tag of SOURCE_REPO. A newer tag gets GRACE_HOURS to be
 *      published (builds + approval); one whose versioned release notes say
 *      "Withdrawn", or listed in IGNORE_VERSIONS, is skipped.
 *   2. Every download in latest.json answers 200, with the listed size, on
 *      both the stable <app>-latest link and the versioned one, and
 *      <app>-latest/SHA256SUMS.txt lists exactly latest.json's SHA-256 sums —
 *      i.e. <app>-latest really holds the newest version's files.
 *   3. In-app updates: when the newest versioned release carries
 *      updater.json, <app>-latest/updater.json (the endpoint installed copies
 *      poll) exists and offers exactly that version, from its versioned
 *      release, with signatures over version-named files. A manifest that
 *      offers another version (e.g. a withdrawn build) is an error. The copy
 *      in the artifacts repo's tree (<app>/releases/updater.json) is checked
 *      the same way when present.
 *   4. The website's / and /app/ answer 200.
 *
 * Environment (defaults in brackets):
 *   GITHUB_TOKEN     reads SOURCE_REPO's tags (private repo) and the
 *                    artifacts repo's release metadata. Required.
 *   SOURCE_REPO      [GITHUB_REPOSITORY]
 *   ARTIFACTS_REPO   [jaychandra1/artifacts]
 *   APP              [coretools]
 *   SITE_URL         [https://coretools-chi.vercel.app]
 *   GRACE_HOURS      [6]
 *   IGNORE_VERSIONS  comma-separated versions not to expect (e.g. a withdrawn
 *                    version whose release was deleted)
 */
import { appendFileSync } from "node:fs";
import { nameCarriesVersion, signedFileName } from "./verify-update-signature.mjs";

const env = process.env;
const TOKEN = env.GITHUB_TOKEN || "";
const SOURCE = env.SOURCE_REPO || env.GITHUB_REPOSITORY || "";
const ARTIFACTS = env.ARTIFACTS_REPO || "jaychandra1/artifacts";
const APP = env.APP || "coretools";
const SITE = (env.SITE_URL || "https://coretools-chi.vercel.app").replace(/\/+$/, "");
const GRACE_HOURS = Number(env.GRACE_HOURS || 6);
const IGNORE = new Set(
  (env.IGNORE_VERSIONS || "")
    .split(",")
    .map((v) => v.trim().replace(/^v/, ""))
    .filter(Boolean),
);
const DOWNLOAD = `https://github.com/${ARTIFACTS}/releases/download`;
const RAW = `https://raw.githubusercontent.com/${ARTIFACTS}/main/${APP}/releases`;

const rows = [];
let failed = false;
function report(level, check, message) {
  rows.push({ level, check, message });
  if (level === "error") failed = true;
  const prefix = env.GITHUB_ACTIONS ? { error: "::error::", warning: "::warning::", ok: "", note: "" }[level] : `${level.toUpperCase()}: `;
  console.log(`${prefix}${check}: ${message}`);
}

// ---- HTTP -----------------------------------------------------------------

async function request(url, options = {}, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000), ...options });
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function api(path) {
  const res = await request(`https://api.github.com/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

/** Status and size of a download, following redirects (HEAD; ranged GET if HEAD is refused). */
async function probe(url) {
  let res = await request(url, { method: "HEAD" });
  if (res.status === 403 || res.status === 405) {
    res = await request(url, { headers: { Range: "bytes=0-0" } });
    await res.body?.cancel();
    const total = /\/(\d+)$/.exec(res.headers.get("content-range") || "")?.[1];
    return { status: res.status === 206 ? 200 : res.status, size: total ? Number(total) : undefined };
  }
  const length = res.headers.get("content-length");
  return { status: res.status, size: length ? Number(length) : undefined };
}

async function getText(url) {
  const res = await request(url, { headers: { "Cache-Control": "no-cache" } });
  return { status: res.status, text: res.ok ? await res.text() : "" };
}

function compareSemver(a, b) {
  const parse = (v) => v.split("-")[0].split(".").map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return (a.includes("-") ? 0 : 1) - (b.includes("-") ? 0 : 1);
}

// ---- checks ---------------------------------------------------------------

async function checkLatestJson() {
  const { status, text } = await getText(`${RAW}/latest.json`);
  if (status !== 200) {
    report("error", "latest.json", `HTTP ${status} for ${RAW}/latest.json`);
    return null;
  }
  try {
    const latest = JSON.parse(text);
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(latest.version || "") || !Array.isArray(latest.assets) || latest.assets.length === 0) {
      throw new Error("missing version or assets");
    }
    report("ok", "latest.json", `v${latest.version} (${latest.date}), ${latest.assets.length} files`);
    return latest;
  } catch (e) {
    report("error", "latest.json", `unreadable: ${e.message}`);
    return null;
  }
}

async function tagDate(ref) {
  if (ref.object.type === "tag") {
    const { json } = await api(`repos/${SOURCE}/git/tags/${ref.object.sha}`);
    return json?.tagger?.date ? new Date(json.tagger.date) : null;
  }
  const { json } = await api(`repos/${SOURCE}/git/commits/${ref.object.sha}`);
  return json?.committer?.date ? new Date(json.committer.date) : null;
}

async function checkNewestTag(latest) {
  if (!SOURCE || !TOKEN) {
    report("error", "newest tag", "GITHUB_TOKEN and SOURCE_REPO (or GITHUB_REPOSITORY) are required to read the v* tags");
    return;
  }
  const { status, json } = await api(`repos/${SOURCE}/git/matching-refs/tags/v`);
  if (status !== 200 || !Array.isArray(json)) {
    report("error", "newest tag", `could not list v* tags of ${SOURCE} (HTTP ${status})`);
    return;
  }
  const tags = json
    .map((ref) => ({ ref, version: /^refs\/tags\/v(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(ref.ref)?.[1] }))
    .filter((t) => t.version)
    .sort((a, b) => compareSemver(b.version, a.version));
  if (tags.length === 0) {
    report("error", "newest tag", `${SOURCE} has no v* tags`);
    return;
  }
  for (const tag of tags) {
    const cmp = compareSemver(tag.version, latest.version);
    if (cmp === 0) {
      report("ok", "newest tag", `v${tag.version} is published`);
      return;
    }
    if (cmp < 0) {
      report("error", "newest tag", `latest.json names v${latest.version}, newer than every v* tag (newest v${tag.version}) — published outside the release workflow?`);
      return;
    }
    if (IGNORE.has(tag.version)) {
      report("note", "newest tag", `v${tag.version} skipped (IGNORE_VERSIONS)`);
      continue;
    }
    const release = await api(`repos/${ARTIFACTS}/releases/tags/${APP}-v${tag.version}`);
    if (release.status === 200 && /withdrawn/i.test((release.json?.body || "").slice(0, 600))) {
      report("note", "newest tag", `v${tag.version} is withdrawn (its release notes say so)`);
      continue;
    }
    const date = await tagDate(tag.ref);
    const hours = date ? (Date.now() - date.getTime()) / 3_600_000 : Infinity;
    if (hours < GRACE_HOURS) {
      report("note", "newest tag", `v${tag.version} was tagged ${hours.toFixed(1)} h ago — release in progress or awaiting approval (grace ${GRACE_HOURS} h); latest.json still says v${latest.version}`);
    } else {
      report(
        "error",
        "newest tag",
        `v${tag.version} was tagged ${Number.isFinite(hours) ? `${hours.toFixed(1)} h` : "a while"} ago, but latest.json still says v${latest.version} — ` +
          "the release failed, is waiting for approval, or wasn't the newest. If it was withdrawn, add a 'Withdrawn' note to its release (or list it in RELEASE_CANARY_IGNORE_VERSIONS).",
      );
    }
    return;
  }
  report("note", "newest tag", `every tag newer than v${latest.version} is withdrawn or ignored`);
}

async function checkDownloads(latest) {
  for (const asset of latest.assets) {
    for (const [label, url] of [["latest", asset.url], ["versioned", asset.versionedUrl]]) {
      if (!url) {
        report("error", asset.name, `no ${label} URL in latest.json`);
        continue;
      }
      const { status, size } = await probe(url);
      if (status !== 200) report("error", asset.name, `${label} link answers HTTP ${status}: ${url}`);
      else if (size !== undefined && asset.size !== undefined && size !== asset.size) {
        report("error", asset.name, `${label} link serves ${size} bytes, latest.json says ${asset.size} — ${label === "latest" ? `${APP}-latest holds a different version's file` : "the versioned file changed"}`);
      }
    }
  }
  const sums = await getText(latest.checksumsUrl);
  if (sums.status !== 200) {
    report("error", "SHA256SUMS.txt", `HTTP ${sums.status}: ${latest.checksumsUrl}`);
  } else {
    const listed = new Map();
    for (const line of sums.text.split(/\r?\n/)) {
      const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
      if (m) listed.set(m[2].trim(), m[1].toLowerCase());
    }
    const mismatched = latest.assets.filter((a) => listed.get(a.name) !== a.sha256).map((a) => a.name);
    if (mismatched.length) {
      report("error", "SHA256SUMS.txt", `${APP}-latest's checksums don't match latest.json (v${latest.version}) for ${mismatched.join(", ")} — ${APP}-latest serves other files`);
    } else {
      report("ok", "downloads", `${latest.assets.length} files on ${APP}-latest and ${APP}-v${latest.version} answer 200 with the listed sizes and checksums`);
    }
  }
  const page = await probe(latest.releaseUrl);
  if (page.status !== 200) report("error", "release page", `HTTP ${page.status}: ${latest.releaseUrl}`);
}

async function checkManifest(label, url, latest, expected) {
  const { status, text } = await getText(url);
  if (status === 404) {
    if (expected) report("error", label, `missing (HTTP 404) although v${latest.version} was signed for in-app updates: ${url}`);
    else report("note", label, `none — v${latest.version} has no in-app update manifest`);
    return;
  }
  if (status !== 200) {
    report("error", label, `HTTP ${status}: ${url}`);
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    report("error", label, "not valid JSON");
    return;
  }
  if (manifest.version !== latest.version) {
    report(
      "error",
      label,
      `offers v${manifest.version}, but latest.json says v${latest.version}` +
        (compareSemver(String(manifest.version), latest.version) > 0 ? " — a withdrawn build is still offered to installed copies; delete it now (docs/runbooks/bad-release.md)" : ""),
    );
    return;
  }
  if (!expected) report("warning", label, `present, but ${APP}-v${latest.version} has no updater.json of its own`);
  const prefix = `${DOWNLOAD}/${APP}-v${latest.version}/`;
  const platforms = Object.entries(manifest.platforms || {});
  if (platforms.length === 0) report("error", label, "lists no platforms");
  for (const [platform, entry] of platforms) {
    if (!entry?.url?.startsWith(prefix)) {
      report("error", label, `${platform} downloads from ${entry?.url}, not from ${APP}-v${latest.version}`);
      continue;
    }
    const name = signedFileName(entry.signature || "");
    if (!nameCarriesVersion(name, latest.version)) {
      report("error", label, `${platform}: the signature names "${name || "?"}", without _${latest.version}_ — installed copies refuse it`);
    }
    const { status: s } = await probe(entry.url);
    if (s !== 200) report("error", label, `${platform} file answers HTTP ${s}: ${entry.url}`);
  }
  if (platforms.length) report("ok", label, `offers v${manifest.version} for ${platforms.map(([p]) => p).join(", ")}`);
}

async function checkUpdater(latest) {
  const release = await api(`repos/${ARTIFACTS}/releases/tags/${APP}-v${latest.version}`);
  if (release.status !== 200) {
    report("error", "versioned release", `${APP}-v${latest.version} not found in ${ARTIFACTS} (HTTP ${release.status})`);
  }
  const expected = (release.json?.assets || []).some((a) => a.name === "updater.json");
  await checkManifest(`${APP}-latest/updater.json`, `${DOWNLOAD}/${APP}-latest/updater.json`, latest, expected);
  const tree = await getText(`${RAW}/updater.json`);
  if (tree.status === 404) {
    report("note", `${APP}/releases/updater.json`, "not in the artifacts repo yet (written by publishes from this pipeline version on)");
  } else {
    await checkManifest(`${APP}/releases/updater.json`, `${RAW}/updater.json`, latest, expected);
  }
}

async function checkSite() {
  for (const path of ["/", "/app/"]) {
    const res = await request(`${SITE}${path}`);
    await res.body?.cancel();
    if (res.status !== 200) report("error", "website", `${SITE}${path} answers HTTP ${res.status}`);
    else report("ok", "website", `${SITE}${path} → 200 (${res.url})`);
  }
}

// ---- run ------------------------------------------------------------------

try {
  const latest = await checkLatestJson();
  if (latest) {
    await checkNewestTag(latest);
    await checkDownloads(latest);
    await checkUpdater(latest);
  }
  await checkSite();
} catch (e) {
  report("error", "canary", `crashed: ${e.stack || e.message}`);
}

if (env.GITHUB_STEP_SUMMARY) {
  const icon = { ok: "✅", note: "ℹ️", warning: "⚠️", error: "❌" };
  appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    [
      `### Release canary — ${failed ? "problems found" : "all good"}`,
      "",
      "| | Check | Result |",
      "| --- | --- | --- |",
      ...rows.map((r) => `| ${icon[r.level]} | ${r.check} | ${r.message.replace(/\|/g, "\\|")} |`),
      "",
    ].join("\n"),
  );
}
process.exit(failed ? 1 : 0);
