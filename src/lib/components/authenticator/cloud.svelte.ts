/**
 * Cloud backup controller (Svelte 5 runes): connection state, automatic
 * backups, multi-device conflicts, retries and the restore flow.
 *
 * Division of labour:
 *  - the native backend (CloudBridge) does OAuth and HTTP and holds the
 *    Google credential — this file never sees a token;
 *  - the AuthStore seals/opens backups with the in-memory vault key;
 *  - the policy (naming, conflict detection, retention, back-off, error
 *    mapping) is in core/authenticator/cloud-sync.ts, where it is unit-tested.
 *
 * Two independent backup series share one Google connection: the 2FA
 * accounts ("authenticator") and the Credential Manager ("credmanager").
 * Each has its own files, versions, dirty flag and conflict state, so a
 * change to one never re-uploads — or waits on a conflict in — the other.
 *
 * Automatic backup: every persisted change marks its series dirty and
 * schedules a debounced backup. Changes only happen while unlocked, so the
 * vault key is available; if the vault locks before the timer fires, the
 * backup simply runs on the next unlock. Failures that may heal on their own
 * (offline, Google 5xx) retry with back-off and whenever the OS reports the
 * network is back.
 */

import { authStore, type AuthEvent, type RestoreResult } from "./store.svelte";
import { getPlatform } from "../../platform";
import {
  EMPTY_SERIES,
  loadCloudConfig,
  saveCloudConfig,
  type CloudConfig,
  type CloudSeriesState,
} from "../../core/authenticator/db";
import {
  AUTO_BACKUP_INTERVAL_MS,
  BACKUP_KIND_LABELS,
  BACKUP_KINDS,
  backupKindOf,
  describeCloudError,
  detectConflict,
  ofKind,
  performBackup,
  retryDelayMs,
  sortNewestFirst,
  type BackupKind,
  type RemoteBackup,
} from "../../core/authenticator/cloud-sync";
import {
  CloudBackupError,
  deriveBackupKey,
  openCloudBackup,
  parseCloudBackup,
  restoreParts,
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

/** One decrypted version chosen for restore, with its series' newest id. */
export interface RestorePick {
  version: RemoteBackup;
  payload: CloudBackupPayload;
  /** Newest version of the same series the user saw (conflict baseline). */
  newestId: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * "Restored 4 accounts (1 already on this device or deleted here). Removed
 * 1 that another device deleted."
 */
export function restoreSummary(result: RestoreResult): string {
  const parts: string[] = [];
  if (result.restoredAccounts) parts.push(plural(result.added, "account"));
  if (result.restoredCredentials) parts.push(plural(result.credentialsAdded, "credential"));
  const skipped = result.skipped + result.credentialsSkipped;
  const removed = result.removed + result.credentialsRemoved;
  return (
    `Restored ${parts.join(" and ") || "nothing"}` +
    (skipped ? ` (${skipped} already here or deleted here).` : ".") +
    (removed ? ` Removed ${removed} that another device deleted.` : "")
  );
}

function fallbackDeviceLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Mac/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux PC";
  return "Desktop";
}

/** e.g. "Pixel-PC's Credential Manager backup". */
function describeRemote(kind: BackupKind, remote: RemoteBackup): string {
  return `${remote.deviceLabel || "another device"}'s ${BACKUP_KIND_LABELS[kind]} backup`;
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
  /** Per series: a newer backup from another device that uploading would bury. */
  conflicts = $state<Partial<Record<BackupKind, RemoteBackup>>>({});
  /** Google access is gone (revoked, expired, keychain cleared). */
  needsReconnect = $state(false);
  /** Message of the last failed automatic backup, cleared on success. */
  lastError = $state<string | null>(null);
  /** When the next automatic retry fires (ms), or null. */
  retryAt = $state<number | null>(null);
  /** Backup versions of every series in Drive, newest first; null until first known. */
  versions = $state<RemoteBackup[] | null>(null);
  /** The series a running backup pass is working on. */
  backingUp = $state<BackupKind | null>(null);

  #bridge = getPlatform().cloud ?? null;
  #initPromise: Promise<void> | null = null;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #running: Promise<void> | null = null;
  /** When the last automatic pass started (coalescing, F-10). */
  #lastAutoPassAt = 0;
  /** Bumped on every change per series; tells whether a change raced a backup. */
  #changeSeq: Record<BackupKind, number> = { authenticator: 0, credmanager: 0 };
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

  /** Series waiting for the user to resolve a conflict, in display order. */
  get conflictKinds(): BackupKind[] {
    return BACKUP_KINDS.filter((kind) => this.conflicts[kind]);
  }

  /** The newer backup of `kind` from another device, if any. */
  conflictOf(kind: BackupKind): RemoteBackup | null {
    return this.conflicts[kind] ?? null;
  }

  /** Newest backup of `kind` made from this device (of any series when omitted). */
  lastBackupAtOf(kind?: BackupKind): number | null {
    const kinds = kind ? [kind] : BACKUP_KINDS;
    const times = kinds.map((k) => this.config?.series[k].lastBackupAt ?? 0);
    return Math.max(...times) || null;
  }

  /** Unsaved changes in `kind` (in any series when omitted). */
  dirtyOf(kind?: BackupKind): boolean {
    return (kind ? [kind] : BACKUP_KINDS).some((k) => this.config?.series[k].dirty);
  }

  get dirty(): boolean {
    return this.dirtyOf();
  }

  /**
   * Backup status as one section sees it: conflicts, pending changes and
   * running backups of the other series don't show. The Google connection
   * and network errors are shared, so they show everywhere.
   */
  statusOf(kind?: BackupKind): CloudStatus {
    if (!this.available) return "unavailable";
    if (!this.account) return this.needsReconnect ? "reconnect" : "disconnected";
    if (this.needsReconnect) return "reconnect";
    if (!authStore.encrypted) return "needs-password";
    if (kind ? this.conflicts[kind] : this.conflictKinds.length) return "conflict";
    if (this.activity && !(kind && this.activity === "backing-up" && this.backingUp !== kind)) {
      return "working";
    }
    if (this.retryAt) return "retrying";
    if (this.lastError) return "error";
    if (this.dirtyOf(kind)) return "pending";
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
    await this.#persist(); // stores a freshly generated device id / migrated series

    authStore.subscribe((event) => this.#onAuthEvent(event));
    window.addEventListener("online", () => {
      if (this.retryAt) this.#kick();
    });
    this.ready = true;

    if (this.connected && this.dirty && config.autoBackup) this.#schedule(1000);
  }

  async #persist(): Promise<void> {
    if (this.config) await saveCloudConfig($state.snapshot(this.config));
  }

  async #update(patch: Partial<CloudConfig>): Promise<void> {
    if (!this.config) return;
    this.config = { ...this.config, ...patch };
    await this.#persist();
  }

  /** Patch some series' state (the others are kept). */
  async #updateSeries(
    patch: (kind: BackupKind, state: CloudSeriesState) => Partial<CloudSeriesState> | null,
  ): Promise<void> {
    if (!this.config) return;
    const series = { ...this.config.series };
    for (const kind of BACKUP_KINDS) {
      const change = patch(kind, series[kind]);
      if (change) series[kind] = { ...series[kind], ...change };
    }
    await this.#update({ series });
  }

  #dropConflicts(kinds: readonly BackupKind[]): void {
    const next: Partial<Record<BackupKind, RemoteBackup>> = {};
    for (const kind of this.conflictKinds) {
      if (!kinds.includes(kind)) next[kind] = this.conflicts[kind];
    }
    this.conflicts = next;
  }

  #markDirty(kinds: readonly BackupKind[]): void {
    for (const kind of kinds) this.#changeSeq[kind]++;
    if (kinds.some((kind) => !this.config?.series[kind].dirty)) {
      void this.#updateSeries((kind) => (kinds.includes(kind) ? { dirty: true } : null));
    }
  }

  #onAuthEvent(event: AuthEvent): void {
    if (event === "wipe") {
      void this.#forgetAfterWipe();
      return;
    }
    if (this.#suppressChanges || !this.connected || !this.config) return;

    if (event === "change" || event === "credentials" || event === "password") {
      // A password now exists: drop the "set a password first" warning.
      if (event === "password" && authStore.encrypted && this.notice?.kind === "warning") {
        this.notice = null;
      }
      // A new password re-encrypts everything, so every series needs a
      // backup under the new key (or old backups would need the old one).
      this.#markDirty(
        event === "change" ? ["authenticator"] : event === "credentials" ? ["credmanager"] : BACKUP_KINDS,
      );
      if (event === "password" && !authStore.encrypted) {
        this.notice = {
          kind: "warning",
          text: "Cloud backups are paused until you set an encryption password — it is what encrypts them.",
        };
        return;
      }
      if (this.config.autoBackup) this.#schedule(DEBOUNCE_MS);
    } else if (event === "unlock") {
      if (this.dirty && this.config.autoBackup) this.#schedule(1000);
    }
  }

  /**
   * Schedule an automatic pass. Passes are coalesced to at most one per
   * AUTO_BACKUP_INTERVAL_MS (F-10): a burst of edits — reordering, HOTP
   * counter steps — becomes one backup, which keeps both the shared Drive
   * quota and the version history useful. Manual backups aren't throttled.
   */
  #schedule(delay: number): void {
    clearTimeout(this.#debounce);
    const wait = Math.max(delay, this.#lastAutoPassAt + AUTO_BACKUP_INTERVAL_MS - Date.now());
    this.#debounce = setTimeout(() => void this.backupNow({ auto: true }), wait);
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
   * Back up now. Concurrent calls queue behind the running one. Automatic
   * passes upload only series with unsaved changes; a manual pass makes a
   * fresh version of every series. `force` (with `series`) uploads even over
   * another device's newer version — the user chose to keep this device's
   * data; that version stays available for rollback.
   */
  async backupNow(
    opts: { auto?: boolean; force?: boolean; series?: readonly BackupKind[] } = {},
  ): Promise<void> {
    clearTimeout(this.#debounce);
    while (this.#running) await this.#running;
    if (opts.auto && !this.dirty) return;
    this.#running = this.#backup(opts).finally(() => (this.#running = null));
    await this.#running;
  }

  async #backup({
    auto = false,
    force = false,
    series = BACKUP_KINDS,
  }: {
    auto?: boolean;
    force?: boolean;
    series?: readonly BackupKind[];
  }): Promise<void> {
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

    if (auto) this.#lastAutoPassAt = Date.now();
    this.activity = "backing-up";
    const uploaded: string[] = [];
    const conflicted: BackupKind[] = [];
    try {
      for (const kind of series) {
        const state = this.config?.series[kind] ?? EMPTY_SERIES;
        if (auto && !state.dirty) continue;
        if (auto && this.conflicts[kind]) continue; // waiting for the user's decision
        this.backingUp = kind;

        // Nothing to protect and nothing in this series yet: don't create an
        // empty first version (keeps a fresh install from shadowing the
        // backups another device may already have made).
        const count = await authStore.seriesCount(kind);
        if (!force && count === 0 && state.lastSyncedRemoteId === null) {
          await this.#updateSeries((k) => (k === kind ? { dirty: false } : null));
          continue;
        }

        const seq = this.#changeSeq[kind];
        const outcome = await performBackup({
          transport: bridge,
          series: kind,
          seal: () =>
            authStore.sealCloudBackup({ id: config.deviceId, label: this.deviceLabel }, kind),
          deviceId: config.deviceId,
          deviceLabel: this.deviceLabel,
          lastSyncedRemoteId: state.lastSyncedRemoteId,
          force,
        });

        if (outcome.kind === "conflict") {
          this.conflicts = { ...this.conflicts, [kind]: outcome.remote };
          conflicted.push(kind);
          continue;
        }

        this.#dropConflicts([kind]);
        if (this.versions) {
          this.versions = sortNewestFirst([
            ...this.versions.filter((v) => backupKindOf(v.name) !== kind),
            ...outcome.versions,
          ]);
        }
        await this.#updateSeries((k) =>
          k === kind
            ? {
                lastBackupAt: Date.now(),
                lastBackupId: outcome.file.id,
                lastSyncedRemoteId: outcome.file.id,
                dirty: this.#changeSeq[kind] !== seq,
              }
            : null,
        );
        uploaded.push(
          kind === "authenticator" ? plural(count, "account") : plural(count, "credential"),
        );
      }

      this.lastError = null;
      this.#clearRetry();
      if (!auto && conflicted.length) {
        const kind = conflicted[0];
        const remote = this.conflicts[kind];
        this.notice = {
          kind: "warning",
          text:
            (uploaded.length ? `Backed up ${uploaded.join(" and ")}. ` : "") +
            `${remote ? describeRemote(kind, remote) : "Another device's backup"} is newer — merge it first, or keep this device's data.`,
        };
      } else if (!auto && uploaded.length) {
        this.notice = {
          kind: "success",
          text: `Backed up ${uploaded.join(" and ")} to Google Drive.`,
        };
      } else if (!auto) {
        this.notice = { kind: "success", text: "Nothing to back up yet." };
      }
      if (this.dirty && this.config?.autoBackup) this.#schedule(DEBOUNCE_MS);
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
      this.backingUp = null;
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
      await this.#update({ email: account.email });
      // A different Google account holds a different backup history.
      if (switched) {
        this.versions = null;
        await this.#updateSeries(() => ({
          lastSyncedRemoteId: null,
          lastBackupId: null,
          lastBackupAt: null,
        }));
      }
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
   * Connect (or reconnect) the Google account, then make the first backup of
   * each series — except a series where the account already holds another
   * device's backups: that one stops and lets the user restore/merge before
   * anything is overwritten. One connection serves both modules; `scope` is
   * the section the user connected from, which the messages talk about.
   */
  async connect(scope?: BackupKind): Promise<void> {
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
      this.versions = remote;
    } catch (e) {
      this.notice = { kind: "error", text: describeCloudError(e).message };
      return;
    } finally {
      this.activity = null;
    }

    const conflicts: Partial<Record<BackupKind, RemoteBackup>> = {};
    for (const kind of BACKUP_KINDS) {
      const found = detectConflict(
        ofKind(remote, kind),
        config.series[kind].lastSyncedRemoteId,
        config.deviceId,
      );
      if (found) conflicts[kind] = found;
    }
    this.conflicts = conflicts;

    const free = BACKUP_KINDS.filter((kind) => !conflicts[kind]);
    this.#markDirty(free);
    if (free.length) await this.backupNow({ series: free });

    const shown = scope ? (conflicts[scope] ? scope : undefined) : this.conflictKinds[0];
    const theirs = shown ? this.conflicts[shown] : undefined;
    if (shown && theirs) {
      this.notice = {
        kind: "warning",
        text: `Connected as ${this.account}. This account already has ${describeRemote(shown, theirs)} — restore or merge it, or keep this device's data.`,
      };
    } else if (this.notice?.kind === "success") {
      this.notice = {
        kind: "success",
        text: `Connected as ${this.account}. Every change is now backed up, end-to-end encrypted.`,
      };
    }
  }

  /**
   * Resolve open conflicts — of `scope` only, when given — by uploading this
   * device's data as the newest version.
   */
  async keepThisDevice(scope?: BackupKind): Promise<void> {
    const kinds = this.conflictKinds.filter((kind) => !scope || kind === scope);
    if (!kinds.length) return;
    this.#markDirty(kinds);
    await this.backupNow({ force: true, series: kinds });
  }

  async setAutoBackup(on: boolean): Promise<void> {
    await this.#update({ autoBackup: on });
    if (on && this.dirty) this.#schedule(1000);
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
      series: { authenticator: { ...EMPTY_SERIES }, credmanager: { ...EMPTY_SERIES } },
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
    this.conflicts = {};
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

  /**
   * Delete every backup version of `scope` (of every series when omitted)
   * from Google Drive. Returns how many.
   */
  async deleteAllBackups(scope?: BackupKind): Promise<number> {
    const bridge = this.#bridge;
    if (!bridge) return 0;
    const kinds = scope ? [scope] : BACKUP_KINDS;
    this.activity = "deleting";
    let deleted = 0;
    let failed = 0;
    try {
      const all = await bridge.list();
      for (const file of scope ? ofKind(all, scope) : all) {
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
    this.#dropConflicts(kinds);
    if (failed || !this.versions) this.versions = null;
    else this.versions = this.versions.filter((v) => !kinds.some((k) => backupKindOf(v.name) === k));
    const counts = {
      authenticator: await authStore.seriesCount("authenticator"),
      credmanager: await authStore.seriesCount("credmanager"),
    };
    await this.#updateSeries((kind) =>
      kinds.includes(kind)
        ? {
            lastBackupAt: null,
            lastBackupId: null,
            lastSyncedRemoteId: null,
            dirty: counts[kind] > 0,
          }
        : null,
    );
    const what = scope ? `${BACKUP_KIND_LABELS[scope]} backup` : "backup";
    this.notice = failed
      ? {
          kind: "warning",
          text: `Deleted ${plural(deleted, what)}; ${failed} could not be deleted — try again.`,
        }
      : {
          kind: "success",
          text: `Deleted ${plural(deleted, what)} from Google Drive. A new one is made after your next change unless you disconnect.`,
        };
    return deleted;
  }

  /**
   * Refresh the version list for display (counts and sizes). Quiet: no
   * activity state, no notices — a failure just leaves the old list.
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

  // ---- restore ----------------------------------------------------------------

  /** Every version of every series, newest first. */
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
   * Restore decrypted versions (at most one per series) after device
   * authentication (Windows Hello where available; the caller has already
   * required the password where not). Series without a pick are untouched;
   * with `scope`, so is everything outside that module.
   */
  async applyRestore(
    picks: RestorePick[],
    mode: "merge" | "replace",
    password?: string,
    scope?: BackupKind,
  ): Promise<RestoreResult> {
    await authStore.verifyUserPresence();

    const fresh = !authStore.encrypted;
    const had: Record<BackupKind, boolean> = {
      authenticator: authStore.entries.length > 0,
      credmanager: (await authStore.seriesCount("credmanager")) > 0,
    };
    const parts = restoreParts(picks.map((pick) => pick.payload), scope);
    this.activity = "restoring";
    this.#suppressChanges = true;
    let result: RestoreResult;
    try {
      result = await authStore.restoreFromBackup(parts, mode, password);
      if (fresh && parts.settings) await authStore.updateSettings({ ...parts.settings });
    } finally {
      this.#suppressChanges = false;
      this.activity = null;
    }

    // Each restored series is now based on the newest version the user
    // resolved against. If local data now differs from that version (merged
    // extra records, or rolled back to an older one), it uploads as the
    // newest. Data restored from outside its own series — credentials in a
    // legacy combined file — always needs its first backup of its own.
    const touched: Record<BackupKind, boolean> = {
      authenticator: parts.entries !== null,
      credmanager: parts.credentials !== null,
    };
    const resolved = new Set<BackupKind>();
    await this.#updateSeries((kind) => {
      const pick = picks.find((p) => backupKindOf(p.version.name) === kind);
      if (pick) {
        resolved.add(kind);
        const matchesNewest =
          pick.version.id === pick.newestId && (mode === "replace" || !had[kind]);
        return { lastSyncedRemoteId: pick.newestId, dirty: !matchesNewest };
      }
      return touched[kind] ? { dirty: true } : null;
    });
    this.#dropConflicts([...resolved]);
    await this.#update({ lastRestoreAt: Date.now() });

    this.notice = { kind: "success", text: restoreSummary(result) };
    if (this.dirty && this.connected && authStore.encrypted && this.config?.autoBackup) {
      void this.backupNow({ auto: true }); // auto: keep the restore message
    }
    return result;
  }
}

export const cloudBackup = new CloudBackupController();
