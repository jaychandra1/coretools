/**
 * The app's own at-rest encryption for secrets ("the vault").
 *
 * AES-256-GCM under the vault's data key (see vault-keys.ts for how the
 * password unwraps it; PBKDF2 here only opens vaults from before 1.2). Each
 * value is encrypted with a fresh random 12-byte IV. The key lives only in
 * memory, as a non-extractable CryptoKey, and is dropped on lock.
 *
 * A "verifier" blob (a known sentinel string encrypted at password-set time)
 * lets unlock detect a wrong password without touching any real secret —
 * AES-GCM's authentication tag check does the constant-time comparison.
 */

import { base64ToBytes, bytesToBase64 } from "./legacy-crypto";

export const PBKDF2_ITERATIONS = 310_000;
export const VERIFIER_PLAINTEXT = "coretools-authenticator-v1";

/** One AES-GCM-encrypted string, base64-armored for JSON/IndexedDB. */
export interface EncryptedBlob {
  iv: string;
  ct: string;
  /** 2 = bound to its record and field (see sealField); absent on older blobs. */
  v?: 2;
}

/**
 * Where a record's encrypted field lives. Fields are sealed with this as
 * additional data (audit L2), so someone who can write to the disk can't
 * move a ciphertext to another record or field — a bank password shown
 * under a different login, say — without decryption failing.
 */
export interface FieldBinding {
  kind: "entry" | "credential" | "record";
  id: string;
  field: "secret" | "meta" | "password" | "notes" | "value";
}

/**
 * A single sealed record kept under a meta key (the settings, the deletion
 * records, a saved order): bound to that key, so one can't be swapped for
 * another — the deletion records planted as the settings, say.
 */
export function recordBinding(name: string): FieldBinding {
  return { kind: "record", id: name, field: "value" };
}

function bindingAad(binding: FieldBinding): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(["coretools-field-v2", binding.kind, binding.id, binding.field]),
  );
}

export async function sealField(
  key: CryptoKey,
  plaintext: string,
  binding: FieldBinding,
): Promise<EncryptedBlob> {
  return { ...(await encryptString(key, plaintext, bindingAad(binding))), v: 2 };
}

/**
 * Opens bound fields and, for records written before 1.3, unbound ones.
 * Unbound blobs are re-sealed bound when their record is next written; until
 * then an older unbound blob still opens (accepted residual risk: planting
 * one needs a copy of this vault's own earlier data).
 */
export function openField(key: CryptoKey, blob: EncryptedBlob, binding: FieldBinding): Promise<string> {
  return blob.v === 2 ? decryptString(key, blob, bindingAad(binding)) : decryptString(key, blob);
}

/** Still in the pre-1.3 unbound form: re-sealed on the next unlock. */
export function isUnbound(blob: EncryptedBlob | null | undefined): boolean {
  return !!blob && blob.v !== 2;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function deriveVaultKey(
  password: string,
  saltB64: string,
  iterations = PBKDF2_ITERATIONS,
  /**
   * The working key is always non-extractable. An extractable copy is derived
   * only transiently while enabling OS-biometric unlock, where the raw bytes
   * are wrapped (AES-GCM under a Hello-gated key) and immediately discarded.
   */
  extractable = false,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64ToBytes(saltB64) as BufferSource,
      iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"],
  );
}

/** Export an (extractable) AES key's raw bytes. */
export async function exportKeyBytes(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

/** Re-create the vault key from raw bytes as a non-extractable working key. */
export function importVaultKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Derive a non-extractable AES-256-GCM wrapping key from opaque secret
 * material (the deterministic Windows Hello signature over a fixed random
 * challenge). SHA-256 condenses the material to exactly 256 key bits.
 */
export async function deriveWrappingKey(
  material: Uint8Array,
): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    material as BufferSource,
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Wrap raw vault-key bytes under a wrapping key. */
export async function wrapKeyBytes(
  wrappingKey: CryptoKey,
  raw: Uint8Array,
): Promise<EncryptedBlob> {
  return encryptString(wrappingKey, bytesToBase64(raw));
}

/** Unwrap raw vault-key bytes. Throws if the wrapping key is wrong. */
export async function unwrapKeyBytes(
  wrappingKey: CryptoKey,
  blob: EncryptedBlob,
): Promise<Uint8Array> {
  return base64ToBytes(await decryptString(wrappingKey, blob));
}

function gcmParams(iv: Uint8Array, aad?: Uint8Array): AesGcmParams {
  return aad
    ? { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource }
    : { name: "AES-GCM", iv: iv as BufferSource };
}

/**
 * `aad` (additional authenticated data) is bound into the GCM tag without
 * being encrypted — decryption fails unless the exact same bytes are given.
 */
export async function encryptString(
  key: CryptoKey,
  plaintext: string,
  aad?: Uint8Array,
): Promise<EncryptedBlob> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      gcmParams(iv, aad),
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  return { iv: bytesToBase64(iv), ct: bytesToBase64(ct) };
}

/** Throws when the key is wrong (GCM tag mismatch) or the blob is corrupt. */
export async function decryptString(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad?: Uint8Array,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    gcmParams(base64ToBytes(blob.iv), aad),
    key,
    base64ToBytes(blob.ct) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/** SHA-256 hex digest of a UTF-8 string (used as the backup entry hash). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text) as BufferSource,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
