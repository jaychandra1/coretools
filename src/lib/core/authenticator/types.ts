/**
 * Shared types for the Authenticator feature.
 *
 * `OtpType` mirrors the Authenticator browser extension's entry types:
 * "totp" | "hotp" | "steam" | "blizzard" (the extension calls the last one
 * "battle"; the mapping happens at import/export time in backup.ts).
 */

export type OtpType = "totp" | "hotp" | "steam" | "blizzard";

export type OtpAlgorithm = "SHA1" | "SHA256" | "SHA512";

/** Parameters needed to generate a code, independent of storage concerns. */
export interface OtpParams {
  type: OtpType;
  /** Base32 (RFC 4648) encoded secret. */
  secret: string;
  algorithm: OtpAlgorithm;
  digits: number;
  /** TOTP period in seconds. */
  period: number;
  /** HOTP moving counter. */
  counter: number;
}

/** A fully described account entry as used across the UI and storage. */
export interface OtpEntry extends Omit<OtpParams, "secret"> {
  /** Stable internal id (crypto.randomUUID). */
  id: string;
  /** SHA-256 hex of the secret — also the key in extension-format backups. */
  hash: string;
  issuer: string;
  account: string;
  /** Display order; lower comes first. */
  index: number;
  pinned: boolean;
}

export const DEFAULTS = {
  algorithm: "SHA1" as OtpAlgorithm,
  digits: 6,
  period: 30,
  counter: 0,
} as const;

/** Result of parsing one otpauth:// URI or one migration payload item. */
export interface ParsedAccount {
  type: OtpType;
  issuer: string;
  account: string;
  secret: string;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
  counter: number;
}
