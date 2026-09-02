import { describe, it, expect } from "vitest";
import {
  escapeJsonString,
  formatJson,
  minifyJson,
  offsetToLineColumn,
  parseJson,
  sortKeysDeep,
  unescapeJsonString,
  utf8Size,
} from "./parse";

describe("parseJson", () => {
  it("parses valid JSON", () => {
    const result = parseJson('{"a": [1, 2, null], "b": "x"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: [1, 2, null], b: "x" });
  });

  it("reports empty input", () => {
    const result = parseJson("  \n ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/empty/i);
  });

  it("locates a syntax error by line and column", () => {
    const result = parseJson('{\n  "a": 1,\n  "b": ,\n}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.line).toBe(3);
      expect(result.error.column).toBeGreaterThanOrEqual(7);
    }
  });
});

describe("offsetToLineColumn", () => {
  it("maps offsets across newlines", () => {
    const text = "ab\ncd\nef";
    expect(offsetToLineColumn(text, 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToLineColumn(text, 3)).toEqual({ line: 2, column: 1 });
    expect(offsetToLineColumn(text, 7)).toEqual({ line: 3, column: 2 });
  });
});

describe("formatting", () => {
  it("formats with a chosen indent", () => {
    expect(formatJson('{"a":1}', 4)).toBe('{\n    "a": 1\n}');
    expect(formatJson('{"a":1}', "\t")).toBe('{\n\t"a": 1\n}');
  });

  it("minifies", () => {
    expect(minifyJson('{\n  "a": [1, 2]\n}')).toBe('{"a":[1,2]}');
  });

  it("sorts keys recursively, leaving arrays alone", () => {
    expect(sortKeysDeep({ b: { d: 1, c: 2 }, a: [3, { z: 1, y: 2 }] })).toEqual({
      a: [3, { y: 2, z: 1 }],
      b: { c: 2, d: 1 },
    });
  });
});

describe("string helpers", () => {
  it("computes UTF-8 sizes", () => {
    expect(utf8Size("abc")).toBe(3);
    expect(utf8Size("é")).toBe(2);
    expect(utf8Size("🙂")).toBe(4);
  });

  it("escapes and unescapes round-trip", () => {
    const raw = 'He said "hi"\n\ttab';
    expect(unescapeJsonString(escapeJsonString(raw))).toBe(raw);
  });
});
