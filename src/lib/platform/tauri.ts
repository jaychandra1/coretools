import type {
  Platform,
  LoadedFile,
  HelloUnlock,
  CloudBridge,
  CloudAccount,
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

  async disconnect(): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("cloud_disconnect");
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
export const tauriPlatform: Platform = {
  kind: "tauri",
  hello: tauriHello,
  cloud: tauriCloud,

  // Dialogs are opened in RUST (`pick_open_path` / `pick_save_path`), which
  // canonicalizes and remembers the chosen path; the read/write commands only
  // accept a remembered path, once. This keeps the security guarantee out of
  // the webview: script injection cannot fabricate paths.
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

    // Tauri v2 serializes Vec<u8> command args efficiently from number[].
    await invoke("write_binary_file", { path, contents: Array.from(bytes) });
    return true;
  },
};
