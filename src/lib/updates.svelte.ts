/**
 * Opt-in update notifications (audit F-02) — desktop only.
 *
 * Off until the user says yes (asked once). When on, the app asks the public
 * release index — through Rust, one fixed URL — when it opens and every few
 * hours while it stays open, and a newer release shows as a banner (until
 * "Later" for that version) and a header pill, both linking to the release
 * page. Nothing is downloaded or installed automatically. The preference,
 * the last check time and the newest release seen are kept in localStorage:
 * none of it is personal data.
 */

import { getPlatform } from "./platform";
import type { UpdateInfo } from "./platform/types";

const PREF_KEY = "coretools.updates";
const CHECKED_KEY = "coretools.updates.checkedAt";
/** The newest release seen, so a restart doesn't forget it until the next check. */
const LATEST_KEY = "coretools.updates.latest";
/** The version whose banner was dismissed with "Later". */
const DISMISSED_KEY = "coretools.updates.dismissed";

/** How old the last successful check may get before the next one. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** After a failed check (offline, GitHub down), wait this long to retry. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;
/** How often an open app looks whether a check is due (cheap: no request). */
export const TICK_MS = 15 * 60 * 1000;

/** Same rule as the Rust side (updates.rs): only links into the public release repo. */
const RELEASE_PREFIX = "https://github.com/jaychandra1/artifacts/releases/";

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

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode / storage disabled: the preference just isn't remembered.
  }
}

/** A remembered release, only if it still looks like one the Rust side accepted. */
function restoreLatest(): UpdateInfo | null {
  try {
    const info = JSON.parse(read(LATEST_KEY) ?? "null") as UpdateInfo | null;
    if (
      info &&
      /^\d+\.\d+\.\d+$/.test(info.version) &&
      typeof info.releaseUrl === "string" &&
      info.releaseUrl.startsWith(RELEASE_PREFIX)
    ) {
      return info;
    }
  } catch {
    // Unreadable: the next check fills it in again.
  }
  return null;
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

  /** Show the banner: a newer release the user hasn't put off. */
  get banner(): UpdateInfo | null {
    return this.available && this.available.version !== this.dismissed ? this.available : null;
  }

  #started = false;
  #lastFailureAt = 0;

  /**
   * Load the preference and what earlier checks found, check now if one is
   * due, and keep checking while the app stays open — a release can land at
   * any hour, and the app can stay open for days.
   */
  start(): void {
    if (this.#started || !this.supported) return;
    this.#started = true;
    const pref = read(PREF_KEY);
    this.pref = pref === "on" || pref === "off" ? pref : null;
    const checked = Number(read(CHECKED_KEY));
    this.lastCheckedAt = Number.isFinite(checked) && checked > 0 ? checked : null;
    this.dismissed = read(DISMISSED_KEY);
    if (this.pref === "on") this.#adopt(restoreLatest());

    this.tick();
    setInterval(() => this.tick(), TICK_MS);
    // A machine waking from sleep or a window brought back may be long overdue.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.tick();
      });
    }
    if (typeof window !== "undefined") window.addEventListener("online", () => this.tick());
  }

  /** Check when one is due: on, and the last success (or failure) is old enough. */
  tick(now = Date.now()): void {
    if (this.pref !== "on" || this.checking) return;
    if (now - (this.lastCheckedAt ?? 0) < CHECK_EVERY_MS) return;
    if (now - this.#lastFailureAt < RETRY_AFTER_MS) return;
    void this.check(false);
  }

  setPref(pref: "on" | "off"): void {
    this.pref = pref;
    write(PREF_KEY, pref);
    if (pref === "on") void this.check(false);
    else this.#adopt(null);
  }

  /** "Later": hide the banner for this version; a newer one shows it again. */
  dismiss(): void {
    if (!this.available) return;
    this.dismissed = this.available.version;
    write(DISMISSED_KEY, this.dismissed);
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
      write(CHECKED_KEY, String(this.lastCheckedAt));
      this.#adopt(latest);
      if (this.available) this.message = `CoreTools ${latest.version} is available.`;
      else if (manual) this.message = `You're up to date (CoreTools ${__APP_VERSION__}).`;
    } catch (e) {
      this.#lastFailureAt = Date.now();
      void getPlatform().diagnostics?.record("updates", typeof e === "string" ? e : "check failed");
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
    write(LATEST_KEY, newer ? JSON.stringify(newer) : null);
  }

  async openRelease(): Promise<void> {
    if (this.available) await getPlatform().openExternal(this.available.releaseUrl);
  }
}

export const updates = new UpdateController();
