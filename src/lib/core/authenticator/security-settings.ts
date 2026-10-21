/**
 * The settings that protect an encrypted vault (auto-lock, clipboard
 * clearing, the reveal check): which ones they are, and which changes make
 * the vault easier to get into — those are confirmed first (audit S-9) and
 * sealed under the vault key so values planted on disk can't weaken them.
 *
 * The plaintext copy is what applies while locked (the idle timer). On
 * unlock the sealed copy wins; when it is missing, damaged, or something
 * else was put in its place, neither it nor the plaintext is trusted alone:
 * the stricter of the plaintext and the defaults applies (N3).
 */

import type { AuthSettings } from "./db";
import { openField, recordBinding, sealField, type EncryptedBlob } from "./vault-crypto";

export type SecuritySettings = Pick<
  AuthSettings,
  "autoLockMinutes" | "clipboardClear" | "credentialsRevealAuth"
>;

/** The longest auto-lock the settings offer, in minutes. */
export const MAX_AUTO_LOCK_MINUTES = 240;

const BINDING = recordBinding("settings");

export function securityOf(settings: AuthSettings): SecuritySettings {
  return {
    autoLockMinutes: settings.autoLockMinutes,
    clipboardClear: settings.clipboardClear,
    credentialsRevealAuth: settings.credentialsRevealAuth,
  };
}

/** Minutes until auto-lock, with 0 ("never") as the latest. */
function lockLater(minutes: number): number {
  return minutes === 0 ? Infinity : minutes;
}

/** Changing `from` with `patch` makes the vault easier to get into. */
export function weakensSecurity(from: AuthSettings, patch: Partial<AuthSettings>): boolean {
  return (
    (patch.credentialsRevealAuth === false && from.credentialsRevealAuth) ||
    (patch.clipboardClear === false && from.clipboardClear) ||
    (patch.autoLockMinutes !== undefined &&
      lockLater(patch.autoLockMinutes) > lockLater(from.autoLockMinutes))
  );
}

/** Field by field, whichever of the two protects more. */
export function stricterOf(a: SecuritySettings, b: SecuritySettings): SecuritySettings {
  return {
    autoLockMinutes:
      lockLater(a.autoLockMinutes) <= lockLater(b.autoLockMinutes)
        ? a.autoLockMinutes
        : b.autoLockMinutes,
    clipboardClear: a.clipboardClear || b.clipboardClear,
    credentialsRevealAuth: a.credentialsRevealAuth || b.credentialsRevealAuth,
  };
}

/** Security settings of the right shape and range, or null. */
export function parseSecuritySettings(value: unknown): SecuritySettings | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const minutes = v.autoLockMinutes;
  if (
    typeof minutes !== "number" ||
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes > MAX_AUTO_LOCK_MINUTES ||
    typeof v.clipboardClear !== "boolean" ||
    typeof v.credentialsRevealAuth !== "boolean"
  ) {
    return null;
  }
  return {
    autoLockMinutes: minutes,
    clipboardClear: v.clipboardClear,
    credentialsRevealAuth: v.credentialsRevealAuth,
  };
}

export function sealSecuritySettings(key: CryptoKey, settings: AuthSettings): Promise<EncryptedBlob> {
  return sealField(key, JSON.stringify(securityOf(settings)), BINDING);
}

/**
 * The sealed copy, or null when it doesn't open or isn't settings. It was
 * always sealed bound, so an unbound blob (another, older record) is refused.
 */
export async function openSecuritySettings(
  key: CryptoKey,
  sealed: EncryptedBlob,
): Promise<SecuritySettings | null> {
  if (sealed.v !== 2) return null;
  try {
    return parseSecuritySettings(JSON.parse(await openField(key, sealed, BINDING)));
  } catch {
    return null;
  }
}
