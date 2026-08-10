import { describe, it, expect } from "vitest";
import { buildOtpAuthUri, parseOtpAuthUri, isOtpAuthUri, isMigrationUri } from "./otpauth";

describe("parseOtpAuthUri", () => {
  it("parses a fully specified TOTP URI", () => {
    const parsed = parseOtpAuthUri(
      "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=7&period=60",
    );
    expect(parsed).toEqual({
      type: "totp",
      issuer: "GitHub",
      account: "alice",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA256",
      digits: 7,
      period: 60,
      counter: 0,
    });
  });

  it("applies defaults SHA1/6/30", () => {
    const parsed = parseOtpAuthUri("otpauth://totp/alice?secret=JBSWY3DPEHPK3PXP");
    expect(parsed.algorithm).toBe("SHA1");
    expect(parsed.digits).toBe(6);
    expect(parsed.period).toBe(30);
    expect(parsed.issuer).toBe("");
    expect(parsed.account).toBe("alice");
  });

  it("decodes URL-encoded labels and issuer-in-label", () => {
    const parsed = parseOtpAuthUri(
      "otpauth://totp/My%20Service%3Auser%40example.com?secret=JBSWY3DPEHPK3PXP",
    );
    expect(parsed.issuer).toBe("My Service");
    expect(parsed.account).toBe("user@example.com");
  });

  it("prefers the issuer query param over the label prefix", () => {
    const parsed = parseOtpAuthUri(
      "otpauth://totp/LabelIssuer:bob?secret=JBSWY3DPEHPK3PXP&issuer=RealIssuer",
    );
    expect(parsed.issuer).toBe("RealIssuer");
    expect(parsed.account).toBe("bob");
  });

  it("parses HOTP with a counter", () => {
    const parsed = parseOtpAuthUri(
      "otpauth://hotp/Acme:carol?secret=JBSWY3DPEHPK3PXP&counter=42",
    );
    expect(parsed.type).toBe("hotp");
    expect(parsed.counter).toBe(42);
  });

  it("recognizes steam via scheme, encoder param, or issuer+digits", () => {
    for (const uri of [
      "otpauth://steam/Steam:gamer?secret=JBSWY3DPEHPK3PXP",
      "otpauth://totp/Steam:gamer?secret=JBSWY3DPEHPK3PXP&encoder=steam",
      "otpauth://totp/Steam:gamer?secret=JBSWY3DPEHPK3PXP&issuer=Steam&digits=5",
    ]) {
      const parsed = parseOtpAuthUri(uri);
      expect(parsed.type).toBe("steam");
      expect(parsed.digits).toBe(5);
    }
  });

  it("normalizes and validates the secret", () => {
    const parsed = parseOtpAuthUri(
      "otpauth://totp/x?secret=jbsw%20y3dp%20ehpk%203pxp",
    );
    expect(parsed.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(() => parseOtpAuthUri("otpauth://totp/x?secret=notbase32!")).toThrow(
      /Base32/,
    );
    expect(() => parseOtpAuthUri("otpauth://totp/x")).toThrow(/secret/);
  });

  it("rejects other schemes and types", () => {
    expect(() => parseOtpAuthUri("https://example.com")).toThrow(/otpauth/);
    expect(() => parseOtpAuthUri("otpauth://weird/x?secret=JBSWY3DP")).toThrow(
      /Unsupported/,
    );
  });
});

describe("buildOtpAuthUri", () => {
  const base = {
    issuer: "GitHub",
    account: "alice@example.com",
    secret: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA1" as const,
    digits: 6,
    period: 30,
    counter: 0,
  };

  it("round-trips a TOTP entry", () => {
    const uri = buildOtpAuthUri({ ...base, type: "totp" });
    const parsed = parseOtpAuthUri(uri);
    expect(parsed.issuer).toBe("GitHub");
    expect(parsed.account).toBe("alice@example.com");
    expect(parsed.secret).toBe(base.secret);
    expect(parsed.type).toBe("totp");
  });

  it("round-trips HOTP counter and non-default params", () => {
    const uri = buildOtpAuthUri({
      ...base,
      type: "hotp",
      counter: 7,
      digits: 8,
    });
    const parsed = parseOtpAuthUri(uri);
    expect(parsed.type).toBe("hotp");
    expect(parsed.counter).toBe(7);
    expect(parsed.digits).toBe(8);
  });

  it("round-trips steam and blizzard", () => {
    const steam = parseOtpAuthUri(buildOtpAuthUri({ ...base, type: "steam" }));
    expect(steam.type).toBe("steam");

    const blizzard = parseOtpAuthUri(
      buildOtpAuthUri({ ...base, type: "blizzard", digits: 8 }),
    );
    expect(blizzard.type).toBe("totp"); // exported as plain 8-digit TOTP
    expect(blizzard.digits).toBe(8);
  });

  it("URL-encodes label parts", () => {
    const uri = buildOtpAuthUri({
      ...base,
      type: "totp",
      issuer: "My Service",
      account: "user name@example.com",
    });
    expect(uri).toContain("My%20Service");
    const parsed = parseOtpAuthUri(uri);
    expect(parsed.issuer).toBe("My Service");
    expect(parsed.account).toBe("user name@example.com");
  });
});

describe("URI sniffing", () => {
  it("detects otpauth and migration URIs", () => {
    expect(isOtpAuthUri(" otpauth://totp/x?secret=A ")).toBe(true);
    expect(isOtpAuthUri("otpauth-migration://offline?data=x")).toBe(false);
    expect(isMigrationUri("otpauth-migration://offline?data=x")).toBe(true);
  });
});
