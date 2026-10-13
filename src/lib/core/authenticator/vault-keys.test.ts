import { describe, it, expect } from "vitest";
import { createHash, pbkdf2Sync } from "node:crypto";
import { DEFAULT_KDF, deriveKeyBytes, describeKdf, parseKdf } from "./kdf";
import { generateDataKey, unwrapDataKey, wrapDataKey, WrongPasswordError } from "./vault-keys";
import { assessPassword, MIN_PASSWORD_LENGTH } from "./password-strength";
import { mergeTombstones, TOMBSTONE_TTL_MS, tombstoneKey, withoutKeys } from "./tombstones";
import { bytesToBase64 } from "./legacy-crypto";

const FAST = { name: "Argon2id" as const, memoryKiB: 19 * 1024, iterations: 1, parallelism: 1 };
const SALT = bytesToBase64(new Uint8Array(16).map((_, i) => i));

describe("kdf", () => {
  it("defaults new vaults to Argon2id at 64 MiB × 3", () => {
    expect(DEFAULT_KDF).toEqual({ name: "Argon2id", memoryKiB: 65536, iterations: 3, parallelism: 1 });
    expect(describeKdf(DEFAULT_KDF)).toBe("Argon2id 64 MiB × 3");
  });

  it("derives PBKDF2 bytes identical to node:crypto (legacy vaults stay openable)", async () => {
    const ours = await deriveKeyBytes("pw", SALT, { name: "PBKDF2-SHA256", iterations: 100_000 });
    const theirs = pbkdf2Sync("pw", Buffer.from(new Uint8Array(16).map((_, i) => i)), 100_000, 32, "sha256");
    expect(Buffer.from(ours).toString("hex")).toBe(theirs.toString("hex"));
  });

  it("derives Argon2id deterministically, salt- and password-sensitive", async () => {
    const a = await deriveKeyBytes("correct horse", SALT, FAST);
    const b = await deriveKeyBytes("correct horse", SALT, FAST);
    const c = await deriveKeyBytes("correct horsf", SALT, FAST);
    const d = await deriveKeyBytes("correct horse", bytesToBase64(new Uint8Array(16)), FAST);
    expect(a).toHaveLength(32);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).not.toEqual(d);
  });

  it("bounds parameters read from storage or downloads", () => {
    expect(parseKdf(FAST)).toEqual(FAST);
    expect(parseKdf({ name: "PBKDF2-SHA256", iterations: 310_000 })).toEqual({
      name: "PBKDF2-SHA256",
      iterations: 310_000,
    });
    for (const bad of [
      { ...FAST, memoryKiB: 8 * 1024 }, // too cheap
      { ...FAST, memoryKiB: 2 * 1024 * 1024 }, // 2 GiB: DoS
      { ...FAST, iterations: 0 },
      { ...FAST, parallelism: 64 },
      { name: "PBKDF2-SHA256", iterations: 1000 },
      { name: "scrypt", N: 1 },
      null,
      "Argon2id",
    ]) {
      expect(parseKdf(bad)).toBeNull();
    }
  });
});

describe("vault keys", () => {
  it("wraps and unwraps a data key; a wrong password is reported as such", async () => {
    const key = generateDataKey();
    const wrapped = await wrapDataKey("a long passphrase here", key, FAST);
    expect(wrapped.kdf).toEqual(FAST);
    expect(await unwrapDataKey("a long passphrase here", wrapped)).toEqual(key);
    await expect(unwrapDataKey("a long passphrase herf", wrapped)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("uses a fresh salt every time, so the same key wraps differently", async () => {
    const key = generateDataKey();
    const one = await wrapDataKey("pw pw pw pw pw", key, FAST);
    const two = await wrapDataKey("pw pw pw pw pw", key, FAST);
    expect(one.salt).not.toBe(two.salt);
    expect(one.wrappedKey.ct).not.toBe(two.wrappedKey.ct);
  });
});

describe("password policy", () => {
  it(`requires at least ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(assessPassword("Xy7#qL0!vB2").ok).toBe(false); // 11 strong characters
    expect(assessPassword("Xy7#qL0!vB2m").ok).toBe(true);
  });

  it("rejects common, repetitive and keyboard-walk passwords", () => {
    for (const weak of ["password1234", "aaaaaaaaaaaaaaaa", "qwertyuiopasdf", "123456789012", "Coretools2026"]) {
      expect(assessPassword(weak).ok, weak).toBe(false);
    }
  });

  it("accepts passphrases and random passwords", () => {
    for (const good of ["correct horse battery staple", "tram-violet-kettle-ninety", "h9$Lq2@vZr!mP4"]) {
      const result = assessPassword(good);
      expect(result.ok, good).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(3);
    }
  });

  it("explains what's wrong", () => {
    expect(assessPassword("short").message).toMatch(/12 characters/);
    expect(assessPassword("passwordpassword").message).toMatch(/password|predictable/);
  });
});

describe("tombstones", () => {
  it("hashes identities (never stores them)", async () => {
    const k = await tombstoneKey("JBSWY3DPEHPK3PXP github octo");
    expect(k).toBe(createHash("sha256").update("JBSWY3DPEHPK3PXP github octo").digest("hex"));
  });

  it("merges by newest deletion, drops expired ones, and can forget keys", () => {
    const now = 2_000_000_000_000;
    const merged = mergeTombstones(
      [
        [{ k: "a", at: now - 10 }, { k: "b", at: now - TOMBSTONE_TTL_MS - 1 }],
        [{ k: "a", at: now - 5 }, { k: "c", at: now - 1 }],
      ],
      now,
    );
    expect(merged).toEqual([
      { k: "c", at: now - 1 },
      { k: "a", at: now - 5 },
    ]);
    expect(withoutKeys(merged, new Set(["a"]))).toEqual([{ k: "c", at: now - 1 }]);
  });
});
