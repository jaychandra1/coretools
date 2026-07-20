import type { Platform } from "./types";
import { browserPlatform } from "./browser";
import { tauriPlatform } from "./tauri";

export type { Platform, LoadedFile } from "./types";

/**
 * Detect whether we are running inside the Tauri webview. Tauri v2 injects
 * `__TAURI_INTERNALS__` on the global object; a plain browser does not have it.
 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let cached: Platform | null = null;

/** Return the appropriate platform implementation for the current host. */
export function getPlatform(): Platform {
  if (!cached) cached = isTauri() ? tauriPlatform : browserPlatform;
  return cached;
}
