import { describe, expect, it } from "vitest";
import {
  decryptWithKey,
  decryptWithPassphrase,
  encryptWithKey,
  encryptWithPassphrase,
  generateKeyHex,
  isPassphraseCiphertext,
  ITERATION_LIMITS,
} from "./aes";
import { fromHex, toHex, toUtf8 } from "./bytes";
import { bcryptCheck, bcryptCost, bcryptHash, digest, encodeDigest } from "./hash";

const FAST = ITERATION_LIMITS.min; // keep the suite quick; the default is 600 000
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("digests", () => {
  // FIPS 180-2 / RFC 1321 test vectors for "abc".
  it("matches the published vectors", async () => {
    const abc = toUtf8("abc");
    expect(encodeDigest(await digest("sha256", abc), "hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(encodeDigest(await digest("sha512", abc), "hex")).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
    expect(encodeDigest(await digest("md5", abc), "hex")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("encodes in hex, HEX or Base64", async () => {
    const empty = await digest("sha256", new Uint8Array());
    expect(encodeDigest(empty, "HEX")).toBe("E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855");
    expect(encodeDigest(empty, "base64")).toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
  });
});

describe("bcrypt", () => {
  it("hashes and checks, with a new salt each time", async () => {
    const one = await bcryptHash("correct horse", 4);
    const two = await bcryptHash("correct horse", 4);
    expect(one).toMatch(/^\$2a\$04\$[./A-Za-z0-9]{53}$/);
    expect(one).not.toBe(two);
    expect(await bcryptCheck("correct horse", one)).toBe(true);
    expect(await bcryptCheck("wrong horse", one)).toBe(false);
    expect(bcryptCost(one)).toBe(4);
  });

  it("checks $2b$ and $2y$ (PHP) hashes too", async () => {
    const hash = await bcryptHash("s3cret", 4);
    expect(await bcryptCheck("s3cret", hash.replace("$2a$", "$2b$"))).toBe(true);
    expect(await bcryptCheck("s3cret", hash.replace("$2a$", "$2y$"))).toBe(true);
  });

  it("refuses what bcrypt would silently get wrong", async () => {
    await expect(bcryptHash("x".repeat(73), 4)).rejects.toThrow(/first 72 bytes/);
    await expect(bcryptHash("pw", 3)).rejects.toThrow(/from 4 to 15/);
    await expect(bcryptHash("", 4)).rejects.toThrow(/Type the text/);
    await expect(bcryptCheck("pw", "not-a-hash")).rejects.toThrow(/isn't a bcrypt hash/);
  });
});

describe("AES-256 with a passphrase", () => {
  it("round-trips text, and the output names its parameters", async () => {
    const encrypted = await encryptWithPassphrase("top secret ✓", "correct horse battery", FAST);
    expect(isPassphraseCiphertext(encrypted.output)).toBe(true);
    expect(encrypted.output.split(".")).toHaveLength(6);
    expect(encrypted.params).toMatchObject({ cipher: "AES-256-GCM", iterations: FAST, ciphertextBytes: 14 + 16 });
    expect(encrypted.params.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(encrypted.params.iv).toMatch(/^[0-9a-f]{24}$/);
    const decrypted = await decryptWithPassphrase(encrypted.output, "correct horse battery");
    expect(text(decrypted.bytes)).toBe("top secret ✓");
  });

  it("uses a fresh salt and IV every time", async () => {
    const one = await encryptWithPassphrase("same", "pass", FAST);
    const two = await encryptWithPassphrase("same", "pass", FAST);
    expect(one.output).not.toBe(two.output);
  });

  it("fails clearly on a wrong passphrase or a changed message", async () => {
    const { output } = await encryptWithPassphrase("hello", "right", FAST);
    await expect(decryptWithPassphrase(output, "wrong")).rejects.toThrow(/Wrong passphrase/);
    const parts = output.split(".");
    parts[5] = (parts[5][0] === "A" ? "B" : "A") + parts[5].slice(1);
    await expect(decryptWithPassphrase(parts.join("."), "right")).rejects.toThrow(/integrity check failed/);
  });

  it("rejects input that isn't its format, and weak settings", async () => {
    await expect(decryptWithPassphrase("hello", "pw")).rejects.toThrow(/isn't passphrase ciphertext/);
    await expect(encryptWithPassphrase("x", "pw", 1000)).rejects.toThrow(/Iterations must be/);
    await expect(encryptWithPassphrase("x", "", FAST)).rejects.toThrow(/Enter a passphrase/);
  });
});

describe("AES-256 with a raw key", () => {
  // NIST SP 800-38A F.2.5 (CBC-AES256), first block.
  const KEY = "603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4";
  const IV = "000102030405060708090a0b0c0d0e0f";
  const PLAIN = "6bc1bee22e409f96e93d7e117393172a";
  const CIPHER_BLOCK = "f58c4c04d6e5f1ba779eabfb5f7bfbd6";

  it("matches NIST's AES-256-CBC vector", async () => {
    const result = await encryptWithKey(fromHex(PLAIN), KEY, IV, "cbc", "hex");
    // The first block is NIST's; the second is PKCS#7 padding.
    expect(result.output.slice(0, 32)).toBe(CIPHER_BLOCK);
    expect(result.output).toHaveLength(64);
    const back = await decryptWithKey(result.output, KEY, IV, "cbc", "hex");
    expect(toHex(back.bytes)).toBe(PLAIN);
  });

  it("round-trips GCM, picking a random IV when none is given", async () => {
    const key = generateKeyHex();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const encrypted = await encryptWithKey("hello GCM", key, "", "gcm", "base64");
    expect(encrypted.params.iv).toMatch(/^[0-9a-f]{24}$/);
    const decrypted = await decryptWithKey(encrypted.output, key, encrypted.params.iv, "gcm", "base64");
    expect(text(decrypted.bytes)).toBe("hello GCM");
  });

  it("explains wrong sizes and wrong keys", async () => {
    await expect(encryptWithKey("x", "abcd", "", "gcm", "hex")).rejects.toThrow(/32 bytes \(64 hex digits\); this one is 2 bytes/);
    await expect(encryptWithKey("x", KEY, "0011", "cbc", "hex")).rejects.toThrow(/IV for AES-CBC is 16 bytes/);
    await expect(decryptWithKey("abcd", KEY, "", "cbc", "hex")).rejects.toThrow(/Enter the IV/);
    const { output, params } = await encryptWithKey("x", KEY, "", "gcm", "hex");
    await expect(decryptWithKey(output, generateKeyHex(), params.iv, "gcm", "hex")).rejects.toThrow(/Wrong key or IV/);
  });
});
