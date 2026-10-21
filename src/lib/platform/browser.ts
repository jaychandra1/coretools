import type { Platform, LoadedFile } from "./types";

/**
 * Browser implementation used by the Vite dev preview and any non-Tauri host.
 *
 * Loading uses a transient <input type="file"> and reads the file with the
 * in-memory File API — nothing is persisted. Saving triggers a standard blob
 * download, which is the browser's own explicit "save" gesture.
 */
/** The same limit as the desktop app's read_text_file (L7). */
const MAX_READ_BYTES = 50 * 1024 * 1024;

export const browserPlatform: Platform = {
  kind: "browser",

  async openExternal(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) links can be opened");
    // noopener + noreferrer: the opened site gets no handle back to this page.
    window.open(url, "_blank", "noopener,noreferrer");
  },

  openTextFile(): Promise<LoadedFile | null> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.style.display = "none";

      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return resolve(null);
        if (file.size > MAX_READ_BYTES) {
          return reject(new Error("That file is too large to open here (over 50 MB)."));
        }
        try {
          const content = await file.text();
          resolve({ name: file.name, content });
        } catch {
          resolve(null);
        }
      });

      // If the dialog is cancelled the change event never fires; that simply
      // leaves the promise pending, which is harmless for this UI.
      document.body.appendChild(input);
      input.click();
    });
  },

  async saveTextFile(suggestedName: string, content: string): Promise<boolean> {
    return downloadBlob(
      suggestedName,
      new Blob([content], { type: "text/plain;charset=utf-8" }),
    );
  },

  async saveBinaryFile(suggestedName: string, bytes: Uint8Array): Promise<boolean> {
    return downloadBlob(
      suggestedName,
      new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
    );
  },
};

function downloadBlob(suggestedName: string, blob: Blob): boolean {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = suggestedName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}
