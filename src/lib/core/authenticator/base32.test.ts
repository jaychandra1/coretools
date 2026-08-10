import { describe, it, expect } from "vitest";
import {
  base32Decode,
  base32Encode,
  isValidBase32,
  normalizeBase32,
} from "./base32";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("base32 decode (RFC 4648 test vectors)", () => {
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["f", "MY======"],
    ["fo", "MZXQ===="],
    ["foo", "MZXW6==="],
    ["foob", "MZXW6YQ="],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI======"],
  ];

  for (const [plain, encoded] of vectors) {
    if (plain === "") continue; // empty input is rejected by design
    it(`decodes ${encoded} -> "${plain}"`, () => {
      expect(new TextDecoder().decode(base32Decode(encoded))).toBe(plain);
    });
    it(`encodes "${plain}" -> ${encoded}`, () => {
      expect(base32Encode(utf8(plain), true)).toBe(encoded);
    });
  }
});

describe("base32 leniency", () => {
  it("ignores case, spaces and dashes", () => {
    const clean = base32Decode("JBSWY3DPEHPK3PXP");
    expect(base32Decode("jbsw y3dp-ehpk 3pxp")).toEqual(clean);
  });

  it("accepts missing padding", () => {
    expect(new TextDecoder().decode(base32Decode("MZXW6YQ"))).toBe("foob");
  });

  it("rejects invalid characters", () => {
    expect(() => base32Decode("MZXW61")).toThrow(/Invalid Base32/);
    expect(() => base32Decode("")).toThrow(/Empty/);
  });
});

describe("isValidBase32 / normalizeBase32", () => {
  it("normalizes pasted secrets", () => {
    expect(normalizeBase32("jbsw y3dp ehpk 3pxp==")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("validates plausible secrets", () => {
    expect(isValidBase32("JBSWY3DPEHPK3PXP")).toBe(true);
    expect(isValidBase32("jbsw y3dp ehpk 3pxp")).toBe(true);
    expect(isValidBase32("not!base32")).toBe(false);
    expect(isValidBase32("")).toBe(false);
    // 1 char (mod 8) can never occur in valid base32
    expect(isValidBase32("AAAAAAAAA")).toBe(false);
  });
});

describe("base32 round-trip", () => {
  it("round-trips random bytes", () => {
    for (const length of [1, 2, 3, 4, 5, 16, 20, 32, 64]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });
});
