/** A text file loaded into memory. */
export interface LoadedFile {
  name: string;
  content: string;
}

/**
 * The only capabilities the UI needs from the host environment. Two concrete
 * implementations exist — one for the packaged Tauri app (native dialogs) and
 * one for a plain browser (used for the dev preview and demos). The UI depends
 * only on this interface, keeping frontend logic decoupled from the platform.
 */
export interface Platform {
  readonly kind: "tauri" | "browser";
  /** Prompt the user to pick a text file and return its contents, or null if cancelled. */
  openTextFile(): Promise<LoadedFile | null>;
  /** Prompt the user for a save location and write `content`. Returns false if cancelled. */
  saveTextFile(suggestedName: string, content: string): Promise<boolean>;
}
