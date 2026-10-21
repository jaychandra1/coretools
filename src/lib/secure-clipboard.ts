/**
 * Clipboard helpers shared by the Authenticator and the Credential Manager.
 *
 * Secrets (2FA codes, passwords) go through the desktop app's native copy,
 * which keeps them out of clipboard history and the Windows cloud clipboard
 * (audit F-07). The browser build — and any native failure — falls back to
 * the web clipboard, which can't set those exclusions.
 */

import { getPlatform } from "./platform";
import { noteFailure } from "./diagnostics";

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
      noteFailure("clipboard", typeof e === "string" ? e : "copy failed", e);
    }
  }
  await copyText(text);
}

let clearTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Clear the clipboard after `ms` — but only if it still holds `text`, so
 * whatever the user copied since is kept. Where that can't be checked (the
 * web clipboard's readText() is permission-gated in most browsers), it is
 * cleared anyway: the user asked for copied secrets not to linger, and a
 * secret left on the clipboard is the worse failure (S-12).
 */
export function clearSecretLater(text: string, ms = 30_000): void {
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    const native = getPlatform().clipboard;
    if (native) {
      native.clearIfUnchanged(text).catch((e) => noteFailure("clipboard", "clear failed", e));
      return;
    }
    navigator.clipboard
      .readText()
      .then(
        (current) => (current === text ? navigator.clipboard.writeText("") : undefined),
        () => navigator.clipboard.writeText(""),
      )
      .catch(() => {
        // The page lost focus: browsers only allow clipboard writes from a focused page.
      });
  }, ms);
}
