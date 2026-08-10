/**
 * Base32 (RFC 4648) encode/decode.
 *
 * Decoding is lenient the way OTP tools need it to be: whitespace and dashes
 * are stripped, case is ignored and trailing padding is optional — secrets
 * are frequently pasted as "jbsw y3dp ehpk 3pxp".
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const CHAR_TO_VALUE = new Map<string, number>(
  [...ALPHABET].map((c, i) => [c, i]),
);

/** Strip whitespace/dashes, uppercase, drop trailing '=' padding. */
export function normalizeBase32(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase().replace(/=+$/, "");
}

/** True when the (normalized) input is non-empty, well-formed Base32. */
export function isValidBase32(input: string): boolean {
  const s = normalizeBase32(input);
  if (s.length === 0) return false;
  if (!/^[A-Z2-7]+$/.test(s)) return false;
  // Lengths of 1, 3 or 6 chars (mod 8) cannot occur in valid Base32.
  const rem = s.length % 8;
  return rem !== 1 && rem !== 3 && rem !== 6;
}

/** Decode Base32 text to bytes. Throws on malformed input. */
export function base32Decode(input: string): Uint8Array {
  const s = normalizeBase32(input);
  if (s.length === 0) throw new Error("Empty Base32 input");

  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let bits = 0;
  let buffer = 0;
  let index = 0;

  for (const char of s) {
    const value = CHAR_TO_VALUE.get(char);
    if (value === undefined) {
      throw new Error(`Invalid Base32 character: "${char}"`);
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >>> bits) & 0xff;
    }
  }
  return out;
}

/** Encode bytes as Base32. Padding is added only when `pad` is true. */
export function base32Encode(bytes: Uint8Array, pad = false): string {
  let out = "";
  let bits = 0;
  let buffer = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  if (pad) {
    while (out.length % 8 !== 0) out += "=";
  }
  return out;
}
