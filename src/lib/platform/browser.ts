import type { Platform, LoadedFile } from "./types";
import { mockCloud } from "./mock-cloud"; // TEMP-VERIFY

/**
 * Browser implementation used by the Vite dev preview and any non-Tauri host.
 *
 * Loading uses a transient <input type="file"> and reads the file with the
 * in-memory File API — nothing is persisted. Saving triggers a standard blob
 * download, which is the browser's own explicit "save" gesture.
 */
export const browserPlatform: Platform = {
  kind: "browser",
  cloud: mockCloud, // TEMP-VERIFY

  openTextFile(): Promise<LoadedFile | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.style.display = "none";

      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return resolve(null);
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
