/**
 * Opt-in update notifications (audit F-02) — desktop only.
 *
 * Off until the user says yes (asked once). When on, the app asks the public
 * release index at most once a day — through Rust, one fixed URL — and shows
 * "Update available" with a link to the release page. Nothing is downloaded
 * or installed automatically. The preference and the last check time are
 * kept in localStorage: they are not personal data.
 */

import { getPlatform } from "./platform";
import type { UpdateInfo } from "./platform/types";

const PREF_KEY = "coretools.updates";
const CHECKED_KEY = "coretools.updates.checkedAt";
const DAY_MS = 24 * 60 * 60 * 1000;

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

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / storage disabled: the preference just isn't remembered.
  }
}

export class UpdateController {
  /** The host can check (desktop build). */
  readonly supported = !!getPlatform().updates;
  pref = $state<UpdatePref>(null);
  /** A release newer than this build, once known. */
  available = $state<UpdateInfo | null>(null);
  checking = $state(false);
  /** Result line of the last manual check. */
  message = $state("");
  lastCheckedAt = $state<number | null>(null);

  #started = false;

  /** Load the preference and run the daily check when it's on. */
  start(): void {
    if (this.#started || !this.supported) return;
    this.#started = true;
    const pref = read(PREF_KEY);
    this.pref = pref === "on" || pref === "off" ? pref : null;
    const checked = Number(read(CHECKED_KEY));
    this.lastCheckedAt = Number.isFinite(checked) && checked > 0 ? checked : null;
    if (this.pref === "on" && Date.now() - (this.lastCheckedAt ?? 0) > DAY_MS) {
      void this.check(false);
    }
  }

  setPref(pref: "on" | "off"): void {
    this.pref = pref;
    write(PREF_KEY, pref);
    if (pref === "on") void this.check(false);
    else this.available = null;
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
      if (compareVersions(latest.version, __APP_VERSION__) > 0) {
        this.available = latest;
        this.message = `CoreTools ${latest.version} is available.`;
      } else {
        this.available = null;
        if (manual) this.message = `You're up to date (CoreTools ${__APP_VERSION__}).`;
      }
    } catch (e) {
      void getPlatform().diagnostics?.record("updates", typeof e === "string" ? e : "check failed");
      if (manual) {
        this.message = "Couldn't reach the release page. Check your connection and try again.";
      }
    } finally {
      this.checking = false;
    }
  }

  async openRelease(): Promise<void> {
    if (this.available) await getPlatform().openExternal(this.available.releaseUrl);
  }
}

export const updates = new UpdateController();
