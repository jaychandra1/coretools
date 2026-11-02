/**
 * Codec's byte layer: UTF-8, hex and Base64 conversions shared by every
 * tool. Pure and synchronous; nothing here touches the network or storage.
 */

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const lenientDecoder = new TextDecoder("utf-8");

export const toUtf8 = (text: string): Uint8Array => encoder.encode(text);

/** The bytes as UTF-8 text, or null when they aren't valid UTF-8. */
export function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/** The bytes as UTF-8 text, with U+FFFD where they aren't valid UTF-8. */
export const fromUtf8Lenient = (bytes: Uint8Array): string => lenientDecoder.decode(bytes);

/** UTF-8 size of `text` in bytes, counted without encoding it. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3; // lone surrogate: encoded as U+FFFD
    } else bytes += 3;
  }
  return bytes;
}

/** Characters as people count them (code points, so an emoji is one). */
export function charCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/** "1.2 KB" style sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---- hex ----------------------------------------------------------------------------

export interface HexOptions {
  upper?: boolean;
  /** Between bytes: "" (default), " " or ":". */
  separator?: string;
}

const HEX_DIGITS = "0123456789abcdef";

export function toHex(bytes: Uint8Array, { upper = false, separator = "" }: HexOptions = {}): string {
  const parts: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    parts[i] = HEX_DIGITS[bytes[i] >> 4] + HEX_DIGITS[bytes[i] & 15];
  }
  const hex = parts.join(separator);
  return upper ? hex.toUpperCase() : hex;
}

/**
 * Hex to bytes. Accepts what people paste: upper or lower case, whitespace,
 * ":" "-" "," between bytes, and 0x / \x prefixes.
 */
export function fromHex(text: string): Uint8Array {
  const digits = text
    .trim()
    .replace(/0x|\\x/gi, "")
    .replace(/[\s:,-]/g, "");
  if (!/^[0-9a-f]*$/i.test(digits)) {
    const bad = digits.match(/[^0-9a-f]/i)?.[0] ?? "";
    throw new Error(`"${bad}" isn't a hex digit (0–9, a–f).`);
  }
  if (digits.length % 2) throw new Error("Hex needs two digits per byte — one digit is left over.");
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(digits.substr(i * 2, 2), 16);
  return bytes;
}

// ---- Base64 -------------------------------------------------------------------------

export interface Base64Options {
  /** RFC 4648 §5: "-" and "_" instead of "+" and "/". */
  urlSafe?: boolean;
  /** Keep the "=" padding (default: yes for standard, no for URL-safe). */
  padding?: boolean;
}

export function toBase64(bytes: Uint8Array, { urlSafe = false, padding = !urlSafe }: Base64Options = {}): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  let encoded = btoa(binary);
  if (urlSafe) encoded = encoded.replace(/\+/g, "-").replace(/\//g, "_");
  if (!padding) encoded = encoded.replace(/=+$/, "");
  return encoded;
}

/**
 * Base64 to bytes, standard or URL-safe, padded or not, ignoring whitespace
 * and line breaks (MIME-wrapped input).
 */
export function fromBase64(text: string): Uint8Array {
  const compact = text.replace(/\s/g, "");
  const bad = compact.replace(/=+$/, "").match(/[^A-Za-z0-9+/_-]/);
  if (bad) throw new Error(`"${bad[0]}" isn't a Base64 character.`);
  const standard = compact.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (standard.length % 4 === 1) throw new Error("This isn't complete Base64: its length is one character off.");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Concatenate byte arrays. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
