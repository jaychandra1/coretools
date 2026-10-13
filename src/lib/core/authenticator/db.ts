/**
 * IndexedDB persistence for the Authenticator section.
 *
 * The app is frontend-only, so entries live in a local IndexedDB database:
 *  - "entries": one record per account. Metadata (issuer, account, type, …)
 *    is stored in the clear — same model as the browser extension — while the
 *    secret is either `{ plain }` (vault disabled, with a visible warning) or
 *    `{ enc: { iv, ct } }` (AES-256-GCM, see vault-crypto.ts).
 *  - "meta": vault configuration and user settings, keyed by name.
 *
 * Plaintext secrets never leave this device. The optional cloud backup
 * uploads only an end-to-end encrypted envelope (see cloud-backup.ts); its
 * bookkeeping lives under the "cloud" meta key, while the Google OAuth
 * credential itself is held by the native backend in the OS keychain.
 */

import type { OtpEntry } from "./types";
import type { EncryptedBlob } from "./vault-crypto";
import type { BackupKind } from "./cloud-sync";
import {
  AUDIT_LIMIT,
  type AuditEvent,
  type StoredCredential,
} from "../credentials/types";

const DB_NAME = "coretools-authenticator";
/**
 * v1: entries + meta (Authenticator).
 * v2: + credentials + audit (Credential Manager, sharing the same vault).
 */
const DB_VERSION = 2;

export interface StoredSecret {
  plain?: string;
  enc?: EncryptedBlob;
}

export interface StoredEntry extends OtpEntry {
  secret: StoredSecret;
}

/** Windows Hello unlock state: the vault key wrapped under a Hello-gated key. */
export interface HelloConfig {
  /** Fixed random challenge (base64) the Hello key signs on every unlock. */
  challenge: string;
  /** Vault-key bytes, AES-GCM-wrapped under the signature-derived key. */
  wrapped: EncryptedBlob;
}

/** Vault (encryption) configuration; absent until the user makes a choice. */
export interface VaultConfig {
  encrypted: boolean;
  /** PBKDF2 salt, base64. Present when encrypted. */
  salt?: string;
  iterations?: number;
  /** Sentinel encrypted with the vault key; used to verify the password. */
  verifier?: EncryptedBlob;
  /** Present only while Windows Hello unlock is enabled (desktop, encrypted). */
  hello?: HelloConfig;
}

export interface AuthSettings {
  /** Minutes of inactivity before the section locks. 0 = never. */
  autoLockMinutes: number;
  /** Clear the clipboard 30 s after copying a code. */
  clipboardClear: boolean;
  /** Show codes grouped ("123 456") or plain ("123456"). */
  groupCodes: boolean;
  /** Unix ms when the backup reminder was last dismissed. */
  backupReminderDismissedAt: number;
  /**
   * Credential Manager: ask for Windows Hello / the master password before
   * revealing or copying a password (then trust the session for a minute).
   */
  credentialsRevealAuth: boolean;
}

/** Per-series backup state (one each for the Authenticator and Credential Manager). */
export interface CloudSeriesState {
  /** Local changes not yet in a backup of this series. */
  dirty: boolean;
  lastBackupAt: number | null;
  lastBackupId: string | null;
  /** The remote version of this series this device's data is based on (conflict detection). */
  lastSyncedRemoteId: string | null;
}

/** Cloud backup bookkeeping (no credentials — those live in the OS keychain). */
export interface CloudConfig {
  /** Random per-install id, tagged on every backup this device uploads. */
  deviceId: string;
  /** Connected Google account, or null when disconnected. */
  email: string | null;
  /** Back up automatically after every change. */
  autoBackup: boolean;
  series: Record<BackupKind, CloudSeriesState>;
  lastRestoreAt: number | null;
}

export const EMPTY_SERIES: Readonly<CloudSeriesState> = {
  dirty: false,
  lastBackupAt: null,
  lastBackupId: null,
  lastSyncedRemoteId: null,
};

/** Stored before the series split: one series holding everything. */
interface LegacyCloudConfig {
  dirty?: boolean;
  lastBackupAt?: number | null;
  lastBackupId?: string | null;
  lastSyncedRemoteId?: string | null;
}

export const DEFAULT_SETTINGS: AuthSettings = {
  autoLockMinutes: 5,
  clipboardClear: false,
  groupCodes: true,
  backupReminderDismissedAt: 0,
  credentialsRevealAuth: true,
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // Additive only: existing stores and data are never touched on upgrade.
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, options] of [
        ["entries", { keyPath: "id" }],
        ["meta", undefined],
        ["credentials", { keyPath: "id" }],
        ["audit", { keyPath: "id" }],
      ] as const) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      // Let a newer schema (another tab, a hot reload) upgrade instead of
      // being blocked by this connection; the next call reopens.
      database.onversionchange = () => {
        database.close();
        dbPromise = null;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= openDb();
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadEntries(): Promise<StoredEntry[]> {
  const database = await db();
  const store = database.transaction("entries").objectStore("entries");
  const all = await requestResult(store.getAll() as IDBRequest<StoredEntry[]>);
  return all.sort((a, b) => a.index - b.index);
}

export async function saveEntries(entries: StoredEntry[]): Promise<void> {
  const database = await db();
  const tx = database.transaction("entries", "readwrite");
  const store = tx.objectStore("entries");
  for (const entry of entries) {
    // $state proxies aren't structured-cloneable; snapshot to plain JSON.
    store.put(JSON.parse(JSON.stringify(entry)));
  }
  await txDone(tx);
}

export async function deleteEntry(id: string): Promise<void> {
  const database = await db();
  const tx = database.transaction("entries", "readwrite");
  tx.objectStore("entries").delete(id);
  await txDone(tx);
}

export async function replaceAllEntries(entries: StoredEntry[]): Promise<void> {
  const database = await db();
  const tx = database.transaction("entries", "readwrite");
  const store = tx.objectStore("entries");
  store.clear();
  for (const entry of entries) {
    store.put(JSON.parse(JSON.stringify(entry)));
  }
  await txDone(tx);
}

async function getMeta<T>(key: string): Promise<T | undefined> {
  const database = await db();
  const store = database.transaction("meta").objectStore("meta");
  return requestResult(store.get(key) as IDBRequest<T | undefined>);
}

async function setMeta(key: string, value: unknown): Promise<void> {
  const database = await db();
  const tx = database.transaction("meta", "readwrite");
  tx.objectStore("meta").put(JSON.parse(JSON.stringify(value)), key);
  await txDone(tx);
}

export function loadVaultConfig(): Promise<VaultConfig | undefined> {
  return getMeta<VaultConfig>("vault");
}

export function saveVaultConfig(config: VaultConfig): Promise<void> {
  return setMeta("vault", config);
}

export async function loadSettings(): Promise<AuthSettings> {
  const stored = await getMeta<Partial<AuthSettings>>("settings");
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(settings: AuthSettings): Promise<void> {
  return setMeta("settings", settings);
}

export async function loadCloudConfig(): Promise<CloudConfig> {
  const stored = await getMeta<Partial<CloudConfig> & LegacyCloudConfig>("cloud");
  return {
    deviceId: stored?.deviceId || crypto.randomUUID(),
    email: stored?.email ?? null,
    autoBackup: stored?.autoBackup ?? true,
    series: stored?.series ?? migrateSeries(stored),
    lastRestoreAt: stored?.lastRestoreAt ?? null,
  };
}

/**
 * Before the split, every backup was one "coretools-authenticator-" file that
 * also held credentials. Those files stay the authenticator series' history;
 * the Credential Manager starts its own series with the next backup (an
 * empty one is skipped, see the controller).
 */
function migrateSeries(stored: (Partial<CloudConfig> & LegacyCloudConfig) | undefined) {
  return {
    authenticator: {
      dirty: stored?.dirty ?? false,
      lastBackupAt: stored?.lastBackupAt ?? null,
      lastBackupId: stored?.lastBackupId ?? null,
      lastSyncedRemoteId: stored?.lastSyncedRemoteId ?? null,
    },
    credmanager: { ...EMPTY_SERIES, dirty: !!stored?.email },
  };
}

export function saveCloudConfig(config: CloudConfig): Promise<void> {
  return setMeta("cloud", config);
}

/**
 * Write the vault config and the full entry set in ONE transaction, so an
 * interruption (crash, closed window) can never leave a vault whose verifier
 * doesn't match its entries — it's all or nothing. When `credentials` is
 * given (password change, restore), the credential store is replaced in the
 * same transaction for the same reason.
 */
export async function saveVaultAndEntries(
  vault: VaultConfig,
  entries: StoredEntry[],
  credentials?: StoredCredential[],
): Promise<void> {
  const database = await db();
  const stores = credentials ? ["entries", "meta", "credentials"] : ["entries", "meta"];
  const tx = database.transaction(stores, "readwrite");
  const store = tx.objectStore("entries");
  store.clear();
  for (const entry of entries) {
    store.put(JSON.parse(JSON.stringify(entry)));
  }
  tx.objectStore("meta").put(JSON.parse(JSON.stringify(vault)), "vault");
  if (credentials) {
    const credStore = tx.objectStore("credentials");
    credStore.clear();
    for (const credential of credentials) {
      credStore.put(JSON.parse(JSON.stringify(credential)));
    }
  }
  await txDone(tx);
}

// ---- Credential Manager ---------------------------------------------------------

export async function loadCredentials(): Promise<StoredCredential[]> {
  const database = await db();
  const store = database.transaction("credentials").objectStore("credentials");
  return requestResult(store.getAll() as IDBRequest<StoredCredential[]>);
}

export async function saveCredentials(credentials: StoredCredential[]): Promise<void> {
  const database = await db();
  const tx = database.transaction("credentials", "readwrite");
  const store = tx.objectStore("credentials");
  for (const credential of credentials) {
    store.put(JSON.parse(JSON.stringify(credential)));
  }
  await txDone(tx);
}

export async function deleteCredentials(ids: string[]): Promise<void> {
  const database = await db();
  const tx = database.transaction("credentials", "readwrite");
  const store = tx.objectStore("credentials");
  for (const id of ids) store.delete(id);
  await txDone(tx);
}

/** Newest first. */
export async function loadAudit(): Promise<AuditEvent[]> {
  const database = await db();
  const store = database.transaction("audit").objectStore("audit");
  const all = await requestResult(store.getAll() as IDBRequest<AuditEvent[]>);
  return all.sort((a, b) => b.at - a.at);
}

/** Append events, dropping the oldest beyond AUDIT_LIMIT. */
export async function appendAudit(events: AuditEvent[]): Promise<void> {
  const database = await db();
  const tx = database.transaction("audit", "readwrite");
  const store = tx.objectStore("audit");
  for (const event of events) store.put(event);
  const keysRequest = store.getAll() as IDBRequest<AuditEvent[]>;
  keysRequest.onsuccess = () => {
    const all = keysRequest.result.sort((a, b) => b.at - a.at);
    for (const old of all.slice(AUDIT_LIMIT)) store.delete(old.id);
  };
  await txDone(tx);
}

/** Danger zone: delete every entry, credential, audit event, the vault config and all settings. */
export async function wipeAll(): Promise<void> {
  const database = await db();
  const tx = database.transaction(["entries", "meta", "credentials", "audit"], "readwrite");
  tx.objectStore("entries").clear();
  tx.objectStore("meta").clear();
  tx.objectStore("credentials").clear();
  tx.objectStore("audit").clear();
  await txDone(tx);
}
