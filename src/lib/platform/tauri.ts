import type {
  Platform,
  LoadedFile,
  HelloUnlock,
  CloudBridge,
  CloudAccount,
  DiagnosticsBridge,
  SecureClipboardBridge,
  UpdateBridge,
  UpdateInfo,
  UpdateProgress,
} from "./types";
import type { RemoteBackup } from "../core/authenticator/cloud-sync";

/**
 * Windows Hello bridge. Challenges/signatures cross the IPC boundary as plain
 * byte arrays; no vault key material or password is ever passed to Rust.
 * On non-Windows builds the backend stubs report unavailable/unsupported.
 */
const tauriHello: HelloUnlock = {
  async available(): Promise<boolean> {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      return await invoke<boolean>("hello_available");
    } catch {
      return false;
    }
  },

  async createKey(challenge: Uint8Array): Promise<Uint8Array> {
    const { invoke } = await import("@tauri-apps/api/core");
    const signature = await invoke<number[]>("hello_create_key", {
      challenge: Array.from(challenge),
    });
    return new Uint8Array(signature);
  },

  async sign(challenge: Uint8Array): Promise<Uint8Array> {
    const { invoke } = await import("@tauri-apps/api/core");
    const signature = await invoke<number[]>("hello_sign", {
      challenge: Array.from(challenge),
    });
    return new Uint8Array(signature);
  },

  async deleteKey(): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("hello_delete_key");
  },

  async verifyUser(): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("hello_verify_user");
  },
};

/**
 * Google Drive bridge. Only opaque, already-encrypted backup text and file
 * metadata cross the IPC boundary; OAuth tokens never leave Rust.
 */
const tauriCloud: CloudBridge = {
  async available(): Promise<boolean> {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      return await invoke<boolean>("cloud_available");
    } catch {
      return false;
    }
  },

  async status(): Promise<CloudAccount | null> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<CloudAccount | null>("cloud_status");
  },

  async connect(): Promise<CloudAccount> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<CloudAccount>("cloud_connect");
  },

  async cancelConnect(): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("cloud_cancel_connect");
  },

  async disconnect(): Promise<{ revoked: boolean }> {
    const { invoke } = await import("@tauri-apps/api/core");
    // Rust answers whether Google confirmed revoking the grant (N6).
    const revoked = await invoke<boolean>("cloud_disconnect");
    return { revoked: revoked === true };
  },

  async list(): Promise<RemoteBackup[]> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<RemoteBackup[]>("cloud_list");
  },

  async upload(file): Promise<RemoteBackup> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<RemoteBackup>("cloud_upload", {
      name: file.name,
      content: file.content,
      deviceId: file.deviceId,
      deviceLabel: file.deviceLabel,
      records: file.records,
    });
  },

  async download(id: string): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("cloud_download", { id });
  },

  async remove(id: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("cloud_delete", { id });
  },
};

/**
 * Tauri implementation used by the packaged desktop app.
 *
 * Native open/save dialogs return a path chosen by the user; the actual file
 * read/write is delegated to the minimal Rust commands in `src-tauri`. The
 * Tauri APIs are imported dynamically so this module never fails to load in a
 * plain browser (where the imports would otherwise be unavailable).
 */
const tauriClipboard: SecureClipboardBridge = {
  async copySecret(text: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("clipboard_copy_secret", { text });
  },
  async clearIfUnchanged(text: string): Promise<boolean> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("clipboard_clear_if", { expected: text });
  },
};

const tauriUpdates: UpdateBridge = {
  async check(): Promise<UpdateInfo> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<UpdateInfo>("check_for_update");
  },
  async install(onProgress: (progress: UpdateProgress) => void): Promise<void> {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = onProgress;
    await invoke("install_update", { onProgress: channel });
  },
};

/**
 * Microsoft Store installs are updated by the Store. Rust marks them before
 * this page loads (src-tauri/src/updates.rs → store_marker), and they get no
 * update bridge — so no update prompt, setting or banner.
 */
const storeInstall =
  typeof window !== "undefined" &&
  (window as { __CORETOOLS_STORE__?: unknown }).__CORETOOLS_STORE__ === true;

const tauriDiagnostics: DiagnosticsBridge = {
  async record(source: string, cause: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("diagnostics_record", { source, cause });
  },
  async report(): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("diagnostics_report");
  },
};

export const tauriPlatform: Platform = {
  kind: "tauri",
  hello: tauriHello,
  cloud: tauriCloud,
  clipboard: tauriClipboard,
  updates: storeInstall ? undefined : tauriUpdates,
  storeInstall,
  diagnostics: tauriDiagnostics,

  async openExternal(url: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    // Rust asks before opening an unfamiliar site (S-7); "canceled" if the user says no.
    await invoke("open_external_url", { url });
  },

  async armCamera(armed: boolean): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("qr_camera_armed", { armed });
  },

  // Dialogs are opened in RUST (`pick_open_path` / `pick_save_path`); each
  // path they return is a grant for one read (open) or one write (save) of
  // exactly that string, used up by the read/write command, which also
  // refuses the path if it no longer resolves where it did when picked.
  // The security guarantee stays out of the webview: script injection
  // cannot fabricate, reuse or swap paths.
  async openTextFile(): Promise<LoadedFile | null> {
    const { invoke } = await import("@tauri-apps/api/core");

    const selected = await invoke<string | null>("pick_open_path");
    if (typeof selected !== "string") return null;

    const content = await invoke<string>("read_text_file", { path: selected });
    const name = selected.split(/[\\/]/).pop() ?? selected;
    return { name, content };
  },

  async saveTextFile(suggestedName: string, content: string): Promise<boolean> {
    const { invoke } = await import("@tauri-apps/api/core");

    const path = await invoke<string | null>("pick_save_path", {
      defaultName: suggestedName,
    });
    if (typeof path !== "string") return false;

    await invoke("write_text_file", { path, contents: content });
    return true;
  },

  async saveBinaryFile(suggestedName: string, bytes: Uint8Array): Promise<boolean> {
    const { invoke } = await import("@tauri-apps/api/core");

    const path = await invoke<string | null>("pick_save_path", {
      defaultName: suggestedName,
    });
    if (typeof path !== "string") return false;

    // The bytes travel as the raw IPC body, not a JSON number array (L3);
    // the path rides in a header, base64 so any file name survives.
    const pathBytes = new TextEncoder().encode(path);
    let binary = "";
    for (const byte of pathBytes) binary += String.fromCharCode(byte);
    await invoke("write_binary_file", bytes, { headers: { "x-path": btoa(binary) } });
    return true;
  },
};
