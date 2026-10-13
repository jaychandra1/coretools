/**
 * The vault's key hierarchy (audit F-06).
 *
 *   password ──KDF (Argon2id)──▶ KEK ──AES-GCM wrap──▶ data key ──▶ secrets
 *
 * The data key is 32 random bytes; it encrypts every secret, the verifier
 * and every backup payload. The password only ever protects the *wrapped*
 * data key, so:
 *  - moving a vault to a stronger KDF re-wraps 32 bytes instead of
 *    re-encrypting every record (and keeps Windows Hello, which wraps the
 *    same data key, working);
 *  - a wrong password fails at the unwrap's GCM tag, before any record is
 *    touched.
 *
 * Vaults made before 1.2 have no wrapped key: their data key IS the PBKDF2
 * output. Those are upgraded on the next password unlock by wrapping that
 * same key under an Argon2id KEK (see AuthStore.unlock).
 */

import { bytesToBase64 } from "./legacy-crypto";
import { DEFAULT_KDF, deriveKeyBytes, type KdfParams } from "./kdf";
import {
  importVaultKey,
  randomBytes,
  unwrapKeyBytes,
  wrapKeyBytes,
  type EncryptedBlob,
} from "./vault-crypto";

/** The stored, password-protected form of a data key. */
export interface WrappedDataKey {
  kdf: KdfParams;
  /** KDF salt, base64 (16 random bytes). */
  salt: string;
  /** The data key's raw bytes, AES-GCM-wrapped under the KEK. */
  wrappedKey: EncryptedBlob;
}

export class WrongPasswordError extends Error {
  constructor() {
    super("Wrong password");
    this.name = "WrongPasswordError";
  }
}

export function generateDataKey(): Uint8Array {
  return randomBytes(32);
}

async function kekFrom(password: string, salt: string, kdf: KdfParams): Promise<CryptoKey> {
  const bytes = await deriveKeyBytes(password, salt, kdf);
  try {
    return await importVaultKey(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** Protect `dataKey` with `password` under a fresh salt. */
export async function wrapDataKey(
  password: string,
  dataKey: Uint8Array,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<WrappedDataKey> {
  const salt = bytesToBase64(randomBytes(16));
  const kek = await kekFrom(password, salt, kdf);
  return { kdf, salt, wrappedKey: await wrapKeyBytes(kek, dataKey) };
}

/** Recover the data key. Throws WrongPasswordError when `password` is wrong. */
export async function unwrapDataKey(
  password: string,
  wrapped: WrappedDataKey,
): Promise<Uint8Array> {
  const kek = await kekFrom(password, wrapped.salt, wrapped.kdf);
  try {
    const raw = await unwrapKeyBytes(kek, wrapped.wrappedKey);
    if (raw.length !== 32) throw new Error("bad key length");
    return raw;
  } catch {
    throw new WrongPasswordError();
  }
}
