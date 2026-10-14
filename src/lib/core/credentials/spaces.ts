/**
 * Spaces: named groups such as "Personal", "Dev team" or "Organisation"
 * that split the credential list into tabs. A login belongs to at most one
 * space (`CredentialFields.space`, "" = none); "All" always lists every login.
 *
 * A space is just that field — sealed with the rest of the login's metadata,
 * carried in backups and re-keyed with it — so a space exists while at least
 * one login uses it. Pure functions, unit-tested.
 */

import type { CredentialFields } from "./types";

export const SPACE_NAME_MAX = 40;

/** Control characters dropped, whitespace collapsed, capped. "" = no space. */
export function normalizeSpaceName(input: string): string {
  return input
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, SPACE_NAME_MAX)
    .trim();
}

/** Why a name can't be used for a new space, or null when it can. */
export function spaceNameError(input: string): string | null {
  const name = normalizeSpaceName(input);
  if (!name) return "Enter a name for the space.";
  if (name.toLowerCase() === "all") return "“All” already lists every login. Choose another name.";
  return null;
}

/**
 * The spelling to store: an existing space that matches case-insensitively
 * wins, so "dev team" files into "Dev team" instead of starting a twin.
 */
export function canonicalSpace(input: string, existing: readonly string[]): string {
  const name = normalizeSpaceName(input);
  if (!name) return "";
  const key = name.toLowerCase();
  return existing.find((s) => s.toLowerCase() === key) ?? name;
}

/** Distinct spaces in tab order (alphabetical, case-insensitive). */
export function spaceNames(items: ReadonlyArray<Pick<CredentialFields, "space">>, extra: readonly string[] = []): string[] {
  const byKey = new Map<string, string>();
  for (const name of [...items.map((i) => i.space), ...extra]) {
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Logins per space ("" counts logins without one). */
export function spaceCounts(items: ReadonlyArray<Pick<CredentialFields, "space">>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { space } of items) counts.set(space, (counts.get(space) ?? 0) + 1);
  return counts;
}

/** Logins in `space`; "" is the All view and keeps every login. */
export function inSpace<T extends Pick<CredentialFields, "space">>(items: readonly T[], space: string): T[] {
  return space ? items.filter((i) => i.space === space) : [...items];
}

/** A stable hue (0–359) per space name, so its tab dot keeps its colour. */
export function spaceHue(name: string): number {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}
