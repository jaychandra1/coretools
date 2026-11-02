/**
 * Codec's tools: names, tabs, search, and the encode ↔ decode pairs that
 * "Swap" moves between.
 */

export type TabId = "encode" | "decode" | "hash" | "encrypt" | "inspect";

export const TABS: { id: TabId; label: string }[] = [
  { id: "encode", label: "Encode" },
  { id: "decode", label: "Decode" },
  { id: "hash", label: "Hash" },
  { id: "encrypt", label: "Encrypt" },
  { id: "inspect", label: "Inspect" },
];

export type ToolId =
  | "base64-encode"
  | "url-encode"
  | "hex-encode"
  | "unicode-encode"
  | "json-minify"
  | "base64-decode"
  | "url-decode"
  | "hex-decode"
  | "unicode-decode"
  | "json-format"
  | "sha256"
  | "sha512"
  | "md5"
  | "bcrypt"
  | "aes-encrypt"
  | "aes-decrypt"
  | "jwt"
  | "json-view"
  | "text-to-hex"
  | "hex-to-text"
  | "base64-inspect";

export interface ToolDef {
  id: ToolId;
  tab: TabId;
  name: string;
  summary: string;
  /** Runs as you type. Otherwise on its button (Ctrl+Enter): slow or randomized work. */
  live: boolean;
  /** The opposite tool: Swap feeds this tool's output to it. */
  swap?: ToolId;
  /** Also takes a binary file's bytes (dropped or opened). */
  bytes?: boolean;
  /** Extra words for search. */
  keywords: string;
}

export const TOOLS: ToolDef[] = [
  { id: "base64-encode", tab: "encode", name: "Base64 Encoder", summary: "Text or a file to Base64, standard or URL-safe.", live: true, swap: "base64-decode", bytes: true, keywords: "b64 btoa mime" },
  { id: "url-encode", tab: "encode", name: "URL Encoder", summary: "Percent-encode text for URLs, query strings and forms.", live: true, swap: "url-decode", keywords: "percent uri query escape" },
  { id: "hex-encode", tab: "encode", name: "Hex Encoder", summary: "Text or a file to hexadecimal bytes.", live: true, swap: "hex-decode", bytes: true, keywords: "hexadecimal base16 bytes" },
  { id: "unicode-encode", tab: "encode", name: "Unicode Encoder", summary: "Escape characters as \\uXXXX, \\u{…} or &#x…;.", live: true, swap: "unicode-decode", keywords: "escape emoji utf-16 html entity" },
  { id: "json-minify", tab: "encode", name: "JSON Minifier", summary: "Strip the whitespace from JSON. Numbers and key order stay exactly as written.", live: true, swap: "json-format", keywords: "compact compress minify" },

  { id: "base64-decode", tab: "decode", name: "Base64 Decoder", summary: "Base64 (standard or URL-safe) back to text, or to a file.", live: true, swap: "base64-encode", keywords: "b64 atob mime" },
  { id: "url-decode", tab: "decode", name: "URL Decoder", summary: "Undo percent-encoding.", live: true, swap: "url-encode", keywords: "percent uri query unescape" },
  { id: "hex-decode", tab: "decode", name: "Hex Decoder", summary: "Hexadecimal bytes back to text, or to a file.", live: true, swap: "hex-encode", keywords: "hexadecimal base16 bytes" },
  { id: "unicode-decode", tab: "decode", name: "Unicode Decoder", summary: "Turn \\uXXXX, \\u{…}, \\xHH and &#…; escapes back into characters.", live: true, swap: "unicode-encode", keywords: "unescape emoji utf-16 html entity" },
  { id: "json-format", tab: "decode", name: "JSON Formatter", summary: "Validate and pretty-print JSON.", live: true, swap: "json-minify", keywords: "beautify pretty indent validate" },

  { id: "sha256", tab: "hash", name: "SHA-256", summary: "SHA-256 digest of text or a file.", live: true, bytes: true, keywords: "sha2 checksum digest" },
  { id: "sha512", tab: "hash", name: "SHA-512", summary: "SHA-512 digest of text or a file.", live: true, bytes: true, keywords: "sha2 checksum digest" },
  { id: "md5", tab: "hash", name: "MD5", summary: "MD5 checksum, for compatibility only: MD5 is broken for security.", live: true, bytes: true, keywords: "checksum legacy" },
  { id: "bcrypt", tab: "hash", name: "bcrypt", summary: "Hash a password with bcrypt, or check a password against a bcrypt hash.", live: false, keywords: "password hash verify" },

  { id: "aes-encrypt", tab: "encrypt", name: "AES-256 Encrypt", summary: "Encrypt with a passphrase (AES-256-GCM) or your own 256-bit key.", live: false, swap: "aes-decrypt", bytes: true, keywords: "encryption cipher gcm cbc pbkdf2 password" },
  { id: "aes-decrypt", tab: "encrypt", name: "AES-256 Decrypt", summary: "Decrypt passphrase ciphertext, or data encrypted with a key and IV.", live: false, swap: "aes-encrypt", keywords: "decryption cipher gcm cbc pbkdf2 password" },

  { id: "jwt", tab: "inspect", name: "JWT Decoder", summary: "Read a JWT's header and payload. The signature is NOT verified.", live: true, keywords: "token bearer jws jwe oauth claims" },
  { id: "json-view", tab: "inspect", name: "JSON Viewer", summary: "Browse JSON as a collapsible tree.", live: true, keywords: "tree explore browse" },
  { id: "text-to-hex", tab: "inspect", name: "Text to Hex", summary: "A hex dump of text or a file: offsets, bytes and characters.", live: true, swap: "hex-to-text", bytes: true, keywords: "dump xxd bytes" },
  { id: "hex-to-text", tab: "inspect", name: "Hex to Text", summary: "Read hex, or a hex dump, as text.", live: true, swap: "text-to-hex", keywords: "dump xxd bytes" },
  { id: "base64-inspect", tab: "inspect", name: "Base64 Inspector", summary: "What Base64 holds: variant, padding, size and file type.", live: true, keywords: "analyze magic file type" },
];

const BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]));

export const toolById = (id: ToolId): ToolDef => BY_ID.get(id)!;
export const isToolId = (id: unknown): id is ToolId => typeof id === "string" && BY_ID.has(id as ToolId);
export const toolsInTab = (tab: TabId) => TOOLS.filter((tool) => tool.tab === tab);

/** Tools matching every word of `query` (name, summary, tab or keywords). */
export function searchTools(query: string): ToolDef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return TOOLS.filter((tool) => {
    const haystack = `${tool.name} ${tool.summary} ${tool.tab} ${tool.keywords}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
