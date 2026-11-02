/**
 * Codec's hashes: SHA-256 / SHA-512 (WebCrypto), MD5 and bcrypt (hash-wasm,
 * already used for the vault's Argon2id). All on the device.
 */
import { bcrypt, bcryptVerify, md5 } from "hash-wasm";
import { fromHex, toBase64, toHex, utf8ByteLength } from "./bytes";

export type DigestAlgorithm = "sha256" | "sha512" | "md5";
export type DigestEncoding = "hex" | "HEX" | "base64";

export async function digest(algorithm: DigestAlgorithm, data: Uint8Array): Promise<Uint8Array> {
  if (algorithm === "md5") return fromHex(await md5(data));
  const name = algorithm === "sha256" ? "SHA-256" : "SHA-512";
  return new Uint8Array(await crypto.subtle.digest(name, data as BufferSource));
}

export function encodeDigest(bytes: Uint8Array, encoding: DigestEncoding): string {
  if (encoding === "base64") return toBase64(bytes);
  return toHex(bytes, { upper: encoding === "HEX" });
}

/** bcrypt reads at most this many bytes of its input. */
export const BCRYPT_MAX_BYTES = 72;
/** Cost factors offered: 2^cost rounds. 12 takes a few hundred ms. */
export const BCRYPT_COST = { min: 4, max: 15, default: 12 } as const;

const BCRYPT_HASH = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

/** The cost factor of a bcrypt hash, or null when it isn't one. */
export function bcryptCost(hash: string): number | null {
  const match = BCRYPT_HASH.exec(hash.trim());
  return match ? Number(match[1]) : null;
}

export async function bcryptHash(password: string, cost: number = BCRYPT_COST.default): Promise<string> {
  if (!password) throw new Error("Type the text to hash (usually a password).");
  if (utf8ByteLength(password) > BCRYPT_MAX_BYTES) {
    throw new Error(
      `bcrypt reads only the first ${BCRYPT_MAX_BYTES} bytes, and this is longer — so different inputs would get the same hash. Shorten it, or use SHA-256 for long data.`,
    );
  }
  if (!Number.isInteger(cost) || cost < BCRYPT_COST.min || cost > BCRYPT_COST.max) {
    throw new Error(`The cost factor must be a whole number from ${BCRYPT_COST.min} to ${BCRYPT_COST.max}.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return bcrypt({ password, salt, costFactor: cost, outputType: "encoded" });
}

/** Whether `password` matches a bcrypt hash ($2a$, $2b$ or PHP's $2y$). */
export async function bcryptCheck(password: string, hash: string): Promise<boolean> {
  const trimmed = hash.trim();
  if (!BCRYPT_HASH.test(trimmed)) {
    throw new Error("That isn't a bcrypt hash: it starts with $2a$, $2b$ or $2y$ and is 60 characters long.");
  }
  // hash-wasm reads all three prefixes (it writes $2a$).
  return bcryptVerify({ password, hash: trimmed });
}
