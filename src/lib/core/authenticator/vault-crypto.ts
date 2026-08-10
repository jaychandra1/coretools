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
    false, // non-extractable: the raw key bytes are never exposed to JS
    ["encrypt", "decrypt"],
  );
}

export async function encryptString(
  key: CryptoKey,
  plaintext: string,
): Promise<EncryptedBlob> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
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
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(blob.iv) as BufferSource },
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
