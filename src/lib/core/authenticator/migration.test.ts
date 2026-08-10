import { describe, it, expect } from "vitest";
import { decodeMigrationPayload, parseMigrationUri } from "./migration";
import { base32Decode } from "./base32";

/** Tiny protobuf writer used to construct test payloads. */
function varint(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

function lengthDelimited(field: number, bytes: number[] | Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}

function varintField(field: number, value: number): number[] {
  return [...varint(field << 3), ...varint(value)];
}

const utf8 = (s: string) => [...new TextEncoder().encode(s)];

function otpParameters(opts: {
  secret: Uint8Array;
  name?: string;
  issuer?: string;
  algorithm?: number;
  digits?: number;
  type?: number;
  counter?: number;
}): number[] {
  const body = [
    ...lengthDelimited(1, opts.secret),
    ...(opts.name ? lengthDelimited(2, utf8(opts.name)) : []),
    ...(opts.issuer ? lengthDelimited(3, utf8(opts.issuer)) : []),
    ...(opts.algorithm !== undefined ? varintField(4, opts.algorithm) : []),
    ...(opts.digits !== undefined ? varintField(5, opts.digits) : []),
    ...(opts.type !== undefined ? varintField(6, opts.type) : []),
    ...(opts.counter !== undefined ? varintField(7, opts.counter) : []),
  ];
  return lengthDelimited(1, body); // MigrationPayload.otp_parameters = 1
}

function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

const SECRET = base32Decode("JBSWY3DPEHPK3PXP");

describe("decodeMigrationPayload", () => {
  it("decodes a two-account payload", () => {
    const payload = [
      ...otpParameters({
        secret: SECRET,
        name: "Example:alice@example.com",
        issuer: "Example",
        algorithm: 1,
        digits: 1,
        type: 2,
      }),
      ...otpParameters({
        secret: SECRET,
        name: "bank",
        algorithm: 2,
        digits: 2,
        type: 1,
        counter: 12,
      }),
      // version field (2) — must be skipped gracefully
      ...varintField(2, 1),
    ];

    const accounts = decodeMigrationPayload(toBase64(payload));
    expect(accounts).toHaveLength(2);

    expect(accounts[0]).toEqual({
      type: "totp",
      issuer: "Example",
      account: "alice@example.com",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      counter: 0,
    });

    expect(accounts[1]).toEqual({
      type: "hotp",
      issuer: "",
      account: "bank",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA256",
      digits: 8,
      period: 30,
      counter: 12,
    });
  });

  it("lifts the issuer from a prefixed name when the issuer field is empty", () => {
    const payload = otpParameters({
      secret: SECRET,
      name: "GitHub:alice",
      type: 2,
    });
    const [account] = decodeMigrationPayload(toBase64(payload));
    expect(account.issuer).toBe("GitHub");
    expect(account.account).toBe("alice");
  });

  it("skips parameter blocks without a secret", () => {
    const payload = [
      ...otpParameters({ secret: new Uint8Array(0), name: "empty" }),
      ...otpParameters({ secret: SECRET, name: "real", type: 2 }),
    ];
    const accounts = decodeMigrationPayload(toBase64(payload));
    expect(accounts).toHaveLength(1);
    expect(accounts[0].account).toBe("real");
  });
});

describe("parseMigrationUri", () => {
  it("extracts and decodes the data parameter, preserving '+' characters", () => {
    const payload = otpParameters({ secret: SECRET, name: "x", type: 2 });
    const data = toBase64(payload);
    const uri = `otpauth-migration://offline?data=${encodeURIComponent(data)}`;
    const accounts = parseMigrationUri(uri);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].secret).toBe("JBSWY3DPEHPK3PXP");
  });

  it("rejects URIs without a data parameter", () => {
    expect(() => parseMigrationUri("otpauth-migration://offline")).toThrow();
  });
});
