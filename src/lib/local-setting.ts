/**
 * Per-device UI choices kept in localStorage: update checks, the All tab,
 * JSON-Studio recovery. Never personal data or anything from the vault.
 *
 * Storage can be unavailable (private windows, blocked site data), so a
 * read falls back to null and a failed write only means the choice isn't
 * remembered across restarts — it still applies now.
 */

export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `null` removes the key. */
export function writeSetting(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not remembered; see above.
  }
}
