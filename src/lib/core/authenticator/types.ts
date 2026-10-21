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

/**
 * Why `params` can't produce codes, or null when they can (audit S-10).
 * Every way an account comes in — QR codes, otpauth links, backup files,
 * restores — is checked against these limits: a crafted "digits=200000000"
 * would otherwise build a 200 MB string every code period.
 */
export function otpParamsError(params: Pick<OtpParams, "digits" | "period" | "counter">): string | null {
  if (!Number.isInteger(params.digits) || params.digits < 5 || params.digits > 10) {
    return "Codes must have 5 to 10 digits";
  }
  if (!Number.isInteger(params.period) || params.period < 5 || params.period > 3600) {
    return "The code period must be 5 to 3,600 seconds";
  }
  if (!Number.isSafeInteger(params.counter) || params.counter < 0) {
    return "The counter must be a whole number";
  }
  return null;
}

/** A fully described account entry as used across the UI and storage. */
export interface OtpEntry extends Omit<OtpParams, "secret"> {
  /** Stable internal id (crypto.randomUUID). */
  id: string;
  /**
   * Records before 1.3 stored an unsalted SHA-256 of the secret here, which
   * let anyone holding leaked seeds confirm accounts in a stolen vault (audit
   * L3). Nothing reads it; it is dropped the next time a record is written.
   */
  hash?: string;
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
