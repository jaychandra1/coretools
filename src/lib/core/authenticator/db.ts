/**
 * IndexedDB persistence for the Authenticator section.
 *
 * The app is frontend-only, so entries live in a local IndexedDB database:
 *  - "entries": one record per account. The secret is either `{ plain }`
 *    (vault disabled, with a visible warning) or `{ enc: { iv, ct } }`
 *    (AES-256-GCM, see vault-crypto.ts). With a password set, the issuer and
 *    account name are sealed in `meta` too (audit F-14) and the plaintext
 *    fields are stored empty; only order, pins and OTP parameters stay clear.
 *  - "credentials" / "audit": the Credential Manager (same rule: sealed).
 *  - "meta": vault configuration, settings, tombstones, keyed by name.
 *
 * Plaintext secrets never leave this device. The optional cloud backup
 * uploads only an end-to-end encrypted envelope (see cloud-backup.ts); its
 * bookkeeping lives under the "cloud" meta key, while the Google OAuth
 * credential itself is held by the native backend in the OS keychain.
 */

import type { OtpEntry } from "./types";
import type { EncryptedBlob } from "./vault-crypto";
import type { BackupKind } from "./cloud-sync";
import type { KdfParams } from "./kdf";
import {
  AUDIT_LIMIT,
  type StoredAuditEvent,
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
  /**
   * Issuer + account name sealed under the vault key (F-14). While present,
   * the plaintext `issuer`/`account` fields are empty on disk and filled
   * in memory only while unlocked.
   */
  meta?: EncryptedBlob;
  /** When this device added the account (ms); 0/absent for older records (F-09). */
  addedAt?: number;
}

/**
 * Deletion records (F-09), per collection. Sealed under the vault key when a
 * password is set — the hashes of credential identities are guessable.
 */
export interface TombstoneSet {
  entries: { k: string; at: number }[];
  credentials: { k: string; at: number }[];
}

export interface StoredTombstones {
  sealed?: EncryptedBlob;
  plain?: TombstoneSet;
}

/** Head of the audit hash chain (F-19), sealed under the vault key. */
export interface StoredAuditHead {
  sealed: EncryptedBlob;
}

/**
 * Opening the database failed because it was created by a NEWER version of
 * the app (IndexedDB refuses to open at a lower version). Shown as such
 * rather than as a generic failure (audit F-12).
 */
export class NewerDataError extends Error {
  constructor() {
    super(
      "This data was saved by a newer version of CoreTools. Install the latest version to open it — nothing has been changed or lost.",
    );
    this.name = "NewerDataError";
  }
}

/** Windows Hello unlock state: the vault key wrapped under a Hello-gated key. */
export interface HelloConfig {
  /** Fixed random challenge (base64) the Hello key signs on every unlock. */
  challenge: string;
  /** Vault-key bytes, AES-GCM-wrapped under the signature-derived key. */
  wrapped: EncryptedBlob;
}

/**
 * Vault (encryption) configuration; absent until the user makes a choice.
 *
 * Two layouts exist (see vault-keys.ts):
 *  - current: `kdf` + `salt` + `wrappedKey` — a random data key wrapped
 *    under an Argon2id key derived from the password;
 *  - legacy (before 1.2): `salt` + `iterations` — the data key is the
 *    PBKDF2 output itself. Upgraded on the next password unlock.
 */
export interface VaultConfig {
  encrypted: boolean;
  /** KDF salt, base64. Present when encrypted. */
  salt?: string;
  /** Legacy layout only: PBKDF2 iterations. */
  iterations?: number;
  /** Current layout: how the password is stretched into the key-encryption key. */
  kdf?: KdfParams;
  /** Current layout: the data key, wrapped under the key-encryption key. */
  wrappedKey?: EncryptedBlob;
  /** Sentinel encrypted with the data key; used to verify the password. */
  verifier?: EncryptedBlob;
  /** Present only while Windows Hello unlock is enabled (desktop, encrypted). */
  hello?: HelloConfig;
  /** When the master password was last typed to unlock (Hello re-check, F-20). */
  passwordCheckedAt?: number;
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
    request.onerror = () =>
      reject(request.error?.name === "VersionError" ? new NewerDataError() : request.error);
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

export function loadTombstones(): Promise<StoredTombstones | undefined> {
  return getMeta<StoredTombstones>("tombstones");
}

export function saveTombstones(value: StoredTombstones): Promise<void> {
  return setMeta("tombstones", value);
}

/** What else a vault-wide write replaces, in the same transaction. */
export interface VaultWriteExtras {
  /** Replaces the whole credential store. */
  credentials?: StoredCredential[];
  /** Replaces the whole audit log and its chain head (null head = none). */
  audit?: { records: StoredAuditEvent[]; head: StoredAuditHead | null };
  /** Further meta keys (e.g. "tombstones"). */
  meta?: Record<string, unknown>;
}

/**
 * Write the vault config and the full entry set in ONE transaction, so an
 * interruption (crash, closed window) can never leave a vault whose verifier
 * doesn't match its entries — it's all or nothing. Everything else a
 * password change or restore rewrites (credentials, the audit log,
 * tombstones) goes into the same transaction for the same reason.
 */
export async function saveVaultAndEntries(
  vault: VaultConfig,
  entries: StoredEntry[],
  extras: VaultWriteExtras = {},
): Promise<void> {
  const { credentials, audit } = extras;
  const database = await db();
  const stores = ["entries", "meta"];
  if (credentials) stores.push("credentials");
  if (audit) stores.push("audit");
  const tx = database.transaction(stores, "readwrite");
  const store = tx.objectStore("entries");
  store.clear();
  for (const entry of entries) {
    store.put(JSON.parse(JSON.stringify(entry)));
  }
  const meta = tx.objectStore("meta");
  meta.put(JSON.parse(JSON.stringify(vault)), "vault");
  for (const [key, value] of Object.entries(extras.meta ?? {})) {
    meta.put(JSON.parse(JSON.stringify(value)), key);
  }
  if (audit) {
    const auditStore = tx.objectStore("audit");
    auditStore.clear();
    for (const record of audit.records) auditStore.put(JSON.parse(JSON.stringify(record)));
    if (audit.head) meta.put(JSON.parse(JSON.stringify(audit.head)), "auditHead");
    else meta.delete("auditHead");
  }
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

export async function countCredentials(): Promise<number> {
  const database = await db();
  const store = database.transaction("credentials").objectStore("credentials");
  return requestResult(store.count());
}

export async function deleteCredentials(ids: string[]): Promise<void> {
  const database = await db();
  const tx = database.transaction("credentials", "readwrite");
  const store = tx.objectStore("credentials");
  for (const id of ids) store.delete(id);
  await txDone(tx);
}

/**
 * Every stored audit record, oldest first by chain position. Records written
 * before 1.2 are plaintext `{ id, at, action, credentialId, platform }` with
 * no `seq`; they are sealed into the chain on the next unlock.
 */
export async function loadAuditRecords(): Promise<StoredAuditEvent[]> {
  const database = await db();
  const store = database.transaction("audit").objectStore("audit");
  const all = await requestResult(store.getAll() as IDBRequest<StoredAuditEvent[]>);
  return all.sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1) || a.at - b.at);
}

export function loadAuditHead(): Promise<StoredAuditHead | undefined> {
  return getMeta<StoredAuditHead>("auditHead");
}

/**
 * Append sealed events and move the chain head in ONE transaction, then drop
 * the oldest records beyond AUDIT_LIMIT (the chain stays verifiable from the
 * oldest record kept).
 */
export async function appendAuditRecords(
  records: StoredAuditEvent[],
  head: StoredAuditHead,
): Promise<void> {
  const database = await db();
  const tx = database.transaction(["audit", "meta"], "readwrite");
  const store = tx.objectStore("audit");
  for (const record of records) store.put(JSON.parse(JSON.stringify(record)));
  tx.objectStore("meta").put(JSON.parse(JSON.stringify(head)), "auditHead");
  const all = store.getAll() as IDBRequest<StoredAuditEvent[]>;
  all.onsuccess = () => {
    const sorted = all.result.sort((a, b) => (b.seq ?? -1) - (a.seq ?? -1));
    for (const old of sorted.slice(AUDIT_LIMIT)) store.delete(old.id);
  };
  await txDone(tx);
}

/** Replace the whole log (migration to the sealed chain, password change). */
export async function replaceAuditRecords(
  records: StoredAuditEvent[],
  head: StoredAuditHead | null,
): Promise<void> {
  const database = await db();
  const tx = database.transaction(["audit", "meta"], "readwrite");
  const store = tx.objectStore("audit");
  store.clear();
  for (const record of records) store.put(JSON.parse(JSON.stringify(record)));
  if (head) tx.objectStore("meta").put(JSON.parse(JSON.stringify(head)), "auditHead");
  else tx.objectStore("meta").delete("auditHead");
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
