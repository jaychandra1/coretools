/** Clipboard helpers shared by the Credential Manager. */

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

let clearTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Clear the clipboard after `ms` — but ONLY if it still holds `text`, so
 * whatever the user copied since is never destroyed. readText() failing
 * (permission-gated in many engines) means we do nothing.
 */
export function clearClipboardLater(text: string, ms = 30_000): void {
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    navigator.clipboard
      .readText()
      .then((current) => {
        if (current === text) return navigator.clipboard.writeText("");
      })
      .catch(() => {});
  }, ms);
}
