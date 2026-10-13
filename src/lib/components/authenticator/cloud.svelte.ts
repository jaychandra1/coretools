/**
 * Cloud backup controller (Svelte 5 runes): connection state, automatic
 * backups, multi-device conflicts, retries and the restore flow.
 *
 * Division of labour:
 *  - the native backend (CloudBridge) does OAuth and HTTP and holds the
 *    Google credential — this file never sees a token;
 *  - the AuthStore seals/opens backups with the in-memory vault key;
 *  - the policy (conflict detection, retention, back-off, error mapping)
 *    is in core/authenticator/cloud-sync.ts, where it is unit-tested.
 *
 * Automatic backup: every persisted change marks the vault dirty and
 * schedules a debounced backup. Changes only happen while unlocked, so the
 * vault key is available; if the vault locks before the timer fires, the
 * backup simply runs on the next unlock. Failures that may heal on their own
 * (offline, Google 5xx) retry with back-off and whenever the OS reports the
 * network is back.
 */

import { authStore, type AuthEvent, type RestoreResult } from "./store.svelte";
import { credentialStore } from "../credentials/credentials.svelte";
import { getPlatform } from "../../platform";
import {
  loadCloudConfig,
  saveCloudConfig,
  type CloudConfig,
} from "../../core/authenticator/db";
import {
  describeCloudError,
  detectConflict,
  performBackup,
  retryDelayMs,
  sortNewestFirst,
  type RemoteBackup,
} from "../../core/authenticator/cloud-sync";
import {
  CloudBackupError,
  deriveBackupKey,
  openCloudBackup,
  parseCloudBackup,
  type CloudBackupFile,
  type CloudBackupPayload,
} from "../../core/authenticator/cloud-backup";

/** Quiet period after the last change before an automatic backup runs. */
const DEBOUNCE_MS = 4000;

export type CloudActivity =
  | "connecting"
  | "backing-up"
  | "listing"
  | "downloading"
  | "restoring"
  | "deleting"
  | "disconnecting";

export interface CloudNotice {
  kind: "success" | "warning" | "error";
  text: string;
}

export type CloudStatus =
  | "unavailable"
  | "disconnected"
  | "reconnect"
  | "needs-password"
  | "conflict"
  | "working"
  | "retrying"
  | "error"
  | "pending"
  | "up-to-date";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function fallbackDeviceLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Mac/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux PC";
  return "Desktop";
}

export class CloudBackupController {
  ready = $state(false);
  /** This build has a Google OAuth client configured. */
  configured = $state(false);
  /** Connected Google account email, or null. */
  account = $state<string | null>(null);
  deviceName = $state("");
  config = $state<CloudConfig | null>(null);
  activity = $state<CloudActivity | null>(null);
  notice = $state<CloudNotice | null>(null);
  /** A newer backup from another device that uploading would bury. */
  conflict = $state<RemoteBackup | null>(null);
  /** Google access is gone (revoked, expired, keychain cleared). */
  needsReconnect = $state(false);
  /** Message of the last failed automatic backup, cleared on success. */
  lastError = $state<string | null>(null);
  /** When the next automatic retry fires (ms), or null. */
  retryAt = $state<number | null>(null);
  /** Backup versions in Drive, newest first; null until first known. */
  versions = $state<RemoteBackup[] | null>(null);

  #bridge = getPlatform().cloud ?? null;
  #initPromise: Promise<void> | null = null;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #running: Promise<void> | null = null;
  /** Bumped on every vault change; tells whether a change raced a backup. */
  #changeSeq = 0;
  #suppressChanges = false;

  /** The host has a cloud transport at all (desktop build). */
  get supported(): boolean {
    return this.#bridge !== null;
  }

  get available(): boolean {
    return this.supported && this.configured;
  }

  get connected(): boolean {
    return this.account !== null;
  }

  get status(): CloudStatus {
    if (!this.available) return "unavailable";
    if (!this.account) return this.needsReconnect ? "reconnect" : "disconnected";
    if (this.needsReconnect) return "reconnect";
    if (!authStore.encrypted) return "needs-password";
    if (this.conflict) return "conflict";
    if (this.activity) return "working";
    if (this.retryAt) return "retrying";
    if (this.lastError) return "error";
    if (this.config?.dirty) return "pending";
    return "up-to-date";
  }

  get deviceLabel(): string {
    return (this.deviceName || fallbackDeviceLabel()).slice(0, 60);
  }

  init(): Promise<void> {
    this.#initPromise ??= this.#init();
    return this.#initPromise;
  }

  async #init(): Promise<void> {
    await authStore.init();
    const config = await loadCloudConfig();
    this.config = config;

    const bridge = this.#bridge;
    if (bridge) {
      this.configured = await bridge.available();
      if (this.configured) {
        try {
          const account = await bridge.status();
          this.account = account?.email ?? null;
          this.deviceName = account?.deviceName ?? "";
        } catch {
          this.account = null;
        }
        // We were connected, but the OS keychain no longer has the
        // credential (profile reset, manual removal): say so rather than
        // silently stop backing up.
        if (!this.account && config.email) this.needsReconnect = true;
      }
    }
    await this.#persist(); // stores a freshly generated device id

    authStore.subscribe((event) => this.#onAuthEvent(event));
    window.addEventListener("online", () => {
      if (this.retryAt) this.#kick();
    });
    this.ready = true;

    if (this.connected && config.dirty && config.autoBackup) this.#schedule(1000);
  }

  async #persist(): Promise<void> {
    if (this.config) await saveCloudConfig($state.snapshot(this.config));
  }

  async #update(patch: Partial<CloudConfig>): Promise<void> {
    if (!this.config) return;
    this.config = { ...this.config, ...patch };
    await this.#persist();
  }

  #onAuthEvent(event: AuthEvent): void {
    if (event === "wipe") {
      void this.#forgetAfterWipe();
      return;
    }
    if (this.#suppressChanges || !this.connected || !this.config) return;

    if (event === "change" || event === "password") {
      // A password now exists: drop the "set a password first" warning.
      if (event === "password" && authStore.encrypted && this.notice?.kind === "warning") {
        this.notice = null;
      }
      this.#changeSeq++;
      if (!this.config.dirty) void this.#update({ dirty: true });
      if (event === "password" && !authStore.encrypted) {
        this.notice = {
          kind: "warning",
          text: "Cloud backups are paused until you set an encryption password — it is what encrypts them.",
        };
        return;
      }
      if (this.config.autoBackup) this.#schedule(DEBOUNCE_MS);
    } else if (event === "unlock") {
      if (this.config.dirty && this.config.autoBackup) this.#schedule(1000);
    }
  }

  #schedule(delay: number): void {
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => void this.backupNow({ auto: true }), delay);
  }

  #kick(): void {
    clearTimeout(this.#retryTimer);
    this.retryAt = null;
    void this.backupNow({ auto: true });
  }

  #clearRetry(): void {
    clearTimeout(this.#retryTimer);
    this.retryAt = null;
    this.#attempt = 0;
  }

  /**
   * Back up now. Concurrent calls queue behind the running one. `force`
   * uploads even over another device's newer version (the user chose to
   * keep this device's data); that version stays available for rollback.
   */
  async backupNow(opts: { auto?: boolean; force?: boolean } = {}): Promise<void> {
    clearTimeout(this.#debounce);
    while (this.#running) await this.#running;
    if (opts.auto && !this.config?.dirty) return;
    this.#running = this.#backup(opts).finally(() => (this.#running = null));
    await this.#running;
  }

  async #backup({ auto = false, force = false }): Promise<void> {
    const bridge = this.#bridge;
    const config = this.config;
    if (!bridge || !config || !this.account || this.needsReconnect) return;
    if (!authStore.encrypted) {
      this.notice = {
        kind: "warning",
        text: "Set an encryption password to back up — it encrypts your backups end-to-end and you'll need it to restore.",
      };
      return;
    }
    if (authStore.locked) return; // stays dirty; the unlock event resumes
    if (auto && this.conflict) return; // waiting for the user's decision

    const seq = this.#changeSeq;
    this.activity = "backing-up";
    try {
      const outcome = await performBackup({
        transport: bridge,
        seal: () =>
          authStore.sealCloudBackup({ id: config.deviceId, label: this.deviceLabel }),
        deviceId: config.deviceId,
        deviceLabel: this.deviceLabel,
        lastSyncedRemoteId: config.lastSyncedRemoteId,
        force,
      });

      if (outcome.kind === "conflict") {
        this.conflict = outcome.remote;
        if (!auto) {
          this.notice = {
            kind: "warning",
            text: `${outcome.remote.deviceLabel || "Another device"} made a newer backup. Merge it first, or choose to keep this device's data.`,
          };
        }
        return;
      }

      this.conflict = null;
      this.lastError = null;
      this.versions = outcome.versions;
      this.#clearRetry();
      await this.#update({
        lastBackupAt: Date.now(),
        lastBackupId: outcome.file.id,
        lastSyncedRemoteId: outcome.file.id,
        dirty: this.#changeSeq !== seq,
      });
      if (!auto) {
        this.notice = {
          kind: "success",
          text: `Backed up ${plural(authStore.entries.length, "account")} to Google Drive.`,
        };
      }
      if (this.config?.dirty && this.config.autoBackup) this.#schedule(DEBOUNCE_MS);
    } catch (e) {
      const info = describeCloudError(e);
      if (info.kind === "auth") this.needsReconnect = true;
      this.lastError = info.message || "Backup failed.";
      if (info.retryable) {
        const delay = retryDelayMs(this.#attempt++);
        this.retryAt = Date.now() + delay;
        clearTimeout(this.#retryTimer);
        this.#retryTimer = setTimeout(() => this.#kick(), delay);
      }
      if (!auto || !info.retryable) {
        this.notice = {
          kind: info.retryable ? "warning" : "error",
          text: this.lastError,
        };
      }
    } finally {
      this.activity = null;
    }
  }

  /** Sign in with Google (system browser). Returns false if canceled. */
  async signIn(): Promise<boolean> {
    const bridge = this.#bridge;
    if (!bridge || !this.config) return false;
    this.activity = "connecting";
    this.notice = null;
    try {
      const account = await bridge.connect();
      const switched = !!this.config.email && this.config.email !== account.email;
      this.account = account.email;
      this.deviceName = account.deviceName;
      this.needsReconnect = false;
      this.lastError = null;
      // A different Google account holds a different backup history.
      await this.#update(
        switched
          ? { email: account.email, lastSyncedRemoteId: null, lastBackupId: null, lastBackupAt: null }
          : { email: account.email },
      );
      return true;
    } catch (e) {
      const info = describeCloudError(e);
      if (info.message) this.notice = { kind: "error", text: info.message };
      return false;
    } finally {
      this.activity = null;
    }
  }

  async cancelSignIn(): Promise<void> {
    await this.#bridge?.cancelConnect().catch(() => {});
  }

  /**
   * Connect (or reconnect) the Google account, then either make the first
   * backup or — when the account already holds another device's backups —
   * stop and let the user restore/merge before anything is overwritten.
   */
  async connect(): Promise<void> {
    if (!authStore.encrypted) {
      this.notice = {
        kind: "warning",
        text: "Set an encryption password first — it encrypts your backups end-to-end.",
      };
      return;
    }
    if (!(await this.signIn())) return;
    const bridge = this.#bridge;
    const config = this.config;
    if (!bridge || !config) return;

    this.activity = "listing";
    let remote: RemoteBackup[];
    try {
      remote = sortNewestFirst(await bridge.list());
    } catch (e) {
      this.notice = { kind: "error", text: describeCloudError(e).message };
      return;
    } finally {
      this.activity = null;
    }

    const conflict = detectConflict(remote, config.lastSyncedRemoteId, config.deviceId);
    if (conflict) {
      this.conflict = conflict;
      this.notice = {
        kind: "warning",
        text: `Connected as ${this.account}. This account already has a backup from ${conflict.deviceLabel || "another device"} — restore or merge it, or keep this device's data.`,
      };
      return;
    }
    await this.#update({ dirty: true });
    await this.backupNow();
    if (this.notice?.kind === "success") {
      this.notice = {
        kind: "success",
        text: `Connected as ${this.account}. ${this.notice.text}`,
      };
    }
  }

  /** Resolve a conflict by uploading this device's data as the newest version. */
  async keepThisDevice(): Promise<void> {
    await this.#update({ dirty: true });
    await this.backupNow({ force: true });
  }

  async setAutoBackup(on: boolean): Promise<void> {
    await this.#update({ autoBackup: on });
    if (on && this.config?.dirty) this.#schedule(1000);
  }

  /** Forget the credential (revoking it at Google). Backups stay in Drive. */
  async disconnect(): Promise<void> {
    const bridge = this.#bridge;
    if (!bridge) return;
    this.activity = "disconnecting";
    try {
      await bridge.disconnect();
    } catch (e) {
      this.notice = { kind: "error", text: describeCloudError(e).message };
      return;
    } finally {
      this.activity = null;
    }
    this.#resetConnection();
    await this.#update({
      email: null,
      dirty: false,
      lastBackupAt: null,
      lastBackupId: null,
      lastSyncedRemoteId: null,
    });
    this.notice = {
      kind: "success",
      text: "Google account disconnected. Existing backups stay in your Google Drive until you delete them.",
    };
  }

  #resetConnection(): void {
    clearTimeout(this.#debounce);
    this.#clearRetry();
    this.versions = null;
    this.account = null;
    this.conflict = null;
    this.needsReconnect = false;
    this.lastError = null;
  }

  /** "Wipe all data" also forgets this device's Google connection. */
  async #forgetAfterWipe(): Promise<void> {
    await this.#bridge?.disconnect().catch(() => {});
    this.#resetConnection();
    this.notice = null;
    this.config = await loadCloudConfig(); // meta was cleared → new device id
    await this.#persist();
  }

  /** Delete every backup version from Google Drive. Returns how many. */
  async deleteAllBackups(): Promise<number> {
    const bridge = this.#bridge;
    if (!bridge) return 0;
    this.activity = "deleting";
    let deleted = 0;
    let failed = 0;
    try {
      for (const file of await bridge.list()) {
        try {
          await bridge.remove(file.id);
          deleted++;
        } catch {
          failed++;
        }
      }
    } catch (e) {
      this.notice = { kind: "error", text: describeCloudError(e).message };
      return deleted;
    } finally {
      this.activity = null;
    }
    clearTimeout(this.#debounce);
    this.conflict = null;
    this.versions = failed ? null : [];
    await this.#update({
      lastBackupAt: null,
      lastBackupId: null,
      lastSyncedRemoteId: null,
      dirty: authStore.entries.length > 0,
    });
    this.notice = failed
      ? {
          kind: "warning",
          text: `Deleted ${plural(deleted, "backup")}; ${failed} could not be deleted — try again.`,
        }
      : {
          kind: "success",
          text: `Deleted ${plural(deleted, "backup")} from Google Drive. A new one is made after your next change unless you disconnect.`,
        };
    return deleted;
  }

  /**
   * Refresh the version list for display (count, size, newest file). Quiet:
   * no activity state, no notices — a failure just leaves the old list.
   */
  async refreshVersions(): Promise<void> {
    const bridge = this.#bridge;
    if (!bridge || !this.account || this.needsReconnect) return;
    try {
      this.versions = sortNewestFirst(await bridge.list());
    } catch {
      // Display-only; the status line already reports real backup failures.
    }
  }

  /** Open Google Drive settings, where the hidden backup data is managed. */
  async openDriveSettings(): Promise<void> {
    try {
      await this.#bridge?.openDriveSettings();
    } catch (e) {
      this.notice = { kind: "error", text: describeCloudError(e).message };
    }
  }

  // ---- restore ----------------------------------------------------------------

  async listBackups(): Promise<RemoteBackup[]> {
    const bridge = this.#bridge;
    if (!bridge) return [];
    this.activity = "listing";
    try {
      const list = sortNewestFirst(await bridge.list());
      this.versions = list;
      return list;
    } finally {
      this.activity = null;
    }
  }

  /** Download one version and validate its structure (no decryption yet). */
  async fetchBackup(id: string): Promise<CloudBackupFile> {
    const bridge = this.#bridge;
    if (!bridge) throw new Error("Cloud backup is not available");
    this.activity = "downloading";
    try {
      return parseCloudBackup(await bridge.download(id));
    } finally {
      this.activity = null;
    }
  }

  /**
   * Decrypt a downloaded backup: with `password` when given, otherwise with
   * the current vault key (only works for this device's own recent backups).
   */
  async decryptBackup(file: CloudBackupFile, password?: string): Promise<CloudBackupPayload> {
    if (password) return openCloudBackup(file, await deriveBackupKey(file, password));
    const payload = await authStore.openCloudBackupWithVaultKey(file);
    if (!payload) {
      throw new CloudBackupError("wrong_password", "Enter the password this backup was made with.");
    }
    return payload;
  }

  /**
   * Restore a decrypted backup after device authentication (Windows Hello
   * where available; the caller has already required the password where
   * not). `newestId` is the newest remote version the user saw.
   */
  async applyRestore(
    version: RemoteBackup,
    payload: CloudBackupPayload,
    mode: "merge" | "replace",
    newestId: string,
    password?: string,
  ): Promise<RestoreResult> {
    await authStore.verifyUserPresence();

    const fresh = !authStore.encrypted;
    const hadEntries = authStore.entries.length > 0 || credentialStore.items.length > 0;
    this.activity = "restoring";
    this.#suppressChanges = true;
    let result: RestoreResult;
    try {
      result = await authStore.restoreFromBackup(payload, mode, password);
      if (fresh) await authStore.updateSettings({ ...payload.settings });
    } finally {
      this.#suppressChanges = false;
      this.activity = null;
    }

    // This device is now based on the newest version the user resolved
    // against. If local data now differs from that version (merged extra
    // accounts, or rolled back to an older one), upload it as the newest.
    const matchesNewest = version.id === newestId && (mode === "replace" || !hadEntries);
    this.conflict = null;
    await this.#update({
      lastRestoreAt: Date.now(),
      lastSyncedRemoteId: newestId,
      dirty: !matchesNewest,
    });
    this.notice = {
      kind: "success",
      text:
        `Restored ${plural(result.added, "account")}` +
        (result.credentialsAdded ? ` and ${plural(result.credentialsAdded, "credential")}` : "") +
        (result.skipped + result.credentialsSkipped
          ? ` (${result.skipped + result.credentialsSkipped} already on this device).`
          : "."),
    };
    if (!matchesNewest && this.connected && authStore.encrypted && this.config?.autoBackup) {
      void this.backupNow({ auto: true }); // auto: keep the restore message
    }
    return result;
  }
}

export const cloudBackup = new CloudBackupController();
