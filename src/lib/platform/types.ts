import type { RemoteBackup } from "../core/authenticator/cloud-sync";

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
  /**
   * Make Windows verify the user (biometric/PIN) without touching the unlock
   * key — used as the device-authentication gate before a cloud restore.
   * Rejects (e.g. "hello_canceled") unless verification succeeds.
   */
  verifyUser(): Promise<void>;
}

/** The connected Google account as reported by the native backend. */
export interface CloudAccount {
  email: string;
  /** This computer's name, used to label the backups it uploads. */
  deviceName: string;
}

/**
 * Google Drive transport for the Authenticator cloud backup.
 *
 * The native backend owns the whole OAuth flow (system browser + loopback
 * redirect + PKCE), keeps the refresh token in the OS keychain and performs
 * every HTTP request itself — the webview never holds a Google token and
 * cannot reach the network. It also can't redirect uploads: the backend only
 * ever writes to the connected account's private app-data folder. Content
 * crossing this boundary is the already-encrypted backup envelope.
 *
 * Methods reject with stable string tokens ("cloud_network",
 * "cloud_auth_revoked", "oauth_canceled", …) — see describeCloudError().
 */
export interface CloudBridge {
  /** Whether this build has a Google OAuth client configured. */
  available(): Promise<boolean>;
  /** The connected account, or null. Never touches the network. */
  status(): Promise<CloudAccount | null>;
  /** Run Google sign-in in the system browser and store the credential. */
  connect(): Promise<CloudAccount>;
  /** Abort a connect() that is waiting for the browser. */
  cancelConnect(): Promise<void>;
  /** Forget the credential locally and revoke it at Google (best effort). */
  disconnect(): Promise<void>;
  list(): Promise<RemoteBackup[]>;
  upload(file: {
    name: string;
    content: string;
    deviceId: string;
    deviceLabel: string;
  }): Promise<RemoteBackup>;
  download(id: string): Promise<string>;
  remove(id: string): Promise<void>;
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
  /**
   * Open an http(s) URL in the user's browser (Credential Manager "Open
   * link"). Anything else is refused — by the frontend and again by Rust.
   */
  openExternal(url: string): Promise<void>;
  /** OS biometric unlock. Absent where the host has no such facility (browser). */
  readonly hello?: HelloUnlock;
  /** Authenticator cloud backup transport. Desktop only. */
  readonly cloud?: CloudBridge;
  /** Clipboard writes kept out of history and cloud sync (F-07). Desktop only. */
  readonly clipboard?: SecureClipboardBridge;
  /** Opt-in check for a newer release (F-02). Desktop only. */
  readonly updates?: UpdateBridge;
  /** Local diagnostics log (F-16). Desktop only. */
  readonly diagnostics?: DiagnosticsBridge;
}

/**
 * Copying secrets (passwords, 2FA codes) so they don't land in clipboard
 * history or the Windows cloud clipboard. The text is never stored natively.
 */
export interface SecureClipboardBridge {
  copySecret(text: string): Promise<void>;
  /** Clear only if the clipboard still holds `text`; true when it cleared. */
  clearIfUnchanged(text: string): Promise<boolean>;
}

/** The newest release announced by the public index. */
export interface UpdateInfo {
  version: string;
  /** YYYY-MM-DD, or "". */
  date: string;
  /** Always a page in the public release repository. */
  releaseUrl: string;
  notice: string | null;
  security: boolean;
}

export interface UpdateBridge {
  /** Rejects with "update_network" / "update_invalid". */
  check(): Promise<UpdateInfo>;
}

export interface DiagnosticsBridge {
  /** Record a failure's cause (an error token — never content or secrets). */
  record(source: string, cause: string): Promise<void>;
  /** The newest log lines, for "Copy diagnostics". */
  report(): Promise<string>;
}
