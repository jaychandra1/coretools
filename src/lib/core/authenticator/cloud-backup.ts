/**
 * End-to-end encrypted cloud backup envelope ("the cloud file").
 *
 * Each module backs up as its own series of files (see cloud-sync.ts):
 *  - "authenticator": 2FA accounts — secrets AND metadata (issuer, account,
 *    order, pins) — plus display settings;
 *  - "credmanager": Credential Manager logins.
 * The payload is serialized and encrypted as ONE AES-256-GCM blob before it
 * is handed to the transport, and says inside the ciphertext what it holds.
 * The cloud provider only ever stores opaque files; it cannot read account
 * names, let alone secrets. Files written before the split ("combined")
 * hold accounts, settings and — when present — credentials together.
 *
 * Key: the vault's data key (see vault-keys.ts). That is what makes backups
 * automatic — the key is in memory whenever the vault is unlocked, and every
 * change happens while unlocked — and what makes a restore on a brand-new
 * device possible: the header carries what turns the password back into the
 * key. Format v2 (1.2+) carries the Argon2id parameters, salt and the
 * password-wrapped data key; v1 carried PBKDF2 parameters only, the data key
 * being the PBKDF2 output itself. Both are readable; only v2 is written once
 * a vault has been upgraded.
 *
 * Integrity, in layers:
 *  - the cleartext header is bound into the GCM tag as additional
 *    authenticated data, so header fields can't be swapped or edited;
 *  - the vault verifier (a known sentinel under the same key) tells a wrong
 *    password apart from a damaged file;
 *  - the decrypted payload carries an entry count and a SHA-256 digest of
 *    the entry list, checked after decryption.
 */

import type { AuthSettings, VaultConfig } from "./db";
import type { ExportableEntry } from "./backup";
import type { BackupKind } from "./cloud-sync";
import type { BackupCredential } from "../credentials/types";
import { normalizeSpaceName } from "../credentials/spaces";
import { isValidBase32, normalizeBase32 } from "./base32";
import { otpParamsError, type OtpAlgorithm, type OtpType } from "./types";
import {
  decryptString,
  encryptString,
  importVaultKey,
  sha256Hex,
  VERIFIER_PLAINTEXT,
  type EncryptedBlob,
} from "./vault-crypto";
import { deriveKeyBytes, LEGACY_PBKDF2_ITERATIONS, parseKdf, type KdfParams } from "./kdf";
import { unwrapDataKey, WrongPasswordError } from "./vault-keys";

/** Written before 1.2: PBKDF2, the data key is the KDF output. */
export const CLOUD_BACKUP_FORMAT_V1 = "coretools-authenticator-cloud-v1";
/** Written from 1.2: Argon2id KEK + wrapped data key in the header. */
export const CLOUD_BACKUP_FORMAT = "coretools-authenticator-cloud-v2";
export type CloudBackupFormat = typeof CLOUD_BACKUP_FORMAT_V1 | typeof CLOUD_BACKUP_FORMAT;
const FORMAT_FAMILY = "coretools-authenticator-cloud-";
const PAYLOAD_VERSION = 1;

import type { Tombstone } from "./tombstones";
export type { Tombstone } from "./tombstones";

/** Settings worth carrying to a new device (not per-device reminders). */
export type CloudBackupSettings = Pick<
  AuthSettings,
  "autoLockMinutes" | "clipboardClear" | "groupCodes"
>;

export interface CloudBackupDevice {
  /** Random per-install id (not a hardware identifier). */
  id: string;
  /** Human label such as the computer name, shown in the restore picker. */
  label: string;
}

export interface CloudBackupFile {
  format: CloudBackupFormat;
  createdAt: string;
  device: CloudBackupDevice;
  /**
   * How the password becomes a key, plus its salt. v1: PBKDF2 → the data
   * key. v2: Argon2id → the key that unwraps `wrappedKey`.
   */
  kdf: KdfParams & { salt: string };
  /** v2: the data key, AES-GCM-wrapped under the password-derived key. */
  wrappedKey?: EncryptedBlob;
  /** The vault's password verifier — distinguishes wrong password from corruption. */
  verifier: EncryptedBlob;
  cipher: "AES-256-GCM";
  payload: EncryptedBlob;
}

/**
 * What a backup file holds: one series, or "combined" for files written
 * before the series were split (they carry no `contents` field).
 */
export type BackupContents = BackupKind | "combined";

export interface CloudBackupPayload {
  version: typeof PAYLOAD_VERSION;
  contents: BackupContents;
  entryCount: number;
  /** SHA-256 hex of JSON.stringify(entries). */
  digest: string;
  /** 2FA accounts; always empty in a "credmanager" file. */
  entries: ExportableEntry[];
  /** Display settings; null in a "credmanager" file. */
  settings: CloudBackupSettings | null;
  /**
   * Credential Manager records (plaintext — the whole payload is encrypted).
   * Empty in an "authenticator" file and in "combined" files made before the
   * Credential Manager existed.
   */
  credentials: BackupCredential[];
  /**
   * SHA-256 hex of JSON.stringify(credentials), or "" when the file has no
   * opinion about credentials (it must then never replace them).
   */
  credentialsDigest: string;
  /** Deletions of this series' records (empty in files made before 1.2). */
  tombstones: Tombstone[];
  /** App version that wrote the file ("" before 1.2), for diagnostics. */
  writer: string;
}

/**
 * What restoring a set of decrypted files changes. null = leave that part of
 * this device exactly as it is (even in "replace" mode).
 */
export interface RestoreParts {
  entries: ExportableEntry[] | null;
  settings: CloudBackupSettings | null;
  credentials: BackupCredential[] | null;
  /** Deletions recorded with the accounts / credentials restored (F-09). */
  entryTombstones: Tombstone[];
  credentialTombstones: Tombstone[];
}

/**
 * Combine decrypted files (at most one per series) into what to restore.
 * A Credential Manager file wins over credentials inside a legacy combined
 * file; a combined file without credentials leaves credentials alone.
 * With `only`, everything outside that module is left alone — restoring
 * from the Authenticator never touches credentials, and the reverse.
 */
export function restoreParts(payloads: CloudBackupPayload[], only?: BackupKind): RestoreParts {
  const parts: RestoreParts = {
    entries: null,
    settings: null,
    credentials: null,
    entryTombstones: [],
    credentialTombstones: [],
  };
  if (only !== "credmanager") {
    const accounts = payloads.find((p) => p.contents !== "credmanager");
    if (accounts) {
      parts.entries = accounts.entries;
      parts.settings = accounts.settings;
      if (accounts.contents === "authenticator") parts.entryTombstones = accounts.tombstones;
    }
  }
  if (only !== "authenticator") {
    const own = payloads.find((p) => p.contents === "credmanager");
    const legacy = payloads.find((p) => p.contents === "combined" && p.credentialsDigest !== "");
    parts.credentials = (own ?? legacy)?.credentials ?? null;
    if (own) parts.credentialTombstones = own.tombstones;
  }
  return parts;
}

export type CloudBackupErrorCode = "corrupt" | "wrong_password" | "unsupported";

export class CloudBackupError extends Error {
  constructor(
    readonly code: CloudBackupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CloudBackupError";
  }
}

const corrupt = (detail: string) =>
  new CloudBackupError(
    "corrupt",
    `This backup is damaged or was modified (${detail}) and can't be restored.`,
  );

/** The KDF fields in a fixed order (for the AAD). */
function kdfFields(kdf: KdfParams & { salt: string }): unknown[] {
  return kdf.name === "Argon2id"
    ? [kdf.name, kdf.salt, kdf.memoryKiB, kdf.iterations, kdf.parallelism]
    : [kdf.name, kdf.salt, kdf.iterations];
}

/** Canonical bytes of every cleartext header field, in a fixed order. */
function headerAad(file: Omit<CloudBackupFile, "payload">): Uint8Array {
  if (file.format === CLOUD_BACKUP_FORMAT_V1) {
    // Exactly the v1 layout, so files written before 1.2 still verify.
    const kdf = file.kdf as { name: string; salt: string; iterations: number };
    return new TextEncoder().encode(
      JSON.stringify([
        file.format,
        file.createdAt,
        file.device.id,
        file.device.label,
        kdf.name,
        kdf.salt,
        kdf.iterations,
        file.verifier.iv,
        file.verifier.ct,
        file.cipher,
      ]),
    );
  }
  return new TextEncoder().encode(
    JSON.stringify([
      file.format,
      file.createdAt,
      file.device.id,
      file.device.label,
      ...kdfFields(file.kdf),
      file.wrappedKey?.iv ?? "",
      file.wrappedKey?.ct ?? "",
      file.verifier.iv,
      file.verifier.ct,
      file.cipher,
    ]),
  );
}

/** What the header needs to turn the password back into the data key. */
export interface BackupKeyHeader {
  kdf: KdfParams;
  salt: string;
  /** Present for current vaults (→ format v2); absent for legacy PBKDF2 ones (→ v1). */
  wrappedKey?: EncryptedBlob;
}

/** What a backup of this vault needs to turn the password back into its data key. */
export function backupKeyHeader(vault: VaultConfig): BackupKeyHeader {
  if (vault.wrappedKey && vault.kdf && vault.salt) {
    return { kdf: vault.kdf, salt: vault.salt, wrappedKey: vault.wrappedKey };
  }
  return {
    kdf: { name: "PBKDF2-SHA256", iterations: vault.iterations ?? LEGACY_PBKDF2_ITERATIONS },
    salt: vault.salt ?? "",
  };
}

interface SealKey {
  /** The unlocked vault data key. */
  key: CryptoKey;
  keyHeader: BackupKeyHeader;
  verifier: EncryptedBlob;
  device: CloudBackupDevice;
  /** Deletions to carry (F-09). */
  tombstones?: Tombstone[];
  /** App version writing the file. */
  writer?: string;
  createdAt?: Date;
}

export type SealInput = SealKey &
  (
    | { contents: "authenticator"; entries: ExportableEntry[]; settings: CloudBackupSettings }
    | { contents: "credmanager"; credentials: BackupCredential[] }
  );

/** Encrypt one series into a cloud backup file (JSON text). */
export async function sealCloudBackup(input: SealInput): Promise<string> {
  const entries =
    input.contents === "authenticator"
      ? [...input.entries]
          .sort((a, b) => a.index - b.index)
          .map((entry, i) => ({
            type: entry.type,
            issuer: entry.issuer,
            account: entry.account,
            secret: entry.secret,
            algorithm: entry.algorithm,
            digits: entry.digits,
            period: entry.period,
            counter: entry.counter,
            index: i,
            pinned: entry.pinned,
          }))
      : [];
  const head = {
    version: PAYLOAD_VERSION,
    contents: input.contents,
    writer: input.writer ?? "",
    entryCount: entries.length,
    digest: await sha256Hex(JSON.stringify(entries)),
    entries,
    tombstones: (input.tombstones ?? []).map((t) => ({ k: t.k, at: t.at })),
  };

  // An authenticator file carries no credentials fields at all, so older
  // versions of the app read it as "no opinion about credentials" and never
  // clear them when restoring it.
  let payload: Record<string, unknown>;
  if (input.contents === "authenticator") {
    payload = {
      ...head,
      settings: {
        autoLockMinutes: input.settings.autoLockMinutes,
        clipboardClear: input.settings.clipboardClear,
        groupCodes: input.settings.groupCodes,
      },
    };
  } else {
    const credentials = input.credentials.map((c) => ({
      platform: c.platform,
      url: c.url,
      username: c.username,
      password: c.password,
      notes: c.notes,
      category: c.category,
      owner: c.owner,
      tags: [...c.tags],
      space: c.space,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      passwordUpdatedAt: c.passwordUpdatedAt,
      deletedAt: c.deletedAt,
    }));
    payload = {
      ...head,
      credentials,
      credentialsDigest: await sha256Hex(JSON.stringify(credentials)),
    };
  }

  const { kdf, salt, wrappedKey } = input.keyHeader;
  if (!wrappedKey && kdf.name !== "PBKDF2-SHA256") {
    throw new Error("A backup without a wrapped key must use the legacy PBKDF2 layout");
  }
  const header: Omit<CloudBackupFile, "payload"> = {
    format: wrappedKey ? CLOUD_BACKUP_FORMAT : CLOUD_BACKUP_FORMAT_V1,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    device: { id: input.device.id, label: input.device.label },
    kdf: { ...kdf, salt },
    ...(wrappedKey ? { wrappedKey } : {}),
    verifier: input.verifier,
    cipher: "AES-256-GCM",
  };
  const sealed = await encryptString(
    input.key,
    JSON.stringify(payload),
    headerAad(header),
  );
  const file: CloudBackupFile = { ...header, payload: sealed };
  return JSON.stringify(file);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBlob(value: unknown): value is EncryptedBlob {
  const v = value as EncryptedBlob | null;
  return !!v && typeof v === "object" && isString(v.iv) && isString(v.ct);
}

/**
 * Parse and structurally validate a downloaded backup WITHOUT decrypting it.
 * Throws CloudBackupError("corrupt" | "unsupported").
 */
/** Backups are at most 5 MiB when uploaded; anything far larger isn't one (L7). */
const MAX_BACKUP_CHARS = 16 * 1024 * 1024;

export function parseCloudBackup(text: string): CloudBackupFile {
  if (text.length > MAX_BACKUP_CHARS) throw corrupt("too large to be a backup");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw corrupt("not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw corrupt("not a backup object");
  }
  if (raw.format !== CLOUD_BACKUP_FORMAT && raw.format !== CLOUD_BACKUP_FORMAT_V1) {
    if (isString(raw.format) && raw.format.startsWith(FORMAT_FAMILY)) {
      throw new CloudBackupError(
        "unsupported",
        "This backup was made by a newer version of CoreTools. Update the app to restore it.",
      );
    }
    throw corrupt("unknown format");
  }

  const device = raw.device as Record<string, unknown> | null;
  const kdf = raw.kdf as Record<string, unknown> | null;
  if (
    !isString(raw.createdAt) ||
    Number.isNaN(Date.parse(raw.createdAt)) ||
    !device ||
    !isString(device.id) ||
    !isString(device.label) ||
    !kdf ||
    !isString(kdf.salt) ||
    raw.cipher !== "AES-256-GCM" ||
    !isBlob(raw.verifier) ||
    !isBlob(raw.payload)
  ) {
    throw corrupt("missing or malformed header fields");
  }
  const v2 = raw.format === CLOUD_BACKUP_FORMAT;
  if (v2 && !isBlob(raw.wrappedKey)) throw corrupt("missing wrapped key");
  // Bounded parameters: a tampered header can't stall a restore or
  // downgrade to a trivially guessable setting.
  const params = parseKdf(kdf);
  if (!params || (!v2 && params.name !== "PBKDF2-SHA256")) {
    throw corrupt("implausible key-derivation settings");
  }

  return {
    format: v2 ? CLOUD_BACKUP_FORMAT : CLOUD_BACKUP_FORMAT_V1,
    createdAt: raw.createdAt,
    device: { id: device.id, label: device.label },
    kdf: { ...params, salt: kdf.salt },
    ...(v2 && isBlob(raw.wrappedKey)
      ? { wrappedKey: { iv: raw.wrappedKey.iv, ct: raw.wrappedKey.ct } }
      : {}),
    verifier: { iv: raw.verifier.iv, ct: raw.verifier.ct },
    cipher: "AES-256-GCM",
    payload: { iv: raw.payload.iv, ct: raw.payload.ct },
  };
}

/**
 * Derive the key a backup was sealed with from the user's password. A wrong
 * password on a v2 file fails here (the wrapped key won't open); on a v1
 * file it fails at the verifier in openCloudBackup.
 */
export async function deriveBackupKey(
  file: CloudBackupFile,
  password: string,
): Promise<CryptoKey> {
  const { salt, ...kdf } = file.kdf;
  let raw: Uint8Array;
  if (file.wrappedKey) {
    try {
      raw = await unwrapDataKey(password, { kdf: kdf as KdfParams, salt, wrappedKey: file.wrappedKey });
    } catch (e) {
      if (e instanceof WrongPasswordError) throw wrongPassword();
      throw e;
    }
  } else {
    raw = await deriveKeyBytes(password, salt, kdf as KdfParams);
  }
  try {
    return await importVaultKey(raw);
  } finally {
    raw.fill(0);
  }
}

function wrongPassword(): CloudBackupError {
  return new CloudBackupError(
    "wrong_password",
    "Wrong password for this backup. Use the encryption password that was set when it was made.",
  );
}

const OTP_TYPES: ReadonlySet<string> = new Set<OtpType>(["totp", "hotp", "steam", "blizzard"]);
const ALGORITHMS: ReadonlySet<string> = new Set<OtpAlgorithm>(["SHA1", "SHA256", "SHA512"]);

function isCount(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min;
}

function validEntry(value: unknown): ExportableEntry | null {
  const e = value as Record<string, unknown> | null;
  if (!e || typeof e !== "object") return null;
  if (
    !isString(e.type) ||
    !OTP_TYPES.has(e.type) ||
    !isString(e.algorithm) ||
    !ALGORITHMS.has(e.algorithm) ||
    !isString(e.issuer) ||
    !isString(e.account) ||
    !isString(e.secret) ||
    !isValidBase32(e.secret) ||
    !isCount(e.digits, 1) ||
    !isCount(e.period, 1) ||
    !isCount(e.counter) ||
    !isCount(e.index) ||
    typeof e.pinned !== "boolean" ||
    otpParamsError({ digits: e.digits, period: e.period, counter: e.counter }) !== null
  ) {
    return null;
  }
  return {
    type: e.type as OtpType,
    issuer: e.issuer,
    account: e.account,
    secret: normalizeBase32(e.secret),
    algorithm: e.algorithm as OtpAlgorithm,
    digits: e.digits,
    period: e.period,
    counter: e.counter,
    index: e.index,
    pinned: e.pinned,
  };
}

/**
 * Decrypt and verify a backup. Throws CloudBackupError:
 *  - "wrong_password" when the verifier doesn't decrypt under `key`;
 *  - "corrupt" when the verifier is fine but anything else fails.
 */
export async function openCloudBackup(
  file: CloudBackupFile,
  key: CryptoKey,
): Promise<CloudBackupPayload> {
  let sentinel: string;
  try {
    sentinel = await decryptString(key, file.verifier);
  } catch {
    throw wrongPassword();
  }
  if (sentinel !== VERIFIER_PLAINTEXT) throw corrupt("verifier mismatch");

  let json: string;
  try {
    json = await decryptString(key, file.payload, headerAad(file));
  } catch {
    throw corrupt("authentication tag mismatch");
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw corrupt("payload is not JSON");
  }
  if (raw?.version !== PAYLOAD_VERSION || !Array.isArray(raw.entries)) {
    throw corrupt("unexpected payload layout");
  }
  let contents: BackupContents;
  if (raw.contents === undefined) contents = "combined";
  else if (raw.contents === "authenticator" || raw.contents === "credmanager") {
    contents = raw.contents;
  } else throw corrupt("unknown contents");
  if (contents === "credmanager" && raw.entries.length > 0) {
    throw corrupt("accounts inside a Credential Manager backup");
  }
  if (raw.entryCount !== raw.entries.length) throw corrupt("entry count mismatch");
  if (raw.digest !== (await sha256Hex(JSON.stringify(raw.entries)))) {
    throw corrupt("checksum mismatch");
  }

  const entries: ExportableEntry[] = [];
  for (const item of raw.entries) {
    const entry = validEntry(item);
    if (!entry) throw corrupt("invalid account record");
    entries.push(entry);
  }

  const s = (raw.settings ?? {}) as Record<string, unknown>;
  const settings: CloudBackupSettings | null =
    contents === "credmanager"
      ? null
      : {
          autoLockMinutes: isCount(s.autoLockMinutes) ? Math.min(s.autoLockMinutes, 240) : 5,
          clipboardClear: s.clipboardClear === true,
          groupCodes: s.groupCodes !== false,
        };

  // Credentials: required in a Credential Manager file, absent in an
  // authenticator one, optional in legacy combined files (absent in those
  // made before the Credential Manager existed).
  const credentials: BackupCredential[] = [];
  if (contents === "credmanager" && raw.credentials === undefined) {
    throw corrupt("missing credentials");
  }
  const hasCredentials = contents !== "authenticator" && raw.credentials !== undefined;
  if (hasCredentials) {
    if (!Array.isArray(raw.credentials)) throw corrupt("unexpected credentials layout");
    if (raw.credentialsDigest !== (await sha256Hex(JSON.stringify(raw.credentials)))) {
      throw corrupt("credentials checksum mismatch");
    }
    for (const item of raw.credentials) {
      const credential = validCredential(item);
      if (!credential) throw corrupt("invalid credential record");
      credentials.push(credential);
    }
  }

  // Tombstones: absent before 1.2. Only well-formed hashes are honoured.
  const tombstones: Tombstone[] = [];
  if (raw.tombstones !== undefined) {
    if (!Array.isArray(raw.tombstones)) throw corrupt("unexpected tombstones layout");
    for (const item of raw.tombstones) {
      const t = item as Record<string, unknown> | null;
      if (!t || !isString(t.k) || !/^[0-9a-f]{64}$/.test(t.k) || !isTime(t.at)) {
        throw corrupt("invalid tombstone");
      }
      tombstones.push({ k: t.k, at: t.at });
    }
  }

  return {
    version: PAYLOAD_VERSION,
    contents,
    entryCount: entries.length,
    digest: raw.digest as string,
    entries,
    settings,
    credentials,
    credentialsDigest: hasCredentials ? (raw.credentialsDigest as string) : "",
    tombstones,
    writer: isString(raw.writer) ? raw.writer.slice(0, 32) : "",
  };
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validCredential(value: unknown): BackupCredential | null {
  const c = value as Record<string, unknown> | null;
  if (!c || typeof c !== "object") return null;
  if (
    !isString(c.platform) ||
    !c.platform.trim() ||
    !isString(c.url) ||
    !isString(c.username) ||
    !isString(c.password) ||
    !isString(c.notes) ||
    !isString(c.category) ||
    !isString(c.owner) ||
    !Array.isArray(c.tags) ||
    !c.tags.every(isString) ||
    // Absent in backups made before spaces existed.
    !(c.space === undefined || isString(c.space)) ||
    !isTime(c.createdAt) ||
    !isTime(c.updatedAt) ||
    !isTime(c.passwordUpdatedAt) ||
    !(c.deletedAt === null || isTime(c.deletedAt))
  ) {
    return null;
  }
  // Same rule as the editor: only http(s) links are ever stored.
  if (c.url && !/^https?:\/\//i.test(c.url)) return null;
  return {
    platform: c.platform,
    url: c.url,
    username: c.username,
    password: c.password,
    notes: c.notes,
    category: c.category,
    owner: c.owner,
    tags: c.tags as string[],
    space: isString(c.space) ? normalizeSpaceName(c.space) : "",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    passwordUpdatedAt: c.passwordUpdatedAt,
    deletedAt: c.deletedAt as number | null,
  };
}
