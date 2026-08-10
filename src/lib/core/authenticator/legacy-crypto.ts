/**
 * OpenSSL/CryptoJS-compatible secret encryption, for round-tripping with the
 * Authenticator browser extension's encrypted backups.
 *
 * `CryptoJS.AES.encrypt(plaintext, password).toString()` produces base64 of
 * `"Salted__" + 8-byte salt + AES-256-CBC ciphertext`, with key+IV derived
 * via OpenSSL EVP_BytesToKey (MD5, one round). This module reproduces that
 * exact format using Web Crypto for the AES part.
 *
 * This scheme is weak by modern standards and exists purely for backup
 * compatibility — imported secrets are re-encrypted with the AES-GCM vault.
 */

import { md5 } from "./md5";

const SALTED_PREFIX = [0x53, 0x61, 0x6c, 0x74, 0x65, 0x64, 0x5f, 0x5f]; // "Salted__"

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** OpenSSL EVP_BytesToKey with MD5, 1 iteration → AES-256 key + 16-byte IV. */
function evpBytesToKey(
  password: Uint8Array,
  salt: Uint8Array,
): { key: Uint8Array; iv: Uint8Array } {
  const blocks: Uint8Array[] = [];
  let previous: Uint8Array = new Uint8Array(0);
  let total = 0;
  while (total < 48) {
    previous = md5(concat(previous, password, salt));
    blocks.push(previous);
    total += previous.length;
  }
  const material = concat(...blocks);
  return { key: material.slice(0, 32), iv: material.slice(32, 48) };
}

async function importCbcKey(
  keyBytes: Uint8Array,
  usage: KeyUsage,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "AES-CBC" },
    false,
    [usage],
  );
}

/**
 * Decrypt one CryptoJS `AES.encrypt(secret, password).toString()` blob.
 * Throws when the password is wrong (bad padding) or the format is invalid.
 */
export async function decryptLegacySecret(
  encryptedB64: string,
  password: string,
): Promise<string> {
  const raw = base64ToBytes(encryptedB64);
  if (
    raw.length < 17 ||
    !SALTED_PREFIX.every((byte, i) => raw[i] === byte)
  ) {
    throw new Error("Not an OpenSSL/CryptoJS encrypted blob");
  }
  const salt = raw.slice(8, 16);
  const ciphertext = raw.slice(16);

  const { key, iv } = evpBytesToKey(new TextEncoder().encode(password), salt);
  const cbcKey = await importCbcKey(key, "decrypt");

  let plainBytes: ArrayBuffer;
  try {
    plainBytes = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: iv as BufferSource },
      cbcKey,
      ciphertext as BufferSource,
    );
  } catch {
    throw new Error("Wrong password (decryption failed)");
  }

  const text = new TextDecoder().decode(plainBytes);
  // A wrong password can occasionally still pass CBC padding checks; the
  // plaintext of a real backup is always printable ASCII (a Base32 secret).
  if (text.length === 0 || !/^[\x20-\x7e]+$/.test(text)) {
    throw new Error("Wrong password (decryption produced garbage)");
  }
  return text;
}

/** Encrypt in the exact CryptoJS/OpenSSL format the extension understands. */
export async function encryptLegacySecret(
  plaintext: string,
  password: string,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const { key, iv } = evpBytesToKey(new TextEncoder().encode(password), salt);
  const cbcKey = await importCbcKey(key, "encrypt");

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: iv as BufferSource },
      cbcKey,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );

  return bytesToBase64(
    concat(new Uint8Array(SALTED_PREFIX), salt, ciphertext),
  );
}
