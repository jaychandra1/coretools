/**
 * The app's own at-rest encryption for secrets ("the vault").
 *
 * PBKDF2-SHA256 (310,000 iterations) derives a non-extractable AES-256-GCM
 * key from the user's encryption password. Each secret is encrypted with a
 * fresh random 12-byte IV; the per-user salt is 16 random bytes. The derived
 * CryptoKey lives only in memory and is dropped on lock.
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
