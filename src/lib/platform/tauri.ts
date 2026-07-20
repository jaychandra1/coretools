import type { Platform, LoadedFile } from "./types";

/**
 * Tauri implementation used by the packaged desktop app.
 *
 * Native open/save dialogs return a path chosen by the user; the actual file
 * read/write is delegated to the minimal Rust commands in `src-tauri`. The
 * Tauri APIs are imported dynamically so this module never fails to load in a
 * plain browser (where the imports would otherwise be unavailable).
 */
export const tauriPlatform: Platform = {
  kind: "tauri",

  async openTextFile(): Promise<LoadedFile | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");

    const selected = await open({ multiple: false, directory: false });
    if (typeof selected !== "string") return null;

    const content = await invoke<string>("read_text_file", { path: selected });
    const name = selected.split(/[\\/]/).pop() ?? selected;
    return { name, content };
  },

  async saveTextFile(suggestedName: string, content: string): Promise<boolean> {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");

    const path = await save({ defaultPath: suggestedName });
    if (typeof path !== "string") return false;

    await invoke("write_text_file", { path, contents: content });
    return true;
  },
};
