/**
 * Codec's inspectors: JWT decoding (never verification), hex dumps, Base64
 * reports, format detection and a lossless JSON tree. Pure.
 */
import { fromBase64, fromHex, toHex, utf8OrNull } from "./bytes";
import { reformatJson } from "./text";

// ---- JWT ----------------------------------------------------------------------------

export interface JwtTime {
  claim: "exp" | "nbf" | "iat";
  label: string;
  date: Date;
  relative: string;
}

export interface DecodedJwt {
  /** A JWE (five parts): only its header is readable. */
  encrypted: boolean;
  header: string;
  /** Pretty JSON, or the payload as text when it isn't JSON. */
  payload: string | null;
  alg: string | null;
  signatureBytes: number;
  times: JwtTime[];
  status: "active" | "expired" | "not-yet-valid" | "no-expiry";
  warnings: string[];
}

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function relativeTime(target: number, now: number): string {
  const seconds = Math.round((target - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.trunc(seconds / size), unit);
  }
  return relativeFormat.format(seconds, "second");
}

function decodeSegment(segment: string, what: string): string {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(segment);
  } catch {
    throw new Error(`The ${what} isn't Base64URL.`);
  }
  const text = utf8OrNull(bytes);
  if (text === null) throw new Error(`The ${what} isn't UTF-8 text.`);
  return text;
}

const prettyJson = (text: string) => reformatJson(text, "  ");

export function decodeJwt(token: string, now = Date.now()): DecodedJwt {
  const compact = token.trim().replace(/^Bearer\s+/i, "");
  const parts = compact.split(".");
  if (parts.length !== 3 && parts.length !== 5) {
    throw new Error(`A JWT has three parts separated by dots (header.payload.signature); this has ${parts.length}.`);
  }
  const headerText = decodeSegment(parts[0], "header");
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(headerText);
  } catch {
    throw new Error("The header isn't JSON, so this isn't a JWT.");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error("The header isn't a JSON object.");
  const alg = typeof header.alg === "string" ? header.alg : null;
  const warnings: string[] = [];

  if (parts.length === 5) {
    return { encrypted: true, header: prettyJson(headerText), payload: null, alg, signatureBytes: 0, times: [], status: "no-expiry", warnings };
  }

  const payloadText = decodeSegment(parts[1], "payload");
  let claims: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(payloadText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) claims = parsed;
  } catch {
    // A JWS may carry any payload; show it as text.
  }
  const signatureBytes = parts[2] ? fromBase64(parts[2]).length : 0;
  if (alg?.toLowerCase() === "none" || !parts[2]) warnings.push('Unsigned token (alg "none" or no signature): anyone could have written it.');

  const LABELS = { exp: "Expires", nbf: "Not before", iat: "Issued" } as const;
  const times: JwtTime[] = [];
  for (const claim of ["iat", "nbf", "exp"] as const) {
    const value = claims?.[claim];
    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = value * 1000;
      times.push({ claim, label: LABELS[claim], date: new Date(ms), relative: relativeTime(ms, now) });
    }
  }
  const exp = times.find((time) => time.claim === "exp");
  const nbf = times.find((time) => time.claim === "nbf");
  const status = nbf && nbf.date.getTime() > now ? "not-yet-valid" : exp ? (exp.date.getTime() <= now ? "expired" : "active") : "no-expiry";

  return {
    encrypted: false,
    header: prettyJson(headerText),
    payload: claims ? prettyJson(payloadText) : payloadText,
    alg,
    signatureBytes,
    times,
    status,
    warnings,
  };
}

// ---- hex dump -----------------------------------------------------------------------

/** Bytes shown in a dump before it stops (the rest is summarized). */
export const DUMP_LIMIT = 256 * 1024;

/** `00000000  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 0a        |Hello, world!.|` */
export function hexDump(bytes: Uint8Array, limit = DUMP_LIMIT): string {
  const lines: string[] = [];
  const shown = Math.min(bytes.length, limit);
  for (let offset = 0; offset < shown; offset += 16) {
    const row = bytes.subarray(offset, Math.min(offset + 16, shown));
    let hex = "";
    let text = "";
    for (let i = 0; i < 16; i++) {
      if (i === 8) hex += " ";
      if (i < row.length) {
        hex += toHex(row.subarray(i, i + 1)) + " ";
        text += row[i] >= 0x20 && row[i] < 0x7f ? String.fromCharCode(row[i]) : ".";
      } else hex += "   ";
    }
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex} |${text}|`);
  }
  if (bytes.length > shown) lines.push(`… ${bytes.length - shown} more bytes not shown`);
  return lines.join("\n");
}

const DUMP_LINE = /^[0-9a-f]{4,16}:?\s{1,2}/i;

/**
 * Bytes from hex, or from a hex dump like hexDump's or `xxd`'s: offsets at
 * the start of each line and the character column after "|" (or after two
 * spaces, xxd style) are skipped.
 */
export function bytesFromHexOrDump(text: string): Uint8Array {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("…"));
  if (lines.length && lines.every((line) => DUMP_LINE.test(line))) {
    const hex = lines
      .map((line) => {
        const body = line.replace(DUMP_LINE, "");
        const bar = body.indexOf("|");
        // xxd: hex groups one space apart, then two spaces and the text.
        return bar >= 0 ? body.slice(0, bar) : (/^[0-9a-f]+(?: [0-9a-f]+)*/i.exec(body)?.[0] ?? "");
      })
      .join(" ");
    return fromHex(hex);
  }
  return fromHex(text);
}

// ---- what are these bytes? ----------------------------------------------------------

const MAGIC: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], "PNG image"],
  [[0xff, 0xd8, 0xff], "JPEG image"],
  [[0x47, 0x49, 0x46, 0x38], "GIF image"],
  [[0x25, 0x50, 0x44, 0x46], "PDF document"],
  [[0x50, 0x4b, 0x03, 0x04], "ZIP archive (also .docx, .xlsx, .jar, .apk)"],
  [[0x1f, 0x8b], "gzip data"],
  [[0x00, 0x61, 0x73, 0x6d], "WebAssembly module"],
  [[0x7f, 0x45, 0x4c, 0x46], "ELF executable"],
  [[0x4d, 0x5a], "Windows executable (PE)"],
];

export function describeBytes(bytes: Uint8Array): string {
  if (!bytes.length) return "Empty";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    return "WebP image";
  }
  for (const [signature, kind] of MAGIC) {
    if (signature.every((byte, i) => bytes[i] === byte)) return kind;
  }
  const text = utf8OrNull(bytes);
  if (text === null) return "Binary data";
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "JSON text";
    } catch {
      // Just text.
    }
  }
  return "UTF-8 text";
}

export interface Base64Report {
  variant: "standard" | "URL-safe" | "either";
  padding: "correct" | "missing" | "none needed";
  wrapped: boolean;
  chars: number;
  bytes: number;
  kind: string;
  /** The decoded text when it is UTF-8. */
  text: string | null;
  preview: string;
}

export function inspectBase64(input: string): Base64Report {
  const compact = input.replace(/\s/g, "");
  if (!compact) throw new Error("Paste some Base64 to inspect.");
  const bytes = fromBase64(compact);
  const urlSafe = /[-_]/.test(compact);
  const standard = /[+/]/.test(compact);
  if (urlSafe && standard) throw new Error('This mixes standard ("+", "/") and URL-safe ("-", "_") Base64 characters.');
  const unpadded = compact.replace(/=+$/, "");
  const needsPadding = unpadded.length % 4 !== 0;
  return {
    variant: urlSafe ? "URL-safe" : standard ? "standard" : "either",
    padding: !needsPadding ? "none needed" : compact.length % 4 === 0 ? "correct" : "missing",
    wrapped: /\n/.test(input.trim()),
    chars: compact.length,
    bytes: bytes.length,
    kind: describeBytes(bytes),
    text: utf8OrNull(bytes),
    preview: hexDump(bytes, 256),
  };
}

// ---- format detection ---------------------------------------------------------------

export interface Detection {
  /** Codec tool that handles it. */
  tool: string;
  label: string;
}

/** What `text` most likely is, best guess first (empty when nothing fits). */
export function detectFormat(input: string): Detection[] {
  const text = input.trim();
  if (!text) return [];
  const found: Detection[] = [];
  if (/^(Bearer\s+)?[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/i.test(text)) {
    try {
      decodeJwt(text);
      found.push({ tool: "jwt", label: "JWT" });
    } catch {
      // Dotted, but not a token.
    }
  }
  if (/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(text)) found.push({ tool: "bcrypt", label: "bcrypt hash" });
  if (text.startsWith("aes-256-gcm.pbkdf2-sha256.")) found.push({ tool: "aes-decrypt", label: "AES-256 ciphertext" });
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(text);
      found.push({ tool: "json-view", label: "JSON" });
    } catch {
      // Not JSON after all.
    }
  }
  if (/%[0-9a-f]{2}/i.test(text)) {
    try {
      if (decodeURIComponent(text) !== text) found.push({ tool: "url-decode", label: "URL-encoded text" });
    } catch {
      // Malformed escapes.
    }
  }
  if (/\\u[0-9a-f]{4}|\\u\{[0-9a-f]+\}|&#x?[0-9a-f]+;/i.test(text)) found.push({ tool: "unicode-decode", label: "Unicode escapes" });
  const hexDigits = text.replace(/0x|\\x/gi, "").replace(/[\s:,-]/g, "");
  if (hexDigits.length >= 4 && hexDigits.length % 2 === 0 && /^[0-9a-f]+$/i.test(hexDigits) && /^(0x|\\x)?[0-9a-f\s:,x\\-]+$/i.test(text)) {
    found.push({ tool: "hex-decode", label: "Hex" });
  }
  const compact = text.replace(/\s/g, "");
  if (compact.length >= 8 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) && compact.replace(/=+$/, "").length % 4 !== 1 && !found.length) {
    try {
      const bytes = fromBase64(compact);
      const kind = describeBytes(bytes);
      if (kind !== "Binary data" || compact.length % 4 === 0) {
        found.push({ tool: kind === "UTF-8 text" || kind === "JSON text" ? "base64-decode" : "base64-inspect", label: `Base64 (${kind})` });
      }
    } catch {
      // Not Base64.
    }
  }
  return found;
}

// ---- JSON tree ----------------------------------------------------------------------

export type JsonNode =
  | { kind: "object"; entries: [string, JsonNode][] }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "string"; value: string }
  | { kind: "number"; raw: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" };

/** Deeper documents are shown as text instead of a tree. */
export const TREE_DEPTH_LIMIT = 200;

/**
 * Parse JSON into a tree that keeps numbers as written (no rounding of big
 * integers) and keys in order, duplicates included. Validates with
 * JSON.parse first, so the walk below only meets valid JSON.
 */
export function parseJsonTree(text: string): JsonNode {
  const source = reformatJson(text, null); // validates and strips whitespace
  let i = 0;
  const value = (depth: number): JsonNode => {
    if (depth > TREE_DEPTH_LIMIT) throw new Error(`Nested deeper than ${TREE_DEPTH_LIMIT} levels — too deep to show as a tree.`);
    const char = source[i];
    if (char === "{") {
      i++;
      const entries: [string, JsonNode][] = [];
      while (source[i] !== "}") {
        const key = string();
        i++; // ":"
        entries.push([key, value(depth + 1)]);
        if (source[i] === ",") i++;
      }
      i++;
      return { kind: "object", entries };
    }
    if (char === "[") {
      i++;
      const items: JsonNode[] = [];
      while (source[i] !== "]") {
        items.push(value(depth + 1));
        if (source[i] === ",") i++;
      }
      i++;
      return { kind: "array", items };
    }
    if (char === '"') return { kind: "string", value: string() };
    if (source.startsWith("true", i)) {
      i += 4;
      return { kind: "boolean", value: true };
    }
    if (source.startsWith("false", i)) {
      i += 5;
      return { kind: "boolean", value: false };
    }
    if (source.startsWith("null", i)) {
      i += 4;
      return { kind: "null" };
    }
    const start = i;
    while (i < source.length && !",}]".includes(source[i])) i++;
    return { kind: "number", raw: source.slice(start, i) };
  };
  const string = (): string => {
    const start = i;
    i++;
    while (source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(source.slice(start, i));
  };
  return value(0);
}

export interface JsonStats {
  objects: number;
  arrays: number;
  values: number;
  depth: number;
}

export function jsonStats(node: JsonNode): JsonStats {
  const stats: JsonStats = { objects: 0, arrays: 0, values: 0, depth: 0 };
  const walk = (current: JsonNode, depth: number) => {
    stats.depth = Math.max(stats.depth, depth);
    if (current.kind === "object") {
      stats.objects++;
      for (const [, child] of current.entries) walk(child, depth + 1);
    } else if (current.kind === "array") {
      stats.arrays++;
      for (const child of current.items) walk(child, depth + 1);
    } else stats.values++;
  };
  walk(node, 1);
  return stats;
}
