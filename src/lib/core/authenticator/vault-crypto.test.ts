import { describe, it, expect } from "vitest";
import {
  decryptString,
  deriveVaultKey,
  deriveWrappingKey,
  encryptString,
  exportKeyBytes,
  importVaultKey,
  randomBytes,
  unwrapKeyBytes,
  wrapKeyBytes,
} from "./vault-crypto";
import { bytesToBase64 } from "./legacy-crypto";

// Low iteration count: these tests exercise correctness, not KDF hardness.
const TEST_ITERATIONS = 1000;

describe("vault key derivation + encryption", () => {
  it("encrypts and decrypts round-trip; wrong password fails", async () => {
    const salt = bytesToBase64(randomBytes(16));
    const key = await deriveVaultKey("pw-1", salt, TEST_ITERATIONS);
    const blob = await encryptString(key, "JBSWY3DPEHPK3PXP");
    expect(await decryptString(key, blob)).toBe("JBSWY3DPEHPK3PXP");

    const wrong = await deriveVaultKey("pw-2", salt, TEST_ITERATIONS);
    await expect(decryptString(wrong, blob)).rejects.toThrow();
  });

  it("keys are non-extractable by default", async () => {
    const salt = bytesToBase64(randomBytes(16));
    const key = await deriveVaultKey("pw", salt, TEST_ITERATIONS);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });
});

describe("Hello key wrapping (signature -> wrapping key -> vault key)", () => {
  it("wrap/unwrap round-trips the vault key through raw bytes", async () => {
    const salt = bytesToBase64(randomBytes(16));

    // Enable-time: transient extractable copy, wrapped under the
    // signature-derived key.
    const extractableKey = await deriveVaultKey("pw", salt, TEST_ITERATIONS, true);
    const raw = await exportKeyBytes(extractableKey);
    expect(raw).toHaveLength(32);

    const fakeSignature = randomBytes(256); // stands in for RSA-2048 PKCS#1 output
    const wrappingKey = await deriveWrappingKey(fakeSignature);
    const wrapped = await wrapKeyBytes(wrappingKey, raw);

    // Unlock-time: the same (deterministic) signature unwraps to the same key.
    const wrappingKey2 = await deriveWrappingKey(fakeSignature);
    const unwrapped = await unwrapKeyBytes(wrappingKey2, wrapped);
    expect(unwrapped).toEqual(raw);

    // The restored working key decrypts what the original key encrypted,
    // and is itself non-extractable.
    const blob = await encryptString(extractableKey, "secret-data");
    const restored = await importVaultKey(unwrapped);
    expect(await decryptString(restored, blob)).toBe("secret-data");
    await expect(crypto.subtle.exportKey("raw", restored)).rejects.toThrow();
  });

  it("a different signature cannot unwrap", async () => {
    const raw = randomBytes(32);
    const wrapped = await wrapKeyBytes(await deriveWrappingKey(randomBytes(256)), raw);
    const otherKey = await deriveWrappingKey(randomBytes(256));
    await expect(unwrapKeyBytes(otherKey, wrapped)).rejects.toThrow();
  });
});
