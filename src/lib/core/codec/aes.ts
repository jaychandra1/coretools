/**
 * Codec's AES-256, with WebCrypto only.
 *
 * Passphrase mode: AES-256-GCM with a key derived by PBKDF2-HMAC-SHA256
 * (600 000 iterations by default, OWASP's figure for that hash), a random
 * 16-byte salt and 12-byte IV per message. The result carries everything
 * needed to decrypt except the passphrase, as dot-separated text:
 *
 *   aes-256-gcm.pbkdf2-sha256.<iterations>.<salt>.<iv>.<ciphertext+tag>
 *
 * (Base64URL parts). GCM's tag makes a wrong passphrase or a changed
 * message fail instead of producing garbage.
 *
 * Raw-key mode: a 256-bit key the user supplies (hex), AES-GCM or AES-CBC
 * (PKCS#7) — CBC matches `openssl enc -aes-256-cbc -K <key> -iv <iv>`.
 */
import { fromBase64, fromHex, toBase64, toHex, toUtf8 } from "./bytes";

export const PBKDF2_ITERATIONS = 600_000;
export const ITERATION_LIMITS = { min: 100_000, max: 10_000_000 } as const;
const PREFIX = "aes-256-gcm.pbkdf2-sha256";
const SALT_BYTES = 16;
const GCM_IV_BYTES = 12;
const CBC_IV_BYTES = 16;

export type RawCipher = "gcm" | "cbc";
export type CipherEncoding = "base64" | "hex";

/** What was used, shown beside the result ("Show encryption parameters"). */
export interface AesParameters {
  cipher: "AES-256-GCM" | "AES-256-CBC";
  keySource: string;
  iterations?: number;
  salt?: string;
  iv: string;
  integrity: string;
  ciphertextBytes: number;
}

export interface AesResult {
  /** Encryption: the ciphertext text. Decryption: the plaintext bytes. */
  output: string;
  bytes: Uint8Array;
  params: AesParameters;
}

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const b64url = (bytes: Uint8Array) => toBase64(bytes, { urlSafe: true });
const asInput = (data: string | Uint8Array) => (typeof data === "string" ? toUtf8(data) : data);

async function passphraseKey(passphrase: string, salt: Uint8Array, iterations: number, usage: KeyUsage) {
  const material = await crypto.subtle.importKey("raw", toUtf8(passphrase) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

function checkIterations(iterations: number) {
  if (!Number.isInteger(iterations) || iterations < ITERATION_LIMITS.min || iterations > ITERATION_LIMITS.max) {
    throw new Error(
      `Iterations must be a whole number from ${ITERATION_LIMITS.min.toLocaleString("en")} to ${ITERATION_LIMITS.max.toLocaleString("en")}.`,
    );
  }
}

export async function encryptWithPassphrase(
  plaintext: string | Uint8Array,
  passphrase: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<AesResult> {
  if (!passphrase) throw new Error("Enter a passphrase.");
  checkIterations(iterations);
  const salt = random(SALT_BYTES);
  const iv = random(GCM_IV_BYTES);
  const key = await passphraseKey(passphrase, salt, iterations, "encrypt");
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, asInput(plaintext) as BufferSource),
  );
  return {
    output: [PREFIX, iterations, b64url(salt), b64url(iv), b64url(ciphertext)].join("."),
    bytes: ciphertext,
    params: {
      cipher: "AES-256-GCM",
      keySource: "PBKDF2-HMAC-SHA256 from your passphrase",
      iterations,
      salt: toHex(salt),
      iv: toHex(iv),
      integrity: "128-bit GCM tag",
      ciphertextBytes: ciphertext.length,
    },
  };
}

/** Whether `text` looks like passphrase-mode output. */
export const isPassphraseCiphertext = (text: string) => text.trim().startsWith(`${PREFIX}.`);

export async function decryptWithPassphrase(text: string, passphrase: string): Promise<AesResult> {
  if (!passphrase) throw new Error("Enter the passphrase it was encrypted with.");
  const parts = text.trim().split(".");
  if (parts.length !== 6 || `${parts[0]}.${parts[1]}` !== PREFIX) {
    throw new Error(`This isn't passphrase ciphertext (that starts with "${PREFIX}."). For a key and IV, choose "Raw key".`);
  }
  const iterations = Number(parts[2]);
  checkIterations(iterations);
  const salt = fromBase64(parts[3]);
  const iv = fromBase64(parts[4]);
  const ciphertext = fromBase64(parts[5]);
  if (salt.length !== SALT_BYTES || iv.length !== GCM_IV_BYTES || ciphertext.length < 16) {
    throw new Error("This ciphertext is incomplete or damaged.");
  }
  const key = await passphraseKey(passphrase, salt, iterations, "decrypt");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
  } catch {
    throw new Error("Wrong passphrase, or the ciphertext was changed — the integrity check failed.");
  }
  const bytes = new Uint8Array(plain);
  return {
    output: "",
    bytes,
    params: {
      cipher: "AES-256-GCM",
      keySource: "PBKDF2-HMAC-SHA256 from your passphrase",
      iterations,
      salt: toHex(salt),
      iv: toHex(iv),
      integrity: "128-bit GCM tag — verified",
      ciphertextBytes: ciphertext.length,
    },
  };
}

// ---- raw key ------------------------------------------------------------------------

/** A random 256-bit key, as hex. */
export const generateKeyHex = () => toHex(random(32));

function rawKey(keyHex: string): Uint8Array {
  if (!keyHex.trim()) throw new Error("Enter a 256-bit key (64 hex digits), or generate one.");
  const key = fromHex(keyHex);
  if (key.length !== 32) throw new Error(`An AES-256 key is 32 bytes (64 hex digits); this one is ${key.length} bytes.`);
  return key;
}

function rawIv(ivHex: string, cipher: RawCipher): Uint8Array {
  const iv = fromHex(ivHex);
  const want = cipher === "gcm" ? GCM_IV_BYTES : CBC_IV_BYTES;
  if (iv.length !== want) {
    throw new Error(`The IV for AES-${cipher.toUpperCase()} is ${want} bytes (${want * 2} hex digits); this one is ${iv.length} bytes.`);
  }
  return iv;
}

const algorithm = (cipher: RawCipher, iv: Uint8Array) =>
  cipher === "gcm" ? { name: "AES-GCM", iv: iv as BufferSource } : { name: "AES-CBC", iv: iv as BufferSource };

async function importRaw(key: Uint8Array, cipher: RawCipher, usage: KeyUsage) {
  return crypto.subtle.importKey("raw", key as BufferSource, cipher === "gcm" ? "AES-GCM" : "AES-CBC", false, [usage]);
}

const rawParams = (cipher: RawCipher, iv: Uint8Array, bytes: number, verified = false): AesParameters => ({
  cipher: cipher === "gcm" ? "AES-256-GCM" : "AES-256-CBC",
  keySource: "Your 256-bit key",
  iv: toHex(iv),
  integrity: cipher === "gcm" ? `128-bit GCM tag${verified ? " — verified" : ""}` : "None (CBC has no integrity check)",
  ciphertextBytes: bytes,
});

/** Encrypt with a raw key. An empty IV gets a random one (shown in the parameters). */
export async function encryptWithKey(
  plaintext: string | Uint8Array,
  keyHex: string,
  ivHex: string,
  cipher: RawCipher,
  encoding: CipherEncoding,
): Promise<AesResult> {
  const key = rawKey(keyHex);
  const iv = ivHex.trim() ? rawIv(ivHex, cipher) : random(cipher === "gcm" ? GCM_IV_BYTES : CBC_IV_BYTES);
  const cryptoKey = await importRaw(key, cipher, "encrypt");
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(algorithm(cipher, iv), cryptoKey, asInput(plaintext) as BufferSource));
  return {
    output: encoding === "hex" ? toHex(ciphertext) : toBase64(ciphertext),
    bytes: ciphertext,
    params: rawParams(cipher, iv, ciphertext.length),
  };
}

export async function decryptWithKey(
  text: string,
  keyHex: string,
  ivHex: string,
  cipher: RawCipher,
  encoding: CipherEncoding,
): Promise<AesResult> {
  const key = rawKey(keyHex);
  if (!ivHex.trim()) throw new Error("Enter the IV the data was encrypted with.");
  const iv = rawIv(ivHex, cipher);
  const ciphertext = encoding === "hex" ? fromHex(text) : fromBase64(text);
  const cryptoKey = await importRaw(key, cipher, "decrypt");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(algorithm(cipher, iv), cryptoKey, ciphertext as BufferSource);
  } catch {
    throw new Error(
      cipher === "gcm"
        ? "Wrong key or IV, or the ciphertext was changed — the integrity check failed."
        : "Wrong key or IV, or this isn't AES-256-CBC data — its padding doesn't check out.",
    );
  }
  return { output: "", bytes: new Uint8Array(plain), params: rawParams(cipher, iv, ciphertext.length, true) };
}
