import { describe, expect, it } from "vitest";
import { toBase64, toUtf8 } from "./bytes";
import { bytesFromHexOrDump, decodeJwt, describeBytes, detectFormat, hexDump, inspectBase64, jsonStats, parseJsonTree } from "./inspect";
import { DEFAULT_OPTIONS, runTool, type CodecOptions } from "./run";
import { searchTools, TOOLS, toolById } from "./tools";

const b64url = (value: unknown) => toBase64(toUtf8(typeof value === "string" ? value : JSON.stringify(value)), { urlSafe: true });
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const token = (payload: unknown, header: unknown = { alg: "HS256", typ: "JWT" }, signature = "c2ln") =>
  `${b64url(header)}.${b64url(payload)}.${signature}`;

describe("JWT decoder", () => {
  it("reads header, payload and times, without verifying", () => {
    const jwt = decodeJwt(token({ sub: "alex", iat: NOW / 1000 - 3600, exp: NOW / 1000 + 7200 }), NOW);
    expect(jwt.alg).toBe("HS256");
    expect(JSON.parse(jwt.payload!)).toMatchObject({ sub: "alex" });
    expect(jwt.status).toBe("active");
    expect(jwt.times.map((time) => [time.claim, time.relative])).toEqual([
      ["iat", "1 hour ago"],
      ["exp", "in 2 hours"],
    ]);
    expect(jwt.signatureBytes).toBe(3);
  });

  it("flags expired, not-yet-valid and unsigned tokens", () => {
    expect(decodeJwt(token({ exp: NOW / 1000 - 1 }), NOW).status).toBe("expired");
    expect(decodeJwt(token({ nbf: NOW / 1000 + 60 }), NOW).status).toBe("not-yet-valid");
    expect(decodeJwt(token({}), NOW).status).toBe("no-expiry");
    expect(decodeJwt(token({}, { alg: "none" }, ""), NOW).warnings[0]).toMatch(/Unsigned token/);
  });

  it("accepts a Bearer prefix and reads only a JWE's header", () => {
    expect(decodeJwt(`Bearer ${token({ a: 1 })}`, NOW).alg).toBe("HS256");
    const jwe = decodeJwt(`${b64url({ alg: "RSA-OAEP", enc: "A256GCM" })}.a.b.c.d`, NOW);
    expect(jwe.encrypted).toBe(true);
    expect(jwe.payload).toBeNull();
  });

  it("explains what isn't a JWT", () => {
    expect(() => decodeJwt("abc")).toThrow(/three parts/);
    expect(() => decodeJwt(`${b64url("not json")}.e30.x`)).toThrow(/header isn't JSON/);
  });
});

describe("hex dumps", () => {
  it("shows offsets, bytes and characters", () => {
    expect(hexDump(toUtf8("Hello, world!\n"))).toBe("00000000  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 0a        |Hello, world!.|");
  });

  it("reads its own dumps, xxd's, and plain hex back", () => {
    const bytes = toUtf8("The quick brown fox jumps over the lazy dog");
    expect(bytesFromHexOrDump(hexDump(bytes))).toEqual(bytes);
    const xxd = "00000000: 5468 6520 7175 6963 6b20 6272 6f77 6e20  The quick brown \n00000010: 666f 78                                  fox";
    expect(new TextDecoder().decode(bytesFromHexOrDump(xxd))).toBe("The quick brown fox");
    expect(bytesFromHexOrDump("54 68 65")).toEqual(toUtf8("The"));
  });
});

describe("Base64 inspector", () => {
  it("reports variant, padding and content", () => {
    const report = inspectBase64(toBase64(toUtf8('{"a":1}')));
    expect(report).toMatchObject({ variant: "either", padding: "correct", bytes: 7, kind: "JSON text", text: '{"a":1}' });
    expect(inspectBase64("-__-").variant).toBe("URL-safe");
    expect(inspectBase64("Zg").padding).toBe("missing");
  });

  it("recognizes file types", () => {
    expect(describeBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe("PNG image");
    expect(describeBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe("PDF document");
    expect(describeBytes(new Uint8Array([0xff, 0x00, 0xfe]))).toBe("Binary data");
  });

  it("refuses mixed alphabets", () => {
    expect(() => inspectBase64("ab+-")).toThrow(/mixes standard/);
  });
});

describe("format detection", () => {
  it("names what it sees", () => {
    const first = (text: string) => detectFormat(text)[0]?.tool;
    expect(first(token({ sub: "x" }))).toBe("jwt");
    expect(first('{"a": [1, 2]}')).toBe("json-view");
    expect(first("a%20b%3Dc")).toBe("url-decode");
    expect(first("caf\\u00e9")).toBe("unicode-decode");
    expect(first("de ad be ef")).toBe("hex-decode");
    expect(first(toBase64(toUtf8("hello there, base64")))).toBe("base64-decode");
    expect(first("$2b$12$" + "a".repeat(53))).toBe("bcrypt");
    expect(detectFormat("just some words")).toEqual([]);
  });
});

describe("JSON tree", () => {
  it("keeps numbers as written and keys in order", () => {
    const tree = parseJsonTree('{"big": 12345678901234567890, "z": [1, "two", null, false], "a": {}}');
    expect(tree).toEqual({
      kind: "object",
      entries: [
        ["big", { kind: "number", raw: "12345678901234567890" }],
        ["z", { kind: "array", items: [{ kind: "number", raw: "1" }, { kind: "string", value: "two" }, { kind: "null" }, { kind: "boolean", value: false }] }],
        ["a", { kind: "object", entries: [] }],
      ],
    });
    expect(jsonStats(tree)).toEqual({ objects: 2, arrays: 1, values: 5, depth: 3 });
  });

  it("unescapes strings", () => {
    expect(parseJsonTree('"line\\nbreak \\u00e9"')).toEqual({ kind: "string", value: "line\nbreak é" });
  });

  it("refuses absurd nesting instead of overflowing", () => {
    expect(() => parseJsonTree("[".repeat(300) + "]".repeat(300))).toThrow(/too deep/);
  });
});

describe("the tool list", () => {
  it("pairs every swap both ways", () => {
    for (const tool of TOOLS) {
      if (tool.swap) expect(toolById(tool.swap).swap).toBe(tool.id);
    }
    expect(new Set(TOOLS.map((tool) => tool.id)).size).toBe(TOOLS.length);
  });

  it("searches names, summaries and keywords", () => {
    expect(searchTools("base64").map((tool) => tool.id)).toEqual(["base64-encode", "base64-decode", "base64-inspect"]);
    expect(searchTools("token")[0].id).toBe("jwt");
    expect(searchTools("")).toEqual([]);
  });
});

describe("running tools", () => {
  const options = (changes: Partial<CodecOptions> = {}): CodecOptions => ({ ...DEFAULT_OPTIONS, ...changes, iterations: 100_000 });
  const run = async (id: Parameters<typeof runTool>[0], text: string, changes?: Partial<CodecOptions>) =>
    (await runTool(id, { text }, options(changes))).text;

  it("round-trips every encode/decode pair through Swap", async () => {
    const sample = '{"greeting": "Grüße 🚀", "n": 12345678901234567890}';
    for (const [encode, decode] of [
      ["base64-encode", "base64-decode"],
      ["url-encode", "url-decode"],
      ["hex-encode", "hex-decode"],
      ["unicode-encode", "unicode-decode"],
      ["text-to-hex", "hex-to-text"],
    ] as const) {
      expect(await run(decode, await run(encode, sample))).toBe(sample);
    }
    expect(await run("json-format", await run("json-minify", sample))).toBe('{\n  "greeting": "Grüße 🚀",\n  "n": 12345678901234567890\n}');
  });

  it("round-trips AES both ways", async () => {
    const encrypted = await runTool("aes-encrypt", { text: "hello" }, options({ passphrase: "pw" }));
    expect(encrypted.kind === "text" && encrypted.params?.cipher).toBe("AES-256-GCM");
    expect(await run("aes-decrypt", encrypted.text, { passphrase: "pw" })).toBe("hello");
  });

  it("shows binary output as a dump with the bytes to download", async () => {
    const result = await runTool("base64-decode", { text: "/w==" }, options());
    expect(result.kind === "text" && result.binary).toEqual(new Uint8Array([0xff]));
    expect(result.text).toMatch(/^00000000  ff/);
  });

  it("hashes files and refuses files where text is needed", async () => {
    const file = { name: "blob.bin", bytes: new Uint8Array([0, 1, 2]) };
    expect((await runTool("sha256", { text: "", file }, options())).text).toBe("ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc");
    await expect(runTool("url-encode", { text: "", file }, options())).rejects.toThrow(/works on text/);
  });

  it("checks a password against a bcrypt hash", async () => {
    const hash = await run("bcrypt", "hunter22", { bcryptCost: 4 });
    const check = await runTool("bcrypt", { text: "hunter22" }, options({ bcryptHash: hash }));
    expect(check.kind === "text" && check.match).toBe(true);
  });

  it("returns nothing for empty input", async () => {
    expect(await run("sha256", "   ")).toBe("");
  });
});
