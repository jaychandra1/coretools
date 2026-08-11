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
 * Plaintext secrets never leave this device; there is no sync backend.
 */

import type { OtpEntry } from "./types";
import type { EncryptedBlob } from "./vault-crypto";

const DB_NAME = "coretools-authenticator";
const DB_VERSION = 1;

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
}

export const DEFAULT_SETTINGS: AuthSettings = {
  autoLockMinutes: 5,
  clipboardClear: false,
  groupCodes: true,
  backupReminderDismissedAt: 0,
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("entries")) {
        db.createObjectStore("entries", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    request.onsuccess = () => resolve(request.result);
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

/** Danger zone: delete every entry, the vault config and all settings. */
export async function wipeAll(): Promise<void> {
  const database = await db();
  const tx = database.transaction(["entries", "meta"], "readwrite");
  tx.objectStore("entries").clear();
  tx.objectStore("meta").clear();
  await txDone(tx);
}
