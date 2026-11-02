/**
 * Runs a Codec tool on its input. Everything happens here, on the device:
 * no input, option or result is sent, stored or logged.
 */
import {
  decryptWithKey,
  decryptWithPassphrase,
  encryptWithKey,
  encryptWithPassphrase,
  isPassphraseCiphertext,
  PBKDF2_ITERATIONS,
  type AesParameters,
  type CipherEncoding,
  type RawCipher,
} from "./aes";
import { fromBase64, fromHex, fromUtf8Lenient, toBase64, toHex, toUtf8, utf8OrNull } from "./bytes";
import { bcryptCheck, bcryptCost, bcryptHash, BCRYPT_COST, digest, encodeDigest, type DigestEncoding } from "./hash";
import {
  bytesFromHexOrDump,
  decodeJwt,
  describeBytes,
  hexDump,
  inspectBase64,
  jsonStats,
  parseJsonTree,
  type Base64Report,
  type DecodedJwt,
  type JsonNode,
  type JsonStats,
} from "./inspect";
import { minifyJson, reformatJson, unicodeEscape, unicodeUnescape, urlDecode, urlEncode, type UnicodeStyle, type UrlMode } from "./text";
import { toolById, type ToolId } from "./tools";

export interface CodecOptions {
  base64UrlSafe: boolean;
  base64Padding: boolean;
  urlMode: UrlMode;
  urlPlusAsSpace: boolean;
  hexUpper: boolean;
  hexSeparator: "" | " " | ":";
  unicodeStyle: UnicodeStyle;
  unicodeAll: boolean;
  jsonIndent: "2" | "4" | "tab";
  digestEncoding: DigestEncoding;
  bcryptCost: number;
  /** A bcrypt hash to check the input against ("" = make a new hash). */
  bcryptHash: string;
  aesMode: "passphrase" | "key";
  passphrase: string;
  iterations: number;
  aesCipher: RawCipher;
  aesKey: string;
  aesIv: string;
  aesEncoding: CipherEncoding;
}

export const DEFAULT_OPTIONS: CodecOptions = {
  base64UrlSafe: false,
  base64Padding: true,
  urlMode: "component",
  urlPlusAsSpace: false,
  hexUpper: false,
  hexSeparator: "",
  unicodeStyle: "js",
  unicodeAll: false,
  jsonIndent: "2",
  digestEncoding: "hex",
  bcryptCost: BCRYPT_COST.default,
  bcryptHash: "",
  aesMode: "passphrase",
  passphrase: "",
  iterations: PBKDF2_ITERATIONS,
  aesCipher: "gcm",
  aesKey: "",
  aesIv: "",
  aesEncoding: "base64",
};

export interface CodecInput {
  text: string;
  /** A binary file in place of the text (for tools with `bytes`). */
  file?: { name: string; bytes: Uint8Array };
}

/** Every result has `text`: what Copy, Download and Swap use. */
export type CodecResult =
  | {
      kind: "text";
      text: string;
      /** Decoded bytes that aren't text: shown as a dump, downloaded as a file. */
      binary?: Uint8Array;
      note?: string;
      params?: AesParameters;
      /** bcrypt check outcome. */
      match?: boolean;
    }
  | { kind: "jwt"; text: string; jwt: DecodedJwt }
  | { kind: "tree"; text: string; tree: JsonNode; stats: JsonStats }
  | { kind: "base64"; text: string; report: Base64Report };

/** Decoded bytes as text, or as a dump plus the bytes when they aren't text. */
function decoded(bytes: Uint8Array, params?: AesParameters): CodecResult {
  const text = utf8OrNull(bytes);
  if (text !== null) return { kind: "text", text, params };
  return {
    kind: "text",
    text: hexDump(bytes),
    binary: bytes,
    params,
    note: `${bytes.length} bytes of ${describeBytes(bytes).toLowerCase()}, not text — shown as a hex dump. Download saves the bytes as a file.`,
  };
}

const inputBytes = (input: CodecInput) => input.file?.bytes ?? toUtf8(input.text);

export async function runTool(id: ToolId, input: CodecInput, options: CodecOptions): Promise<CodecResult> {
  const tool = toolById(id);
  if (input.file && !tool.bytes) throw new Error(`${tool.name} works on text, and "${input.file.name}" isn't text. Clear it to type instead.`);
  const text = input.text;
  if (!input.file && !text.trim() && id !== "bcrypt") return { kind: "text", text: "" };

  switch (id) {
    case "base64-encode":
      return { kind: "text", text: toBase64(inputBytes(input), { urlSafe: options.base64UrlSafe, padding: options.base64Padding }) };
    case "url-encode":
      return { kind: "text", text: urlEncode(text, options.urlMode) };
    case "hex-encode":
      return { kind: "text", text: toHex(inputBytes(input), { upper: options.hexUpper, separator: options.hexSeparator }) };
    case "unicode-encode":
      return { kind: "text", text: unicodeEscape(text, options.unicodeStyle, options.unicodeAll) };
    case "json-minify":
      return { kind: "text", text: minifyJson(text) };

    case "base64-decode":
      return decoded(fromBase64(text));
    case "url-decode":
      return { kind: "text", text: urlDecode(text, options.urlPlusAsSpace) };
    case "hex-decode":
      return decoded(fromHex(text));
    case "unicode-decode":
      return { kind: "text", text: unicodeUnescape(text) };
    case "json-format":
      return { kind: "text", text: reformatJson(text, options.jsonIndent === "tab" ? "\t" : " ".repeat(Number(options.jsonIndent))) };

    case "sha256":
    case "sha512":
    case "md5":
      return { kind: "text", text: encodeDigest(await digest(id, inputBytes(input)), options.digestEncoding) };

    case "bcrypt": {
      if (options.bcryptHash.trim()) {
        const match = await bcryptCheck(text, options.bcryptHash);
        return {
          kind: "text",
          text: match ? "Match: the text is the password this hash was made from." : "No match: the text isn't the password this hash was made from.",
          match,
          note: `Checked against a cost-${bcryptCost(options.bcryptHash)} hash.`,
        };
      }
      const hash = await bcryptHash(text, options.bcryptCost);
      return {
        kind: "text",
        text: hash,
        note: `Cost ${options.bcryptCost} (2^${options.bcryptCost} rounds) with a random salt, so the hash is different every time — that's expected, and any of them checks out.`,
      };
    }

    case "aes-encrypt": {
      const result =
        options.aesMode === "passphrase"
          ? await encryptWithPassphrase(input.file?.bytes ?? text, options.passphrase, options.iterations)
          : await encryptWithKey(input.file?.bytes ?? text, options.aesKey, options.aesIv, options.aesCipher, options.aesEncoding);
      return { kind: "text", text: result.output, params: result.params };
    }
    case "aes-decrypt": {
      // Passphrase ciphertext names its own format: decrypt it that way whatever the mode says.
      const result =
        options.aesMode === "passphrase" || isPassphraseCiphertext(text)
          ? await decryptWithPassphrase(text, options.passphrase)
          : await decryptWithKey(text, options.aesKey, options.aesIv, options.aesCipher, options.aesEncoding);
      return decoded(result.bytes, result.params);
    }

    case "jwt": {
      const jwt = decodeJwt(text);
      return { kind: "jwt", text: jwt.payload ?? jwt.header, jwt };
    }
    case "json-view": {
      const tree = parseJsonTree(text);
      return { kind: "tree", text: reformatJson(text, "  "), tree, stats: jsonStats(tree) };
    }
    case "text-to-hex":
      return { kind: "text", text: hexDump(inputBytes(input)) };
    case "hex-to-text": {
      const bytes = bytesFromHexOrDump(text);
      const strict = utf8OrNull(bytes);
      return {
        kind: "text",
        text: strict ?? fromUtf8Lenient(bytes),
        note: strict === null ? "Some bytes aren't valid UTF-8; they show as �." : undefined,
      };
    }
    case "base64-inspect": {
      const report = inspectBase64(text);
      return { kind: "base64", text: report.text ?? report.preview, report };
    }
  }
}

/** The text and file name Download saves for a result of `id`. */
export function downloadName(id: ToolId, result: CodecResult): string {
  if (result.kind === "text" && result.binary) return "decoded.bin";
  const names: Partial<Record<ToolId, string>> = {
    "json-minify": "minified.json",
    "json-format": "formatted.json",
    "json-view": "document.json",
    "aes-encrypt": "encrypted.txt",
    "base64-encode": "encoded.b64.txt",
    jwt: "jwt-payload.json",
  };
  return names[id] ?? `${id}.txt`;
}

/** Base64 of decoded bytes, for copying binary output as text. */
export const binaryAsBase64 = (bytes: Uint8Array) => toBase64(bytes);
