/**
 * OTP code generation: HOTP (RFC 4226), TOTP (RFC 6238) and the Steam Guard
 * and Blizzard/Battle.net variants.
 *
 * HMAC comes from the Web Crypto API (`crypto.subtle`) — never hand-rolled.
 * Everything here is pure computation; no storage, no I/O.
 */

import { base32Decode } from "./base32";
import type { OtpAlgorithm, OtpParams } from "./types";

const SUBTLE_HASH: Record<OtpAlgorithm, string> = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA512: "SHA-512",
};

/** Steam Guard's custom code alphabet. */
export const STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY";

async function hmac(
  algorithm: OtpAlgorithm,
  keyBytes: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: SUBTLE_HASH[algorithm] },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, message as BufferSource);
  return new Uint8Array(sig);
}

/** 8-byte big-endian counter block used by both HOTP and TOTP. */
function counterBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  // Counters fit comfortably in 2^53; write as two 32-bit halves.
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  return buf;
}

/** RFC 4226 dynamic truncation → 31-bit integer. */
function truncate(digest: Uint8Array): number {
  const offset = digest[digest.length - 1] & 0x0f;
  return (
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3]
  );
}

/** HOTP (RFC 4226) for a raw key. */
export async function hotpRaw(
  keyBytes: Uint8Array,
  counter: number,
  digits = 6,
  algorithm: OtpAlgorithm = "SHA1",
): Promise<string> {
  const digest = await hmac(algorithm, keyBytes, counterBytes(counter));
  const code = truncate(digest) % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

/** HOTP for a Base32 secret. */
export function hotp(
  secret: string,
  counter: number,
  digits = 6,
  algorithm: OtpAlgorithm = "SHA1",
): Promise<string> {
  return hotpRaw(base32Decode(secret), counter, digits, algorithm);
}

/** TOTP (RFC 6238) at a given Unix time (milliseconds). */
export function totp(
  secret: string,
  timeMs: number,
  period = 30,
  digits = 6,
  algorithm: OtpAlgorithm = "SHA1",
): Promise<string> {
  const counter = Math.floor(timeMs / 1000 / period);
  return hotp(secret, counter, digits, algorithm);
}

/** Steam Guard: 5 characters from Steam's alphabet, SHA-1, 30 s period. */
export async function steamCode(
  secret: string,
  timeMs: number,
): Promise<string> {
  const counter = Math.floor(timeMs / 1000 / 30);
  const digest = await hmac("SHA1", base32Decode(secret), counterBytes(counter));
  let value = truncate(digest);
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += STEAM_ALPHABET[value % STEAM_ALPHABET.length];
    value = Math.floor(value / STEAM_ALPHABET.length);
  }
  return code;
}

/** Seconds remaining in the current period at `timeMs`. */
export function secondsRemaining(timeMs: number, period: number): number {
  const seconds = timeMs / 1000;
  return period - (seconds % period);
}

/**
 * Generate the current code for an entry-shaped set of parameters.
 * Dispatches to the right variant; the caller supplies the wall clock so
 * every visible code can tick from one shared timer.
 */
export function generateCode(
  params: OtpParams,
  timeMs: number,
): Promise<string> {
  switch (params.type) {
    case "hotp":
      return hotp(params.secret, params.counter, params.digits, params.algorithm);
    case "steam":
      return steamCode(params.secret, timeMs);
    case "blizzard":
      // Battle.net authenticator: 8-digit TOTP, SHA-1, 30 s.
      return totp(params.secret, timeMs, 30, 8, "SHA1");
    case "totp":
      return totp(params.secret, timeMs, params.period, params.digits, params.algorithm);
  }
}

/** Group a code for display: "123456" → "123 456". Steam codes stay as-is. */
export function groupCode(code: string): string {
  if (code.length === 6 || code.length === 8) {
    const half = code.length / 2;
    return `${code.slice(0, half)} ${code.slice(half)}`;
  }
  if (code.length === 7) return `${code.slice(0, 3)} ${code.slice(3)}`;
  return code;
}
