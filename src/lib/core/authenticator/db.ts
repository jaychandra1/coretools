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
 *  - "snapshots": the last few copies of the vault as stored, taken before
 *    each destructive operation so a mistake can be undone (audit D-8).
 *
 * Several windows (browser tabs) can open the same database. Every write to
 * vault content (and to the settings) bumps a "generation" counter in the
 * same transaction and is refused when this window last read an older
 * generation than the one on disk; other windows hear about every write over
 * a BroadcastChannel and read the vault again (audit D-1). Within a window,
 * writes run one at a time, and a write requested before the window last
 * re-read the vault is refused too (vaultEpoch): it was prepared from state
 * that has since been replaced. Together these keep a window holding stale
 * state — an old key after a password change elsewhere, entries another
 * window deleted — from overwriting newer data, as long as the vault store
 * checks the epoch it started from before each write (store.svelte.ts).
 *
 * Plaintext secrets never leave this device. The optional cloud backup
 * uploads only an end-to-end encrypted envelope (see cloud-backup.ts); its
 * bookkeeping lives under the "cloud" meta key, while the Google OAuth
 * credential itself is held by the native backend in the OS keychain.
 */

import type { OtpEntry } from "./types";
import { sha256Hex, type EncryptedBlob } from "./vault-crypto";
import type { BackupKind } from "./cloud-sync";
import type { KdfParams } from "./kdf";
import {
  AUDIT_LIMIT,
  type StoredAuditEvent,
  type StoredCredential,
} from "../credentials/types";
import { connection, plain, requestResult, txDone } from "../idb";

const DB_NAME = "coretools-authenticator";
/**
 * v1: entries + meta (Authenticator).
 * v2: + credentials + audit (Credential Manager, sharing the same vault).
 * v3: + snapshots (D-8).
 */
const DB_VERSION = 3;

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

/**
 * A write was refused: the vault changed (in another window, or was read
 * again here) after this change was prepared (D-1). Nothing was written.
 */
export class StaleVaultError extends Error {
  constructor() {
    super("The vault was changed in another window while this was in progress, so nothing was saved. Try again.");
    this.name = "StaleVaultError";
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
  /**
   * When the password was last changed, until the older copies that still
   * open with the previous one were dealt with (S-13).
   */
  passwordChangedAt?: number;
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

/**
 * The settings as stored. The plaintext fields are needed while locked (the
 * idle timer); the security-relevant ones are also sealed under the vault key
 * so that values planted on disk can't weaken an encrypted vault — the sealed
 * copy wins on unlock (see store.svelte.ts).
 */
export interface StoredSettings extends AuthSettings {
  sealed?: EncryptedBlob;
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

/**
 * Cloud backup bookkeeping. No credentials (those live in the OS keychain)
 * and no account address in the clear: the native backend reports it.
 */
export interface CloudConfig {
  /** Random per-install id, tagged on every backup this device uploads. */
  deviceId: string;
  /**
   * SHA-256 of the connected Google account's address (lowercase), or null
   * when disconnected: enough to notice a reconnect with a different account.
   */
  accountHash: string | null;
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

/** Stored by older versions: one series holding everything, and the account address. */
interface LegacyCloudConfig {
  email?: string | null;
  dirty?: boolean;
  lastBackupAt?: number | null;
  lastBackupId?: string | null;
  lastSyncedRemoteId?: string | null;
}

export const DEFAULT_SETTINGS: AuthSettings = {
  autoLockMinutes: 5,
  // On by default: a copied secret shouldn't stay on the clipboard (S-12).
  clipboardClear: true,
  groupCodes: true,
  backupReminderDismissedAt: 0,
  credentialsRevealAuth: true,
};

const db = connection(
  DB_NAME,
  DB_VERSION,
  (database) => {
    // Additive only: existing stores and data are never touched on upgrade.
    for (const [name, options] of [
      ["entries", { keyPath: "id" }],
      ["meta", undefined],
      ["credentials", { keyPath: "id" }],
      ["audit", { keyPath: "id" }],
      ["snapshots", { keyPath: "id" }],
    ] as const) {
      if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, options);
    }
  },
  (error) => (error?.name === "VersionError" ? new NewerDataError() : error),
);

// ---- generation: one writer at a time across windows (D-1) ----------------------

const GENERATION_KEY = "generation";
/** The generation this window's in-memory state matches; null = not tracked (tests, tools). */
let knownGeneration: number | null = null;
let onExternalChange: (() => void) | null = null;
let channel: BroadcastChannel | null = null;
/**
 * Bumped whenever this window reads the vault again (or replaces it whole):
 * a write requested before that is refused, since it was prepared from
 * state that has since been replaced.
 */
let loadEpoch = 0;
/** This window's vault writes and reloads, one at a time, in call order. */
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run);
  queue = result.catch(() => undefined);
  return result;
}

/**
 * Which read of the vault this window's memory reflects. A caller preparing
 * a write from memory checks it hasn't changed before issuing the write.
 */
export function vaultEpoch(): number {
  return loadEpoch;
}

/**
 * Track changes made by other windows: `handler` runs when another window
 * writes, and when a write here is refused as stale. Called once, by the vault.
 */
export function watchExternalChanges(handler: () => void): void {
  onExternalChange = handler;
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel("coretools-vault");
  // Never keep a test runner (Node) alive just for this channel.
  (channel as BroadcastChannel & { unref?: () => void }).unref?.();
  channel.onmessage = (event: MessageEvent<{ generation?: number }>) => {
    const generation = event.data?.generation;
    if (typeof generation === "number" && generation !== knownGeneration) onExternalChange?.();
  };
}

/** Stop watching (tests; the app never does). */
export function unwatchExternalChanges(): void {
  channel?.close();
  channel = null;
  onExternalChange = null;
  knownGeneration = null;
}

/**
 * A write to vault content, in one transaction that also checks and bumps
 * the generation. Queued behind this window's earlier writes; refused
 * (StaleVaultError, nothing written) when this window read the vault again
 * since the call, or when the generation on disk isn't the one it read.
 * `write` queues the caller's requests; it can `fail` the whole transaction.
 * A write that `replaces` the whole vault refuses, in turn, every write
 * queued after it that was requested before.
 */
function vaultWrite(
  stores: string[],
  write: (tx: IDBTransaction, fail: (error: Error) => void) => void,
  replaces = false,
): Promise<void> {
  const epoch = loadEpoch;
  return serialized(async () => {
    if (replaces) loadEpoch++;
    else if (epoch !== loadEpoch) throw new StaleVaultError();
    const database = await db();
    const scope = stores.includes("meta") ? stores : [...stores, "meta"];
    const tx = database.transaction(scope, "readwrite");
    const meta = tx.objectStore("meta");
    const expected = knownGeneration;
    let next = 0;
    let stale = false;
    let failure: Error | null = null;
    const read = meta.get(GENERATION_KEY);
    read.onsuccess = () => {
      const current = typeof read.result === "number" ? read.result : 0;
      if (expected !== null && current !== expected) {
        stale = true;
        tx.abort();
        return;
      }
      next = current + 1;
      meta.put(next, GENERATION_KEY);
    };
    write(tx, (error) => {
      failure = error;
      tx.abort();
    });
    try {
      await txDone(tx);
    } catch (e) {
      if (failure) throw failure;
      if (!stale) throw e;
      onExternalChange?.();
      throw new StaleVaultError();
    }
    if (expected !== null) knownGeneration = next;
    channel?.postMessage({ generation: next });
  });
}

/** Everything a window needs to (re)load the vault, read in one transaction. */
export interface VaultState {
  vault: VaultConfig | undefined;
  settings: StoredSettings;
  entries: StoredEntry[];
}

/**
 * Load the vault and track its generation from here on. Runs after this
 * window's pending writes (so it sees them), and refuses any write requested
 * before it that hasn't run yet.
 */
export function loadVaultState(): Promise<VaultState> {
  return serialized(async () => {
    loadEpoch++;
    const database = await db();
    const tx = database.transaction(["entries", "meta"]);
    const meta = tx.objectStore("meta");
    const [vault, settings, entries, generation] = await Promise.all([
      requestResult(meta.get("vault") as IDBRequest<VaultConfig | undefined>),
      requestResult(meta.get("settings") as IDBRequest<Partial<StoredSettings> | undefined>),
      requestResult(tx.objectStore("entries").getAll() as IDBRequest<StoredEntry[]>),
      requestResult(meta.get(GENERATION_KEY) as IDBRequest<number | undefined>),
    ]);
    knownGeneration = typeof generation === "number" ? generation : 0;
    return {
      vault,
      settings: { ...DEFAULT_SETTINGS, ...settings },
      entries: entries.sort((a, b) => a.index - b.index),
    };
  });
}

export async function loadEntries(): Promise<StoredEntry[]> {
  const database = await db();
  const store = database.transaction("entries").objectStore("entries");
  const all = await requestResult(store.getAll() as IDBRequest<StoredEntry[]>);
  return all.sort((a, b) => a.index - b.index);
}

export function saveEntries(entries: StoredEntry[]): Promise<void> {
  return vaultWrite(["entries"], (tx) => {
    const store = tx.objectStore("entries");
    for (const entry of entries) store.put(plain(entry));
  });
}

/**
 * Delete records and record their deletion (tombstones) in ONE transaction,
 * so a crash between the two can't let a merge bring them back (D-6).
 */
export function deleteWithTombstones(
  ids: { entries?: string[]; credentials?: string[] },
  tombstones: StoredTombstones,
): Promise<void> {
  const stores = [
    ...(ids.entries?.length ? ["entries"] : []),
    ...(ids.credentials?.length ? ["credentials"] : []),
  ];
  return vaultWrite(stores, (tx) => {
    for (const id of ids.entries ?? []) tx.objectStore("entries").delete(id);
    for (const id of ids.credentials ?? []) tx.objectStore("credentials").delete(id);
    tx.objectStore("meta").put(plain(tombstones), "tombstones");
  });
}

/** Put a deleted entry back, with tombstones that no longer list it (Undo). */
export function restoreEntryWithTombstones(
  entry: StoredEntry,
  tombstones: StoredTombstones,
): Promise<void> {
  return vaultWrite(["entries"], (tx) => {
    tx.objectStore("entries").put(plain(entry));
    tx.objectStore("meta").put(plain(tombstones), "tombstones");
  });
}

async function getMeta<T>(key: string): Promise<T | undefined> {
  const database = await db();
  const store = database.transaction("meta").objectStore("meta");
  return requestResult(store.get(key) as IDBRequest<T | undefined>);
}

/** Meta keys that are vault content: generation-checked and snapshotted. */
const VAULT_META_KEYS = [
  "vault",
  "tombstones",
  "auditHead",
  "credentialSpaceOrder",
  "credentialOrder",
] as const;

async function setMeta(key: string, value: unknown): Promise<void> {
  if ((VAULT_META_KEYS as readonly string[]).includes(key)) {
    return vaultWrite(["meta"], (tx) => tx.objectStore("meta").put(plain(value), key));
  }
  // Per-device bookkeeping (settings, cloud backup state): last write wins.
  const database = await db();
  const tx = database.transaction("meta", "readwrite");
  tx.objectStore("meta").put(plain(value), key);
  await txDone(tx);
}

/**
 * Meta keys of the Credential Manager's sealed lists: the space-tab order
 * (it names spaces) and the user's own login order (credential ids).
 */
export const SPACE_ORDER_KEY = "credentialSpaceOrder";
export const CREDENTIAL_ORDER_KEY = "credentialOrder";
export type SealedListKey = typeof SPACE_ORDER_KEY | typeof CREDENTIAL_ORDER_KEY;

/** A JSON array of strings, encrypted under the vault key. */
export interface StoredSealedList {
  sealed: EncryptedBlob;
}

export function loadSealedList(key: SealedListKey): Promise<StoredSealedList | undefined> {
  return getMeta<StoredSealedList>(key);
}

export function saveSealedList(key: SealedListKey, value: StoredSealedList): Promise<void> {
  return setMeta(key, value);
}

export function loadVaultConfig(): Promise<VaultConfig | undefined> {
  return getMeta<VaultConfig>("vault");
}

export function saveVaultConfig(config: VaultConfig): Promise<void> {
  return setMeta("vault", config);
}

export async function loadSettings(): Promise<StoredSettings> {
  const stored = await getMeta<Partial<StoredSettings>>("settings");
  return { ...DEFAULT_SETTINGS, ...stored };
}

/**
 * Save the settings. Generation-checked like vault content, so a window
 * holding older settings can't overwrite a change made in another (N5).
 * `keepSealed`: leave the sealed copy on disk as it is (written while locked,
 * when it can't be sealed again).
 */
export function saveSettings(settings: StoredSettings, keepSealed = false): Promise<void> {
  return vaultWrite(["meta"], (tx) => {
    const meta = tx.objectStore("meta");
    if (!keepSealed) {
      meta.put(plain(settings), "settings");
      return;
    }
    const read = meta.get("settings") as IDBRequest<StoredSettings | undefined>;
    read.onsuccess = () => {
      const sealed = read.result?.sealed;
      const { sealed: _ignored, ...rest } = settings;
      meta.put(plain(sealed ? { ...rest, sealed } : rest), "settings");
    };
  });
}

export async function loadCloudConfig(): Promise<CloudConfig> {
  const stored = await getMeta<Partial<CloudConfig> & LegacyCloudConfig>("cloud");
  return {
    deviceId: stored?.deviceId || crypto.randomUUID(),
    // Older versions stored the address itself; it is replaced by its hash.
    accountHash: stored?.accountHash ?? (stored?.email ? await accountHash(stored.email) : null),
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
    credmanager: { ...EMPTY_SERIES, dirty: !!(stored?.accountHash ?? stored?.email) },
  };
}

export function accountHash(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

export function saveCloudConfig(config: CloudConfig): Promise<void> {
  // Written whole, so a legacy `email` field is dropped with the first save.
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
export function saveVaultAndEntries(
  vault: VaultConfig,
  entries: StoredEntry[],
  extras: VaultWriteExtras = {},
): Promise<void> {
  const { credentials, audit } = extras;
  const stores = ["entries", "meta"];
  if (credentials) stores.push("credentials");
  if (audit) stores.push("audit");
  return vaultWrite(stores, (tx) => {
    const store = tx.objectStore("entries");
    store.clear();
    for (const entry of entries) store.put(plain(entry));
    const meta = tx.objectStore("meta");
    meta.put(plain(vault), "vault");
    for (const [key, value] of Object.entries(extras.meta ?? {})) meta.put(plain(value), key);
    if (audit) {
      const auditStore = tx.objectStore("audit");
      auditStore.clear();
      for (const record of audit.records) auditStore.put(plain(record));
      if (audit.head) meta.put(plain(audit.head), "auditHead");
      else meta.delete("auditHead");
    }
    if (credentials) {
      const credStore = tx.objectStore("credentials");
      credStore.clear();
      for (const credential of credentials) credStore.put(plain(credential));
    }
  });
}

// ---- Credential Manager ---------------------------------------------------------

export async function loadCredentials(): Promise<StoredCredential[]> {
  const database = await db();
  const store = database.transaction("credentials").objectStore("credentials");
  return requestResult(store.getAll() as IDBRequest<StoredCredential[]>);
}

export function saveCredentials(credentials: StoredCredential[]): Promise<void> {
  return vaultWrite(["credentials"], (tx) => {
    const store = tx.objectStore("credentials");
    for (const credential of credentials) store.put(plain(credential));
  });
}

export async function countCredentials(): Promise<number> {
  const database = await db();
  const store = database.transaction("credentials").objectStore("credentials");
  return requestResult(store.count());
}

/**
 * Every stored audit record, oldest first by chain position. Records written
 * before 1.2 are plaintext `{ id, at, action, credentialId, platform }` with
 * no `seq`; a log made only of those is sealed into the chain on unlock.
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
 * oldest record kept). `previous` is the head the events extend: when the
 * head on disk is no longer that one (another window appended meanwhile),
 * nothing is written and StaleVaultError thrown — appending anyway would
 * fork the chain into a false "tampered" report.
 */
export function appendAuditRecords(
  records: StoredAuditEvent[],
  head: StoredAuditHead,
  previous: StoredAuditHead | undefined,
): Promise<void> {
  return vaultWrite(["audit", "meta"], (tx, fail) => {
    const meta = tx.objectStore("meta");
    const current = meta.get("auditHead") as IDBRequest<StoredAuditHead | undefined>;
    current.onsuccess = () => {
      if ((current.result?.sealed.ct ?? null) !== (previous?.sealed.ct ?? null)) {
        fail(new StaleVaultError());
        return;
      }
      const store = tx.objectStore("audit");
      for (const record of records) store.put(plain(record));
      meta.put(plain(head), "auditHead");
      const all = store.getAll() as IDBRequest<StoredAuditEvent[]>;
      all.onsuccess = () => {
        const sorted = all.result.sort((a, b) => (b.seq ?? -1) - (a.seq ?? -1));
        for (const old of sorted.slice(AUDIT_LIMIT)) store.delete(old.id);
      };
    };
  });
}

/** Replace the whole log (migration to the sealed chain). */
export function replaceAuditRecords(
  records: StoredAuditEvent[],
  head: StoredAuditHead | null,
): Promise<void> {
  return vaultWrite(["audit", "meta"], (tx) => {
    const store = tx.objectStore("audit");
    store.clear();
    for (const record of records) store.put(plain(record));
    if (head) tx.objectStore("meta").put(plain(head), "auditHead");
    else tx.objectStore("meta").delete("auditHead");
  });
}

/**
 * Danger zone: delete every entry, credential, audit event and snapshot,
 * the vault config and all settings. Writes this window requested before
 * it and hadn't run yet are refused.
 */
export function wipeAll(): Promise<void> {
  const stores = ["entries", "meta", "credentials", "audit", "snapshots"];
  return vaultWrite(
    stores,
    (tx) => {
      for (const name of stores) tx.objectStore(name).clear();
    },
    true,
  );
}

// ---- local snapshots (D-8) ------------------------------------------------------

/** How many snapshots are kept; the oldest go first. */
export const SNAPSHOT_LIMIT = 5;

export type SnapshotReason =
  | "password-change"
  | "password-removal"
  | "restore"
  | "before-snapshot-restore";

/** The vault exactly as stored (sealed records) at one moment. */
export interface VaultSnapshot {
  id: string;
  at: number;
  reason: SnapshotReason;
  entries: StoredEntry[];
  credentials: StoredCredential[];
  audit: StoredAuditEvent[];
  /** The vault-content meta records (vault config, tombstones, audit head, orders). */
  meta: Record<string, unknown>;
}

export type SnapshotSummary = Pick<VaultSnapshot, "id" | "at" | "reason"> & {
  entries: number;
  credentials: number;
};

/**
 * Copy the vault as stored into a new snapshot, keeping the newest
 * SNAPSHOT_LIMIT — and `keep`, the snapshot about to be restored, whatever
 * its age (NEW-3).
 */
export async function takeSnapshot(reason: SnapshotReason, keep?: string): Promise<void> {
  const database = await db();
  const read = database.transaction(["entries", "credentials", "audit", "meta"]);
  const meta = read.objectStore("meta");
  const [entries, credentials, audit, values] = await Promise.all([
    requestResult(read.objectStore("entries").getAll() as IDBRequest<StoredEntry[]>),
    requestResult(read.objectStore("credentials").getAll() as IDBRequest<StoredCredential[]>),
    requestResult(read.objectStore("audit").getAll() as IDBRequest<StoredAuditEvent[]>),
    Promise.all(VAULT_META_KEYS.map((key) => requestResult(meta.get(key)))),
  ]);
  const snapshot: VaultSnapshot = {
    id: crypto.randomUUID(),
    at: Date.now(),
    reason,
    entries,
    credentials,
    audit,
    meta: Object.fromEntries(
      VAULT_META_KEYS.map((key, i) => [key, values[i]] as const).filter(([, v]) => v !== undefined),
    ),
  };
  const tx = database.transaction("snapshots", "readwrite");
  const store = tx.objectStore("snapshots");
  store.put(snapshot);
  const all = store.getAll() as IDBRequest<VaultSnapshot[]>;
  all.onsuccess = () => {
    const newestFirst = all.result.sort((a, b) => b.at - a.at).filter((s) => s.id !== keep);
    for (const old of newestFirst.slice(keep ? SNAPSHOT_LIMIT - 1 : SNAPSHOT_LIMIT)) {
      store.delete(old.id);
    }
  };
  await txDone(tx);
}

/** The vault configuration a snapshot holds; null when there is no such snapshot. */
export async function loadSnapshotVault(id: string): Promise<VaultConfig | undefined | null> {
  const database = await db();
  const store = database.transaction("snapshots").objectStore("snapshots");
  const snapshot = await requestResult(store.get(id) as IDBRequest<VaultSnapshot | undefined>);
  return snapshot ? (snapshot.meta.vault as VaultConfig | undefined) : null;
}

export interface SnapshotRestoreOptions {
  /** Written with it: the current settings, sealed under the snapshot's key. */
  settings?: StoredSettings;
  /** Drop a Windows Hello configuration that wraps another key than the current one. */
  dropHello?: boolean;
}

export async function listSnapshots(): Promise<SnapshotSummary[]> {
  const database = await db();
  const store = database.transaction("snapshots").objectStore("snapshots");
  const all = await requestResult(store.getAll() as IDBRequest<VaultSnapshot[]>);
  return all
    .sort((a, b) => b.at - a.at)
    .map((s) => ({
      id: s.id,
      at: s.at,
      reason: s.reason,
      entries: s.entries.length,
      credentials: s.credentials.length,
    }));
}

/**
 * Put the vault back exactly as it was in snapshot `id`, in one transaction.
 * Writes this window requested before it and hadn't run yet are refused:
 * they were prepared from the vault being replaced.
 */
export function restoreSnapshot(id: string, options: SnapshotRestoreOptions = {}): Promise<void> {
  const stores = ["entries", "credentials", "audit", "meta", "snapshots"];
  return vaultWrite(stores, (tx, fail) => {
    const get = tx.objectStore("snapshots").get(id) as IDBRequest<VaultSnapshot | undefined>;
    get.onsuccess = () => {
      const snapshot = get.result;
      if (!snapshot) {
        fail(new Error("That snapshot no longer exists."));
        return;
      }
      for (const [name, records] of [
        ["entries", snapshot.entries],
        ["credentials", snapshot.credentials],
        ["audit", snapshot.audit],
      ] as const) {
        const store = tx.objectStore(name);
        store.clear();
        for (const record of records) store.put(record);
      }
      const meta = tx.objectStore("meta");
      for (const key of VAULT_META_KEYS) {
        let value = snapshot.meta[key];
        if (key === "vault" && options.dropHello && value) {
          const { hello: _hello, ...rest } = value as VaultConfig;
          value = rest;
        }
        if (value !== undefined) meta.put(value, key);
        else meta.delete(key);
      }
      if (options.settings) meta.put(plain(options.settings), "settings");
    };
  }, true);
}

/** Delete snapshots taken before `time` (after a password change, S-13). */
export async function deleteSnapshotsBefore(time: number): Promise<number> {
  const database = await db();
  const tx = database.transaction("snapshots", "readwrite");
  const store = tx.objectStore("snapshots");
  let deleted = 0;
  const all = store.getAll() as IDBRequest<VaultSnapshot[]>;
  all.onsuccess = () => {
    for (const s of all.result) {
      if (s.at < time) {
        store.delete(s.id);
        deleted++;
      }
    }
  };
  await txDone(tx);
  return deleted;
}
