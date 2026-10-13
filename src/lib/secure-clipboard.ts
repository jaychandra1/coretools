/**
 * Clipboard helpers shared by the Authenticator and the Credential Manager.
 *
 * Secrets (2FA codes, passwords) go through the desktop app's native copy,
 * which keeps them out of clipboard history and the Windows cloud clipboard
 * (audit F-07). The browser build — and any native failure — falls back to
 * the web clipboard, which can't set those exclusions.
 */

import { getPlatform } from "./platform";

/** Copy non-secret text (usernames, URLs). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API unavailable — fall back to a transient textarea.
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

/** Copy a secret, excluded from clipboard history and sync where the OS allows. */
export async function copySecret(text: string): Promise<void> {
  const native = getPlatform().clipboard;
  if (native) {
    try {
      await native.copySecret(text);
      return;
    } catch (e) {
      void getPlatform().diagnostics?.record("clipboard", typeof e === "string" ? e : "copy failed");
    }
  }
  await copyText(text);
}

let clearTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Clear the clipboard after `ms` — but ONLY if it still holds `text`, so
 * whatever the user copied since is never destroyed. Where the check isn't
 * possible (the web clipboard's readText() is permission-gated in many
 * engines), nothing is cleared.
 */
export function clearSecretLater(text: string, ms = 30_000): void {
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    const native = getPlatform().clipboard;
    if (native) {
      void native.clearIfUnchanged(text).catch(() => {});
      return;
    }
    navigator.clipboard
      .readText()
      .then((current) => {
        if (current === text) return navigator.clipboard.writeText("");
      })
      .catch(() => {});
  }, ms);
}
