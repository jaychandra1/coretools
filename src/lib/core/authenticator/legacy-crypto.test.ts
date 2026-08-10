import { describe, it, expect } from "vitest";
import { createCipheriv, createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { md5 } from "./md5";
import {
  decryptLegacySecret,
  encryptLegacySecret,
  base64ToBytes,
  bytesToBase64,
} from "./legacy-crypto";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("md5", () => {
  const vectors: Array<[string, string]> = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["The quick brown fox jumps over the lazy dog", "9e107d9d372bb6826bd81d3542a419d6"],
    // > 64 bytes exercises multi-block processing
    ["a".repeat(100), "36a92cc94a9e0fa21f625f8bfb007adf"],
  ];

  for (const [input, digest] of vectors) {
    it(`md5("${input.slice(0, 20)}${input.length > 20 ? "…" : ""}")`, () => {
      expect(hex(md5(utf8(input)))).toBe(digest);
    });
  }

  it("matches node:crypto for random inputs", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 200]) {
      const input = new Uint8Array(nodeRandomBytes(length));
      const expected = createHash("md5").update(input).digest("hex");
      expect(hex(md5(input))).toBe(expected);
    }
  });
});

/**
 * Independent reference implementation of CryptoJS
 * `AES.encrypt(plaintext, password).toString()` built on node:crypto:
 * EVP_BytesToKey (MD5) → AES-256-CBC → base64("Salted__" + salt + ct).
 */
function cryptoJsCompatibleEncrypt(plaintext: string, password: string): string {
  const salt = nodeRandomBytes(8);
  const pass = Buffer.from(password, "utf8");

  let material = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (material.length < 48) {
    block = createHash("md5")
      .update(Buffer.concat([block, pass, salt]))
      .digest();
    material = Buffer.concat([material, block]);
  }
  const key = material.subarray(0, 32);
  const iv = material.subarray(32, 48);

  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__"), salt, ct]).toString("base64");
}

describe("legacy (CryptoJS/OpenSSL) secret encryption", () => {
  it("decrypts blobs produced by an independent OpenSSL-compatible implementation", async () => {
    const blob = cryptoJsCompatibleEncrypt("JBSWY3DPEHPK3PXP", "hunter2");
    expect(await decryptLegacySecret(blob, "hunter2")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("round-trips its own output", async () => {
    const blob = await encryptLegacySecret("MZXW6YTBOI", "correct horse");
    expect(blob.length).toBeGreaterThan(0);
    expect(await decryptLegacySecret(blob, "correct horse")).toBe("MZXW6YTBOI");
  });

  it("its output starts with the OpenSSL Salted__ header", async () => {
    const blob = await encryptLegacySecret("JBSWY3DPEHPK3PXP", "pw");
    const raw = base64ToBytes(blob);
    expect(new TextDecoder().decode(raw.slice(0, 8))).toBe("Salted__");
  });

  it("rejects a wrong password", async () => {
    const blob = await encryptLegacySecret("JBSWY3DPEHPK3PXP", "right");
    await expect(decryptLegacySecret(blob, "wrong")).rejects.toThrow(/password/i);
  });

  it("rejects garbage input", async () => {
    await expect(decryptLegacySecret("bm90IHNhbHRlZA==", "pw")).rejects.toThrow(
      /encrypted blob/i,
    );
  });
});

describe("base64 helpers", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array(nodeRandomBytes(37));
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
