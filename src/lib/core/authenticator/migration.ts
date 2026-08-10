/**
 * Google Authenticator "export accounts" QR support.
 *
 * Those QR codes contain `otpauth-migration://offline?data=<base64>` where
 * `data` is a protobuf MigrationPayload. Only a tiny subset of protobuf is
 * needed (varints + length-delimited fields), so this is a minimal hand-rolled
 * decoder rather than a dependency.
 *
 * MigrationPayload {
 *   repeated OtpParameters otp_parameters = 1;
 *   // (version / batch fields ignored)
 * }
 * OtpParameters {
 *   bytes  secret    = 1;
 *   string name      = 2;
 *   string issuer    = 3;
 *   enum   algorithm = 4;  // 1=SHA1 2=SHA256 3=SHA512 4=MD5
 *   enum   digits    = 5;  // 1=six 2=eight
 *   enum   type      = 6;  // 1=hotp 2=totp
 *   int64  counter   = 7;
 * }
 */

import { base32Encode } from "./base32";
import type { OtpAlgorithm, ParsedAccount } from "./types";

class ProtoReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  /** Read a varint as a JS number (values here never exceed 2^53). */
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.bytes.length) throw new Error("Truncated varint");
      const byte = this.bytes[this.pos++];
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error("Varint too long");
    }
  }

  bytesField(): Uint8Array {
    const length = this.varint();
    if (this.pos + length > this.bytes.length) {
      throw new Error("Truncated length-delimited field");
    }
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  /** Skip a field of the given wire type. */
  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2:
        this.bytesField();
        break;
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }
}

const MIGRATION_ALGORITHMS: Record<number, OtpAlgorithm> = {
  1: "SHA1",
  2: "SHA256",
  3: "SHA512",
};

function decodeOtpParameters(bytes: Uint8Array): ParsedAccount | null {
  const reader = new ProtoReader(bytes);
  let secret: Uint8Array | null = null;
  let name = "";
  let issuer = "";
  let algorithm: OtpAlgorithm = "SHA1";
  let digits = 6;
  let type: "totp" | "hotp" = "totp";
  let counter = 0;

  const utf8 = new TextDecoder();

  while (!reader.done) {
    const tag = reader.varint();
    const field = tag >>> 3;
    const wire = tag & 0x07;
    switch (field) {
      case 1:
        secret = reader.bytesField();
        break;
      case 2:
        name = utf8.decode(reader.bytesField());
        break;
      case 3:
        issuer = utf8.decode(reader.bytesField());
        break;
      case 4:
        algorithm = MIGRATION_ALGORITHMS[reader.varint()] ?? "SHA1";
        break;
      case 5:
        digits = reader.varint() === 2 ? 8 : 6;
        break;
      case 6:
        type = reader.varint() === 1 ? "hotp" : "totp";
        break;
      case 7:
        counter = reader.varint();
        break;
      default:
        reader.skip(wire);
    }
  }

  if (!secret || secret.length === 0) return null;

  // Google's export duplicates the issuer into name as "Issuer:account".
  let account = name;
  const colon = name.indexOf(":");
  if (colon >= 0) {
    if (!issuer) issuer = name.slice(0, colon).trim();
    account = name.slice(colon + 1).trim();
  }

  return {
    type,
    issuer,
    account,
    secret: base32Encode(secret),
    algorithm,
    digits,
    period: 30,
    counter,
  };
}

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decode the base64 MigrationPayload into individual accounts. */
export function decodeMigrationPayload(base64Data: string): ParsedAccount[] {
  const reader = new ProtoReader(base64Decode(base64Data));
  const accounts: ParsedAccount[] = [];

  while (!reader.done) {
    const tag = reader.varint();
    const field = tag >>> 3;
    const wire = tag & 0x07;
    if (field === 1 && wire === 2) {
      const account = decodeOtpParameters(reader.bytesField());
      if (account) accounts.push(account);
    } else {
      reader.skip(wire);
    }
  }
  return accounts;
}

/**
 * Parse a full `otpauth-migration://offline?data=…` URI.
 * The data parameter is extracted manually (not via URLSearchParams) because
 * standard base64 contains '+', which URLSearchParams would turn into spaces.
 */
export function parseMigrationUri(uri: string): ParsedAccount[] {
  const match = /^otpauth-migration:\/\/[^?]*\?(?:.*&)?data=([^&]+)/i.exec(
    uri.trim(),
  );
  if (!match) throw new Error("Not an otpauth-migration:// URI");
  const data = decodeURIComponent(match[1]);
  const accounts = decodeMigrationPayload(data);
  if (accounts.length === 0) {
    throw new Error("Migration payload contained no accounts");
  }
  return accounts;
}
