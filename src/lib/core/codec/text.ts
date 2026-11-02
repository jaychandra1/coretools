/**
 * Codec's text transforms: URL encoding, Unicode escapes and JSON
 * minify / format. Pure and synchronous.
 */

// ---- URL ----------------------------------------------------------------------------

/**
 * component: everything but A–Z a–z 0–9 - _ . ! ~ * ' ( ) (encodeURIComponent);
 * uri: keeps the characters that structure a URL (: / ? # & = …);
 * form: application/x-www-form-urlencoded, spaces as "+".
 */
export type UrlMode = "component" | "uri" | "form";

export function urlEncode(text: string, mode: UrlMode = "component"): string {
  if (mode === "uri") return encodeURI(text);
  const encoded = encodeURIComponent(text);
  return mode === "form" ? encoded.replace(/%20/g, "+") : encoded;
}

export function urlDecode(text: string, plusAsSpace = false): string {
  const source = plusAsSpace ? text.replace(/\+/g, " ") : text;
  try {
    return decodeURIComponent(source);
  } catch {
    const lone = /%(?![0-9a-f]{2})/i.exec(source);
    throw new Error(
      lone
        ? `The "%" at character ${lone.index + 1} isn't followed by two hex digits.`
        : "The percent-escapes don't form valid UTF-8 text (a multi-byte character is cut off or wrong).",
    );
  }
}

// ---- Unicode escapes ----------------------------------------------------------------

/**
 * js: \uXXXX (surrogate pairs for emoji), as in JSON and JavaScript;
 * es6: \u{1F600};
 * html: &#x1F600;
 */
export type UnicodeStyle = "js" | "es6" | "html";

export function unicodeEscape(text: string, style: UnicodeStyle = "js", all = false): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (!all && code >= 0x20 && code < 0x7f) {
      out += char;
      continue;
    }
    if (!all && (char === "\n" || char === "\t" || char === "\r")) {
      out += char;
      continue;
    }
    if (style === "html") out += `&#x${code.toString(16).toUpperCase()};`;
    else if (style === "es6") out += `\\u{${code.toString(16).toUpperCase()}}`;
    else {
      for (let i = 0; i < char.length; i++) {
        out += `\\u${char.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
      }
    }
  }
  return out;
}

/** Undo \uXXXX, \u{…}, \xHH, &#xHH; and &#DDD; escapes; other text stays. */
export function unicodeUnescape(text: string): string {
  const fromCode = (code: number, original: string) => {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
      throw new Error(`"${original}" isn't a Unicode code point (the highest is U+10FFFF).`);
    }
    return String.fromCodePoint(code);
  };
  return text
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (match, hex) => fromCode(parseInt(hex, 16), match))
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex) => fromCode(parseInt(hex, 16), match))
    .replace(/&#(\d{1,7});/g, (match, dec) => fromCode(parseInt(dec, 10), match));
}

// ---- JSON ---------------------------------------------------------------------------

/** JSON.parse's error, reworded with the line and column. */
function jsonError(text: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const at = /position (\d+)/.exec(message);
  if (at) {
    const position = Number(at[1]);
    const before = text.slice(0, position).split("\n");
    return new Error(`Invalid JSON at line ${before.length}, column ${before[before.length - 1].length + 1}: ${message.replace(/ in JSON at position \d+.*$/, "")}.`);
  }
  return new Error(`Invalid JSON: ${message}`);
}

/**
 * Re-lay out valid JSON. Works on the text itself rather than a parsed copy,
 * so numbers keep every digit (JSON.parse rounds 12345678901234567890) and
 * keys keep their order and duplicates. `indent` null = minified.
 */
export function reformatJson(text: string, indent: string | null): string {
  const source = text.replace(/^﻿/, "");
  try {
    JSON.parse(source);
  } catch (error) {
    throw jsonError(source, error);
  }
  let out = "";
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      let end = i + 1;
      while (source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
      out += source.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") continue;
    if (indent === null) {
      out += char;
      continue;
    }
    if (char === "{" || char === "[") {
      let next = i + 1;
      while (/\s/.test(source[next] ?? "")) next++;
      if (source[next] === (char === "{" ? "}" : "]")) {
        out += char + source[next];
        i = next;
        continue;
      }
      depth++;
      out += char + "\n" + indent.repeat(depth);
    } else if (char === "}" || char === "]") {
      depth--;
      out += "\n" + indent.repeat(depth) + char;
    } else if (char === ",") {
      out += ",\n" + indent.repeat(depth);
    } else if (char === ":") {
      out += ": ";
    } else {
      out += char;
    }
  }
  return out;
}

export const minifyJson = (text: string) => reformatJson(text, null);
