/**
 * End-to-end encrypted cloud backup envelope ("the cloud file").
 *
 * The whole vault — secrets AND metadata (issuer, account, order, pins) plus
 * display settings — is serialized and encrypted as ONE AES-256-GCM blob
 * before it is handed to the transport. The cloud provider only ever stores
 * this opaque file; it cannot read account names, let alone secrets.
 *
 * Key: the vault key itself (PBKDF2-SHA256 of the encryption password with
 * the vault's salt). That is what makes backups automatic — the key is in
 * memory whenever the vault is unlocked, and every change happens while
 * unlocked — and what makes a restore on a brand-new device possible: the
 * user re-enters the same password, the KDF parameters travel in the header.
 *
 * Integrity, in layers:
 *  - the cleartext header is bound into the GCM tag as additional
 *    authenticated data, so header fields can't be swapped or edited;
 *  - the vault verifier (a known sentinel under the same key) tells a wrong
 *    password apart from a damaged file;
 *  - the decrypted payload carries an entry count and a SHA-256 digest of
 *    the entry list, checked after decryption.
 */

import type { AuthSettings } from "./db";
import type { ExportableEntry } from "./backup";
import { isValidBase32, normalizeBase32 } from "./base32";
import type { OtpAlgorithm, OtpType } from "./types";
import {
  decryptString,
  deriveVaultKey,
  encryptString,
  sha256Hex,
  VERIFIER_PLAINTEXT,
  type EncryptedBlob,
} from "./vault-crypto";

export const CLOUD_BACKUP_FORMAT = "coretools-authenticator-cloud-v1";
const FORMAT_FAMILY = "coretools-authenticator-cloud-";
const PAYLOAD_VERSION = 1;

/**
 * Bounds on the KDF work factor accepted from a downloaded file. A tampered
 * header must not be able to make restore spin for minutes (DoS) or accept
 * a trivially brute-forceable setting.
 */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 5_000_000;

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
  format: typeof CLOUD_BACKUP_FORMAT;
  createdAt: string;
  device: CloudBackupDevice;
  kdf: { name: "PBKDF2-SHA256"; salt: string; iterations: number };
  /** The vault's password verifier — distinguishes wrong password from corruption. */
  verifier: EncryptedBlob;
  cipher: "AES-256-GCM";
  payload: EncryptedBlob;
}

export interface CloudBackupPayload {
  version: typeof PAYLOAD_VERSION;
  entryCount: number;
  /** SHA-256 hex of JSON.stringify(entries). */
  digest: string;
  entries: ExportableEntry[];
  settings: CloudBackupSettings;
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

/** Canonical bytes of every cleartext header field, in a fixed order. */
function headerAad(file: Omit<CloudBackupFile, "payload">): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      file.format,
      file.createdAt,
      file.device.id,
      file.device.label,
      file.kdf.name,
      file.kdf.salt,
      file.kdf.iterations,
      file.verifier.iv,
      file.verifier.ct,
      file.cipher,
    ]),
  );
}

export interface SealInput {
  /** The unlocked vault key. */
  key: CryptoKey;
  salt: string;
  iterations: number;
  verifier: EncryptedBlob;
  device: CloudBackupDevice;
  entries: ExportableEntry[];
  settings: CloudBackupSettings;
  createdAt?: Date;
}

/** Encrypt the vault into a cloud backup file (JSON text). */
export async function sealCloudBackup(input: SealInput): Promise<string> {
  const entries = [...input.entries]
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
    }));
  const payload: CloudBackupPayload = {
    version: PAYLOAD_VERSION,
    entryCount: entries.length,
    digest: await sha256Hex(JSON.stringify(entries)),
    entries,
    settings: {
      autoLockMinutes: input.settings.autoLockMinutes,
      clipboardClear: input.settings.clipboardClear,
      groupCodes: input.settings.groupCodes,
    },
  };

  const header: Omit<CloudBackupFile, "payload"> = {
    format: CLOUD_BACKUP_FORMAT,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    device: { id: input.device.id, label: input.device.label },
    kdf: { name: "PBKDF2-SHA256", salt: input.salt, iterations: input.iterations },
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
export function parseCloudBackup(text: string): CloudBackupFile {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw corrupt("not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw corrupt("not a backup object");
  }
  if (raw.format !== CLOUD_BACKUP_FORMAT) {
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
    kdf.name !== "PBKDF2-SHA256" ||
    !isString(kdf.salt) ||
    raw.cipher !== "AES-256-GCM" ||
    !isBlob(raw.verifier) ||
    !isBlob(raw.payload)
  ) {
    throw corrupt("missing or malformed header fields");
  }
  const iterations = kdf.iterations;
  if (
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < MIN_ITERATIONS ||
    iterations > MAX_ITERATIONS
  ) {
    throw corrupt("implausible key-derivation settings");
  }

  return {
    format: CLOUD_BACKUP_FORMAT,
    createdAt: raw.createdAt,
    device: { id: device.id, label: device.label },
    kdf: { name: "PBKDF2-SHA256", salt: kdf.salt, iterations },
    verifier: { iv: raw.verifier.iv, ct: raw.verifier.ct },
    cipher: "AES-256-GCM",
    payload: { iv: raw.payload.iv, ct: raw.payload.ct },
  };
}

/** Derive the key a backup was sealed with from the user's password. */
export function deriveBackupKey(
  file: CloudBackupFile,
  password: string,
): Promise<CryptoKey> {
  return deriveVaultKey(password, file.kdf.salt, file.kdf.iterations);
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
    typeof e.pinned !== "boolean"
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
    throw new CloudBackupError(
      "wrong_password",
      "Wrong password for this backup. Use the encryption password that was set when it was made.",
    );
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
  const settings: CloudBackupSettings = {
    autoLockMinutes: isCount(s.autoLockMinutes) ? Math.min(s.autoLockMinutes, 240) : 5,
    clipboardClear: s.clipboardClear === true,
    groupCodes: s.groupCodes !== false,
  };

  return {
    version: PAYLOAD_VERSION,
    entryCount: entries.length,
    digest: raw.digest as string,
    entries,
    settings,
  };
}
