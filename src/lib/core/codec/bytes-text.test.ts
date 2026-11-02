import { describe, expect, it } from "vitest";
import { charCount, formatBytes, fromBase64, fromHex, toBase64, toHex, toUtf8, utf8ByteLength, utf8OrNull } from "./bytes";
import { minifyJson, reformatJson, unicodeEscape, unicodeUnescape, urlDecode, urlEncode } from "./text";

describe("UTF-8 sizes", () => {
  it("counts bytes like an encoder, without encoding", () => {
    for (const text of ["", "abc", "é", "€", "😀", "a😀b€", "\ud83d"]) {
      expect(utf8ByteLength(text)).toBe(toUtf8(text).length);
    }
  });

  it("counts an emoji as one character", () => {
    expect(charCount("a😀b")).toBe(3);
    expect("a😀b".length).toBe(4);
  });

  it("formats sizes", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.00 MB");
  });

  it("tells UTF-8 from other bytes", () => {
    expect(utf8OrNull(toUtf8("héllo"))).toBe("héllo");
    expect(utf8OrNull(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

describe("hex", () => {
  it("encodes with case and separators", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(toHex(bytes)).toBe("deadbeef");
    expect(toHex(bytes, { upper: true, separator: ":" })).toBe("DE:AD:BE:EF");
  });

  it("decodes what people paste", () => {
    for (const text of ["deadbeef", "DE AD BE EF", "de:ad:be:ef", "0xde 0xad 0xbe 0xef", "\\xde\\xad\\xbe\\xef", "de-ad\nbe,ef"]) {
      expect(Array.from(fromHex(text))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    }
  });

  it("explains bad hex", () => {
    expect(() => fromHex("abc")).toThrow(/one digit is left over/);
    expect(() => fromHex("zz")).toThrow(/"z" isn't a hex digit/);
  });
});

describe("Base64", () => {
  // RFC 4648 §10 test vectors.
  const vectors: [string, string][] = [
    ["", ""],
    ["f", "Zg=="],
    ["fo", "Zm8="],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg=="],
    ["fooba", "Zm9vYmE="],
    ["foobar", "Zm9vYmFy"],
  ];

  it("matches RFC 4648", () => {
    for (const [plain, encoded] of vectors) {
      expect(toBase64(toUtf8(plain))).toBe(encoded);
      expect(new TextDecoder().decode(fromBase64(encoded))).toBe(plain);
    }
  });

  it("does URL-safe, with or without padding", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
    expect(toBase64(bytes)).toBe("+//+");
    expect(toBase64(bytes, { urlSafe: true })).toBe("-__-");
    expect(toBase64(toUtf8("f"), { urlSafe: true })).toBe("Zg");
    expect(toBase64(toUtf8("f"), { urlSafe: true, padding: true })).toBe("Zg==");
  });

  it("decodes any variant, padded or not, wrapped or not", () => {
    for (const text of ["+//+", "-__-", "Zm9vYg", "Zm9v\nYg==", " Zm9vYg== "]) {
      expect(() => fromBase64(text)).not.toThrow();
    }
    expect(new TextDecoder().decode(fromBase64("Zm9vYg"))).toBe("foob");
  });

  it("round-trips large binary data", () => {
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i += 65_536) crypto.getRandomValues(bytes.subarray(i, i + 65_536));
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("explains bad Base64", () => {
    expect(() => fromBase64("Zm9v!")).toThrow(/"!" isn't a Base64 character/);
    expect(() => fromBase64("Zm9vY")).toThrow(/one character off/);
  });
});

describe("URL encoding", () => {
  it("encodes a component, a whole URL, or a form value", () => {
    expect(urlEncode("a b&c=d/é")).toBe("a%20b%26c%3Dd%2F%C3%A9");
    expect(urlEncode("https://x.dev/a b?q=1&r=é", "uri")).toBe("https://x.dev/a%20b?q=1&r=%C3%A9");
    expect(urlEncode("a b+c", "form")).toBe("a+b%2Bc");
  });

  it("decodes, optionally reading + as a space", () => {
    expect(urlDecode("a%20b%26c%3Dd%2F%C3%A9")).toBe("a b&c=d/é");
    expect(urlDecode("a+b%2Bc", true)).toBe("a b+c");
    expect(urlDecode("a+b")).toBe("a+b");
  });

  it("points at a broken escape", () => {
    expect(() => urlDecode("100%")).toThrow(/character 4 isn't followed by two hex digits/);
    expect(() => urlDecode("%E2%82")).toThrow(/don't form valid UTF-8/);
  });
});

describe("Unicode escapes", () => {
  it("escapes non-ASCII in each style and leaves ASCII alone", () => {
    expect(unicodeEscape("café 😀")).toBe("caf\\u00E9 \\uD83D\\uDE00");
    expect(unicodeEscape("café 😀", "es6")).toBe("caf\\u{E9} \\u{1F600}");
    expect(unicodeEscape("café 😀", "html")).toBe("caf&#xE9; &#x1F600;");
  });

  it("can escape every character", () => {
    expect(unicodeEscape("Hi", "js", true)).toBe("\\u0048\\u0069");
  });

  it("unescapes every form, round-tripping emoji", () => {
    expect(unicodeUnescape("caf\\u00E9 \\uD83D\\uDE00")).toBe("café 😀");
    expect(unicodeUnescape("\\u{1F600} &#x1F600; &#128512; \\x41")).toBe("😀 😀 😀 A");
    for (const style of ["js", "es6", "html"] as const) {
      expect(unicodeUnescape(unicodeEscape("Grüße 🚀 日本", style))).toBe("Grüße 🚀 日本");
    }
  });

  it("refuses code points past U+10FFFF", () => {
    expect(() => unicodeUnescape("&#x110000;")).toThrow(/U\+10FFFF/);
  });
});

describe("JSON layout", () => {
  it("formats and minifies", () => {
    expect(reformatJson('{"a":1,"b":[true,null,{"c":"x"}],"d":{}}', "  ")).toBe(
      '{\n  "a": 1,\n  "b": [\n    true,\n    null,\n    {\n      "c": "x"\n    }\n  ],\n  "d": {}\n}',
    );
    expect(minifyJson('{\n  "a" : [ 1, 2 ],\n  "b" : "x y"\n}')).toBe('{"a":[1,2],"b":"x y"}');
  });

  it("keeps big numbers, key order and duplicates exactly as written", () => {
    const text = '{"id": 12345678901234567890, "z": 1, "a": 2, "z": 3, "f": 1.10}';
    expect(minifyJson(text)).toBe('{"id":12345678901234567890,"z":1,"a":2,"z":3,"f":1.10}');
    expect(JSON.stringify(JSON.parse(text))).not.toContain("12345678901234567890");
  });

  it("leaves strings untouched, escapes included", () => {
    const text = '{"s": "a , b : { } [ ] \\" \\\\ \\n"}';
    expect(minifyJson(text)).toBe('{"s":"a , b : { } [ ] \\" \\\\ \\n"}');
    expect(JSON.parse(reformatJson(text, "\t"))).toEqual(JSON.parse(text));
  });

  it("explains invalid JSON with a line and column", () => {
    expect(() => reformatJson('{\n  "a": 1,\n  "b": }', "  ")).toThrow(/Invalid JSON/);
  });

  it("accepts a byte order mark", () => {
    expect(minifyJson('﻿{"a": 1}')).toBe('{"a":1}');
  });
});
