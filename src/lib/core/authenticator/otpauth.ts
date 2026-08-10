/**
 * otpauth:// URI parsing and generation (the de-facto Key URI format used by
 * Google Authenticator and every compatible app).
 *
 * Handles the messy real-world cases: URL-encoded labels, "Issuer:account"
 * labels, issuer only in the label or only in the query, missing parameters
 * (defaults SHA1 / 6 digits / 30 s), steam entries expressed either as
 * `otpauth://steam/…` or as totp with `encoder=steam`.
 *
 * `otpauth-migration://` URIs (Google Authenticator exports) are handled in
 * migration.ts.
 */

import { DEFAULTS, type OtpAlgorithm, type OtpType, type ParsedAccount } from "./types";
import { isValidBase32, normalizeBase32 } from "./base32";

function parseAlgorithm(value: string | null): OtpAlgorithm {
  const v = (value ?? "").toUpperCase().replace(/-/g, "");
  if (v === "SHA256") return "SHA256";
  if (v === "SHA512") return "SHA512";
  return "SHA1";
}

function parseIntOr(value: string | null, fallback: number): number {
  const n = value === null ? NaN : parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** True for strings that look like an otpauth account URI. */
export function isOtpAuthUri(text: string): boolean {
  return /^otpauth:\/\//i.test(text.trim());
}

/** True for Google Authenticator migration URIs. */
export function isMigrationUri(text: string): boolean {
  return /^otpauth-migration:\/\//i.test(text.trim());
}

/**
 * Parse a single otpauth:// URI into account parameters.
 * Throws with a human-readable message on malformed input.
 */
export function parseOtpAuthUri(uri: string): ParsedAccount {
  const trimmed = uri.trim();
  const match = /^otpauth:\/\/([^/?#]+)\/?([^?#]*)(?:\?([^#]*))?/i.exec(trimmed);
  if (!match) throw new Error("Not an otpauth:// URI");

  const scheme = match[1].toLowerCase();
  const rawLabel = match[2] ?? "";
  const params = new URLSearchParams(match[3] ?? "");

  const secret = normalizeBase32(params.get("secret") ?? "");
  if (!secret) throw new Error("URI is missing the secret parameter");
  if (!isValidBase32(secret)) throw new Error("Secret is not valid Base32");

  // Label: "Issuer:account", "Issuer%3Aaccount", just "account", or empty.
  let label: string;
  try {
    label = decodeURIComponent(rawLabel);
  } catch {
    label = rawLabel;
  }
  let labelIssuer = "";
  let account = label.trim();
  const colon = label.indexOf(":");
  if (colon >= 0) {
    labelIssuer = label.slice(0, colon).trim();
    account = label.slice(colon + 1).trim();
  }
  const issuer = (params.get("issuer") ?? "").trim() || labelIssuer;

  const digitsParam = parseIntOr(params.get("digits"), DEFAULTS.digits);
  const encoder = (params.get("encoder") ?? "").toLowerCase();

  let type: OtpType;
  if (scheme === "hotp") {
    type = "hotp";
  } else if (
    scheme === "steam" ||
    encoder === "steam" ||
    (issuer.toLowerCase() === "steam" && digitsParam === 5)
  ) {
    type = "steam";
  } else if (scheme === "totp") {
    type = "totp";
  } else {
    throw new Error(`Unsupported otpauth type "${scheme}"`);
  }

  return {
    type,
    issuer,
    account,
    secret,
    algorithm: parseAlgorithm(params.get("algorithm")),
    digits: type === "steam" ? 5 : digitsParam,
    period: parseIntOr(params.get("period"), DEFAULTS.period),
    counter: parseIntOr(params.get("counter"), 0),
  };
}

/**
 * Build an otpauth:// URI for an account. Steam entries use the widely
 * understood `otpauth://steam/` scheme (Aegis, KeePassXC, …); blizzard is
 * expressed as plain 8-digit TOTP so any app can import it.
 */
export function buildOtpAuthUri(entry: {
  type: OtpType;
  issuer: string;
  account: string;
  secret: string;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
  counter: number;
}): string {
  const scheme =
    entry.type === "hotp" ? "hotp" : entry.type === "steam" ? "steam" : "totp";

  const label = entry.issuer
    ? `${encodeURIComponent(entry.issuer)}:${encodeURIComponent(entry.account)}`
    : encodeURIComponent(entry.account);

  const params = new URLSearchParams();
  params.set("secret", normalizeBase32(entry.secret));
  if (entry.issuer) params.set("issuer", entry.issuer);
  if (entry.algorithm !== "SHA1") params.set("algorithm", entry.algorithm);

  if (entry.type === "hotp") {
    params.set("counter", String(entry.counter));
    if (entry.digits !== 6) params.set("digits", String(entry.digits));
  } else if (entry.type === "steam") {
    params.set("digits", "5");
  } else if (entry.type === "blizzard") {
    params.set("digits", "8");
  } else {
    if (entry.digits !== 6) params.set("digits", String(entry.digits));
    if (entry.period !== 30) params.set("period", String(entry.period));
  }

  return `otpauth://${scheme}/${label}?${params.toString()}`;
}
