/**
 * Opt-in update notifications (audit F-02) — desktop only.
 *
 * Off until the user says yes (asked once). When on, the app asks the public
 * release index — through Rust, one fixed URL — when it opens and about once
 * an hour while it stays open (also when its window comes back into view), and a newer release shows as a banner (until
 * "Later" for that version) and a header pill, both linking to the release
 * page. Nothing is downloaded or installed automatically. The preference,
 * the last check time and the newest release seen are kept in localStorage:
 * none of it is personal data.
 */

import { getPlatform } from "./platform";
import { readSetting, writeSetting } from "./local-setting";
import { noteFailure } from "./diagnostics";
import type { UpdateInfo, UpdateProgress } from "./platform/types";

const PREF_KEY = "coretools.updates";
const CHECKED_KEY = "coretools.updates.checkedAt";
/** The newest release seen, so a restart doesn't forget it until the next check. */
const LATEST_KEY = "coretools.updates.latest";
/** The version whose banner was dismissed with "Later". */
const DISMISSED_KEY = "coretools.updates.dismissed";
/** This install's place (0–99) in a staged rollout: random, kept, never sent anywhere. */
const BUCKET_KEY = "coretools.updates.bucket";

/**
 * How old the last successful check may get before the next one. Releases
 * can land minutes apart, and one request an hour for a ~1 KB public file
 * is nothing.
 */
export const CHECK_EVERY_MS = 60 * 60 * 1000;
/** The longest the release index can ask automatic checks to wait (`checkAfterHours`). */
export const MAX_CHECK_AFTER_HOURS = 7 * 24;
/** After a failed check (offline, GitHub down), wait this long to retry. */
export const RETRY_AFTER_MS = 30 * 60 * 1000;
/** How often an open app looks whether a check is due (cheap: no request). */
export const TICK_MS = 5 * 60 * 1000;
/**
 * Each install waits up to this much longer than CHECK_EVERY_MS, at random,
 * so a fleet of copies doesn't poll the release index in lockstep.
 */
export const CHECK_JITTER_MS = 15 * 60 * 1000;

/** Same rules as the Rust side (updates.rs): only links into the public release repo. */
const RELEASE_PREFIX = "https://github.com/jaychandra1/artifacts/releases/";
const DOWNLOAD_PREFIX = "https://github.com/jaychandra1/artifacts/releases/download/";

export type UpdatePref = "on" | "off" | null;

/** -1 / 0 / 1 for dotted numeric versions ("1.10.0" > "1.9.3"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * A link that stays inside the public release repository: https, under
 * `prefix`, and unchanged by URL normalization — so "/../" or "%2e%2e"
 * segments that would resolve elsewhere are refused (S-6).
 */
export function isReleaseLink(url: unknown, prefix: string): url is string {
  if (typeof url !== "string" || !url.startsWith(prefix)) return false;
  try {
    return new URL(url).href === url;
  } catch {
    return false;
  }
}

/** A remembered release, only if it still looks like one the Rust side accepted. */
function restoreLatest(): UpdateInfo | null {
  try {
    const info = JSON.parse(readSetting(LATEST_KEY) ?? "null") as UpdateInfo | null;
    if (info && /^\d+\.\d+\.\d+$/.test(info.version) && isReleaseLink(info.releaseUrl, RELEASE_PREFIX)) {
      return {
        ...info,
        downloadUrl: isReleaseLink(info.downloadUrl, DOWNLOAD_PREFIX) ? info.downloadUrl : null,
        rollout: typeof info.rollout === "number" ? info.rollout : null,
        checkAfterHours: typeof info.checkAfterHours === "number" ? info.checkAfterHours : null,
      };
    }
  } catch {
    // Unreadable: the next check fills it in again.
  }
  return null;
}

/** This install's rollout bucket, 0–99: random, kept, never sent anywhere. */
function rolloutBucket(): number {
  const stored = readSetting(BUCKET_KEY);
  const bucket = Number(stored);
  if (stored !== null && Number.isInteger(bucket) && bucket >= 0 && bucket < 100) return bucket;
  const fresh = Math.floor(Math.random() * 100);
  writeSetting(BUCKET_KEY, String(fresh));
  return fresh;
}

/** A release staged to `rollout` percent includes this install. */
export function inRollout(rollout: number | null, bucket: number): boolean {
  return rollout === null || bucket < rollout;
}

export class UpdateController {
  /** The host can check (desktop build). */
  readonly supported = !!getPlatform().updates;
  pref = $state<UpdatePref>(null);
  /** A release newer than this build, once known. */
  available = $state<UpdateInfo | null>(null);
  /** The version the user said "Later" to. */
  dismissed = $state<string | null>(null);
  checking = $state(false);
  /** Result line of the last manual check. */
  message = $state("");
  lastCheckedAt = $state<number | null>(null);
  /** An in-app update in progress: downloading (percent when known), then installing. */
  installing = $state<{ phase: "downloading" | "installing"; percent: number | null } | null>(null);
  /** Why the last "Update now" didn't finish ("" = it didn't fail). */
  installError = $state("");

  /** Show the banner: a newer release the user hasn't put off. */
  get banner(): UpdateInfo | null {
    return this.available && this.available.version !== this.dismissed ? this.available : null;
  }

  #started = false;
  #lastFailureAt = 0;
  /** This install's share of the jitter, fixed for the session. */
  readonly #jitter = Math.floor(Math.random() * CHECK_JITTER_MS);
  /** The release index's own minimum interval, from the last check. */
  #serverInterval = 0;

  /**
   * Load the preference and what earlier checks found, check now if one is
   * due, and keep checking while the app stays open — a release can land at
   * any hour, and the app can stay open for days.
   */
  start(): void {
    if (this.#started || !this.supported) return;
    this.#started = true;
    const pref = readSetting(PREF_KEY);
    this.pref = pref === "on" || pref === "off" ? pref : null;
    const checked = Number(readSetting(CHECKED_KEY));
    this.lastCheckedAt = Number.isFinite(checked) && checked > 0 ? checked : null;
    this.dismissed = readSetting(DISMISSED_KEY);
    if (this.pref === "on") this.#adopt(restoreLatest());

    this.tick();
    setInterval(() => this.tick(), TICK_MS);
    // A machine waking from sleep or a window brought back may be long overdue.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.tick();
      });
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.tick());
      window.addEventListener("focus", () => this.tick());
    }
  }

  /** Check when one is due: on, and the last success (or failure) is old enough. */
  tick(now = Date.now()): void {
    if (this.pref !== "on" || this.checking) return;
    const interval = Math.max(CHECK_EVERY_MS + this.#jitter, this.#serverInterval);
    if (now - (this.lastCheckedAt ?? 0) < interval) return;
    if (now - this.#lastFailureAt < RETRY_AFTER_MS) return;
    void this.check(false);
  }

  setPref(pref: "on" | "off"): void {
    this.pref = pref;
    writeSetting(PREF_KEY, pref);
    if (pref === "on") void this.check(false);
    else this.#adopt(null);
  }

  /** "Later": hide the banner for this version; a newer one shows it again. */
  dismiss(): void {
    if (!this.available) return;
    this.dismissed = this.available.version;
    writeSetting(DISMISSED_KEY, this.dismissed);
  }

  /** Ask the release index. `manual` reports "up to date" / failures. */
  async check(manual = true): Promise<void> {
    const bridge = getPlatform().updates;
    if (!bridge || this.checking) return;
    this.checking = true;
    if (manual) this.message = "";
    try {
      const latest = await bridge.check();
      this.lastCheckedAt = Date.now();
      writeSetting(CHECKED_KEY, String(this.lastCheckedAt));
      // The release index can only slow checks down, and never past a week.
      this.#serverInterval = Math.min(Math.max(latest.checkAfterHours ?? 0, 0), MAX_CHECK_AFTER_HOURS) * 60 * 60 * 1000;
      // A staged release reaches automatic checks gradually; asking by hand
      // always shows it.
      this.#adopt(manual || inRollout(latest.rollout, rolloutBucket()) ? latest : null);
      if (this.available) this.message = `CoreTools ${latest.version} is available.`;
      else if (manual) this.message = `You're up to date (CoreTools ${__APP_VERSION__}).`;
    } catch (e) {
      this.#lastFailureAt = Date.now();
      noteFailure("updates", typeof e === "string" ? e : "check failed", e);
      if (manual) {
        this.message = "Couldn't reach the release page. Check your connection and try again.";
      }
    } finally {
      this.checking = false;
    }
  }

  /** Show `latest` if it's newer than this build, and remember it for the next start. */
  #adopt(latest: UpdateInfo | null): void {
    const newer = latest && compareVersions(latest.version, __APP_VERSION__) > 0 ? latest : null;
    this.available = newer;
    writeSetting(LATEST_KEY, newer ? JSON.stringify(newer) : null);
  }

  /**
   * "Update now": download this platform's build, verify its signature,
   * install it in place (the vault is kept) and restart — all in the app.
   * Builds without an updater, or releases without a signed update for this
   * platform, fall back to downloading the installer.
   */
  async update(): Promise<void> {
    const bridge = getPlatform().updates;
    if (!bridge || !this.available || this.installing) return;
    this.installError = "";
    this.installing = { phase: "downloading", percent: null };
    try {
      await bridge.install((progress: UpdateProgress) => {
        this.installing =
          progress.phase === "installing"
            ? { phase: "installing", percent: 100 }
            : {
                phase: "downloading",
                percent: progress.total
                  ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
                  : null,
              };
      });
      // Success restarts the app (on Windows the installer closes it first).
    } catch (e) {
      this.installing = null;
      const code = typeof e === "string" ? e : "update_failed";
      if (code === "update_canceled") return; // the user said no in the confirmation
      noteFailure("updates", code, e);
      if (code === "update_unavailable" || code === "update_none") {
        await this.download();
      } else if (code === "update_network") {
        this.installError = "Couldn't download the update. Check your connection and try again.";
      } else {
        this.installError = "The update couldn't be installed. Download the installer instead.";
      }
    }
  }

  /** This platform's installer straight from the release (its page if none is listed). */
  async download(): Promise<void> {
    if (this.available) {
      await getPlatform().openExternal(this.available.downloadUrl ?? this.available.releaseUrl);
    }
  }

  /** The release page: what's new in it. */
  async openRelease(): Promise<void> {
    if (this.available) await getPlatform().openExternal(this.available.releaseUrl);
  }
}

export const updates = new UpdateController();
