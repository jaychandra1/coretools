/** A text file loaded into memory. */
export interface LoadedFile {
  name: string;
  content: string;
}

/**
 * OS-biometric unlock support (Windows Hello) for the Authenticator vault.
 *
 * Each signing call is gated by the OS biometric/PIN prompt over a
 * Hello-protected (TPM-backed where available) key pair. The signature over a
 * fixed challenge is deterministic, so the frontend can derive a stable
 * wrapping key from it. The platform layer never sees vault secrets.
 */
export interface HelloUnlock {
  /** Whether Windows Hello is set up on this device. */
  available(): Promise<boolean>;
  /** Create/replace the app's Hello key and sign `challenge` (enable-time). */
  createKey(challenge: Uint8Array): Promise<Uint8Array>;
  /** Sign `challenge` with the existing Hello key (unlock-time). */
  sign(challenge: Uint8Array): Promise<Uint8Array>;
  /** Remove the app's Hello key. Idempotent. */
  deleteKey(): Promise<void>;
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
  /** Same as saveTextFile, for binary payloads (e.g. .xlsx exports). */
  saveBinaryFile(suggestedName: string, bytes: Uint8Array): Promise<boolean>;
  /** OS biometric unlock. Absent where the host has no such facility (browser). */
  readonly hello?: HelloUnlock;
}
