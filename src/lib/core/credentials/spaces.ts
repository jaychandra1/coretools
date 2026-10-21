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
import { moveTo } from "./order";
import { nameHue } from "../hue";

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

/**
 * Tab order: spaces in the user's saved order first (matched
 * case-insensitively; names no longer in use are skipped), then any others
 * alphabetically — so a new space lands at the end, and with no saved order
 * the tabs stay alphabetical.
 */
export function orderSpaces(names: readonly string[], order: readonly string[]): string[] {
  const rank = new Map<string, number>();
  order.forEach((name, i) => {
    if (!rank.has(name.toLowerCase())) rank.set(name.toLowerCase(), i);
  });
  const ranked = names.filter((n) => rank.has(n.toLowerCase()));
  ranked.sort((a, b) => rank.get(a.toLowerCase())! - rank.get(b.toLowerCase())!);
  const rest = names
    .filter((n) => !rank.has(n.toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return [...ranked, ...rest];
}

/** `list` with `name` moved to `index` (clamped); unchanged if it isn't there. */
export function moveSpace(list: readonly string[], name: string, index: number): string[] {
  return moveTo(list, name, index);
}

/** The saved order after renaming `from` to `to` (merging if `to` is listed), or removing it (`to` = null). */
export function renameInOrder(order: readonly string[], from: string, to: string | null): string[] {
  const key = from.toLowerCase();
  const toKey = to?.toLowerCase();
  const merging = toKey !== undefined && toKey !== key && order.some((n) => n.toLowerCase() === toKey);
  return order.flatMap((n) => {
    if (n.toLowerCase() !== key) return [n];
    return to === null || merging ? [] : [to];
  });
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

/** A stable hue per space name, whatever its case, so its tab dot keeps its colour. */
export function spaceHue(name: string): number {
  return nameHue(name.toLowerCase());
}
