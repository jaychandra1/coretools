import { describe, it, expect } from "vitest";
import { base32Encode } from "./base32";
import {
  generateCode,
  groupCode,
  hotp,
  secondsRemaining,
  steamCode,
  totp,
  STEAM_ALPHABET,
} from "./otp";

const utf8 = (s: string) => new TextEncoder().encode(s);

// RFC 4226 Appendix D — secret "12345678901234567890".
const HOTP_SECRET = base32Encode(utf8("12345678901234567890"));

describe("HOTP (RFC 4226 test vectors)", () => {
  const expected = [
    "755224", "287082", "359152", "969429", "338314",
    "254676", "287922", "162583", "399871", "520489",
  ];

  expected.forEach((code, counter) => {
    it(`counter=${counter} -> ${code}`, async () => {
      expect(await hotp(HOTP_SECRET, counter, 6, "SHA1")).toBe(code);
    });
  });
});

// RFC 6238 Appendix B — per-algorithm ASCII seeds, 8 digits.
const SEED_SHA1 = base32Encode(utf8("12345678901234567890"));
const SEED_SHA256 = base32Encode(utf8("12345678901234567890123456789012"));
const SEED_SHA512 = base32Encode(
  utf8("1234567890123456789012345678901234567890123456789012345678901234"),
);

describe("TOTP (RFC 6238 test vectors, 8 digits, 30s)", () => {
  const vectors: Array<[number, string, string, string]> = [
    // time (s), SHA1, SHA256, SHA512
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];

  for (const [seconds, sha1, sha256, sha512] of vectors) {
    it(`t=${seconds}`, async () => {
      const ms = seconds * 1000;
      expect(await totp(SEED_SHA1, ms, 30, 8, "SHA1")).toBe(sha1);
      expect(await totp(SEED_SHA256, ms, 30, 8, "SHA256")).toBe(sha256);
      expect(await totp(SEED_SHA512, ms, 30, 8, "SHA512")).toBe(sha512);
    });
  }

  it("supports 6/7 digits and custom periods", async () => {
    // 6-digit value is the tail of the 8-digit RFC vector.
    expect(await totp(SEED_SHA1, 59_000, 30, 6, "SHA1")).toBe("287082");
    expect(await totp(SEED_SHA1, 59_000, 30, 7, "SHA1")).toBe("4287082");
    // With period 60 the counter at t=119 equals the counter at t=59 with period 30.
    expect(await totp(SEED_SHA1, 119_000, 60, 8, "SHA1")).toBe("94287082");
  });
});

describe("Steam Guard codes", () => {
  const secret = "JBSWY3DPEHPK3PXP";

  it("produces 5 chars from the Steam alphabet", async () => {
    const code = await steamCode(secret, 1_700_000_000_000);
    expect(code).toHaveLength(5);
    for (const c of code) expect(STEAM_ALPHABET).toContain(c);
  });

  it("is stable within a 30s window and changes across windows", async () => {
    const t = 1_700_000_010_000; // 10s into a window
    expect(await steamCode(secret, t)).toBe(await steamCode(secret, t + 5_000));
    // Neighbouring windows virtually never repeat for this fixed secret.
    expect(await steamCode(secret, t)).not.toBe(
      await steamCode(secret, t + 30_000),
    );
  });
});

describe("generateCode dispatch", () => {
  const base = {
    secret: SEED_SHA1,
    algorithm: "SHA1" as const,
    digits: 6,
    period: 30,
    counter: 0,
  };

  it("blizzard = 8-digit SHA1 TOTP", async () => {
    const code = await generateCode({ ...base, type: "blizzard" }, 59_000);
    expect(code).toBe("94287082");
  });

  it("hotp uses the counter, not the clock", async () => {
    const code = await generateCode(
      { ...base, type: "hotp", secret: HOTP_SECRET, counter: 5 },
      Date.now(),
    );
    expect(code).toBe("254676");
  });
});

describe("display helpers", () => {
  it("groups codes for readability", () => {
    expect(groupCode("123456")).toBe("123 456");
    expect(groupCode("12345678")).toBe("1234 5678");
    expect(groupCode("1234567")).toBe("123 4567");
    expect(groupCode("R2D3C")).toBe("R2D3C");
  });

  it("computes seconds remaining in the period", () => {
    expect(secondsRemaining(0, 30)).toBe(30);
    expect(secondsRemaining(29_000, 30)).toBe(1);
    expect(secondsRemaining(45_000, 30)).toBe(15);
  });
});
