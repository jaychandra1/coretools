/**
 * JSON parsing with editor-addressable error positions, plus formatting
 * helpers. `JSON.parse` is the only parser used — no eval, no custom grammar.
 */

import type { JsonValue, ParseResult } from "./types";

/** Convert a 0-based character offset to 1-based line/column. */
export function offsetToLineColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

/**
 * Extract the failure offset from a JSON.parse error message, best effort.
 * Message shapes seen across V8/JSC/SpiderMonkey versions:
 *  - "... at position 42 (line 3 column 7)"
 *  - "... at position 42"
 *  - "Unexpected token ',', ...\"<snippet>\" is not valid JSON" where the
 *    snippet is the source sliced from 10 characters before the failure.
 */
function errorOffset(message: string, text: string): number {
  const position = /at position (\d+)/.exec(message);
  if (position) return Math.min(Number(position[1]), text.length);

  const lineCol = /line (\d+) column (\d+)/.exec(message);
  if (lineCol) {
    const line = Number(lineCol[1]);
    const column = Number(lineCol[2]);
    let offset = 0;
    let current = 1;
    while (current < line) {
      const nl = text.indexOf("\n", offset);
      if (nl < 0) break;
      offset = nl + 1;
      current++;
    }
    return Math.min(offset + column - 1, text.length);
  }

  // Context-snippet format. With a leading "…" the snippet starts exactly 10
  // characters before the failure; without one it starts at the beginning.
  const token = /Unexpected token '(.)'/.exec(message)?.[1];
  const truncated = /\.\.\."([\s\S]+)" is not valid JSON/.exec(message);
  if (truncated) {
    const index = text.indexOf(truncated[1]);
    if (index >= 0) return Math.min(index + 10, text.length);
  }
  const fromStart = /^[^"]*"([\s\S]+)" is not valid JSON/.exec(message);
  if (fromStart) {
    const index = text.indexOf(fromStart[1]);
    if (index >= 0) {
      if (token) {
        const relative = fromStart[1].indexOf(token);
        if (relative >= 0) return index + relative;
      }
      return index;
    }
  }
  return 0;
}

/** Parse JSON text into a value or a positioned error. */
export function parseJson(text: string): ParseResult {
  if (text.trim() === "") {
    return {
      ok: false,
      error: { message: "Document is empty", line: 1, column: 1, position: 0 },
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const position = errorOffset(message, text);
    const { line, column } = offsetToLineColumn(text, position);
    return {
      ok: false,
      error: { message, line, column, position },
    };
  }
}

/** Pretty-print. Throws only if `text` is invalid JSON — parse first. */
export function formatJson(text: string, indent: number | "\t" = 2): string {
  return JSON.stringify(JSON.parse(text), null, indent);
}

/** Minify (single line, no insignificant whitespace). */
export function minifyJson(text: string): string {
  return JSON.stringify(JSON.parse(text));
}

/** Recursively sort object keys (arrays keep their order). */
export function sortKeysDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/** UTF-8 byte size of a string (what a saved file would occupy). */
export function utf8Size(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Escape a JSON string for embedding (without surrounding quotes). */
export function escapeJsonString(raw: string): string {
  return JSON.stringify(raw).slice(1, -1);
}

/** Best-effort unescape of a JSON string literal body. */
export function unescapeJsonString(escaped: string): string {
  try {
    return JSON.parse(`"${escaped}"`) as string;
  } catch {
    return escaped;
  }
}
