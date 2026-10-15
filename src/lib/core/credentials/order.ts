/**
 * The user's own order of saved logins (Credential Manager → Reorder).
 * One list of credential ids for the whole vault: every view (All, a space,
 * the same filters) shows its logins in that relative order. Pure, tested.
 */

import type { CredentialFields } from "./types";

type Orderable = Pick<CredentialFields, "platform"> & { id: string };

/** `list` with `item` moved to `index` (clamped); unchanged if it isn't there. */
export function moveTo(list: readonly string[], item: string, index: number): string[] {
  const from = list.indexOf(item);
  if (from < 0) return [...list];
  const rest = list.filter((_, i) => i !== from);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, item);
  return rest;
}

/**
 * Logins in the saved order; any it doesn't list (new, restored from a
 * backup, or never ordered) follow alphabetically by platform — so with no
 * saved order the list is A–Z, as it always was.
 */
export function sortByOrder<T extends Orderable>(items: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const byName = (a: T, b: T) => a.platform.localeCompare(b.platform, undefined, { sensitivity: "base" });
  const ranked = items.filter((c) => rank.has(c.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const rest = items.filter((c) => !rank.has(c.id)).sort(byName);
  return [...ranked, ...rest];
}

/**
 * The full order after dropping `id` onto `targetId` (it takes the target's
 * place: after it when moving down, before it when moving up). Works on the
 * whole vault's order, so reordering inside a space keeps every other login
 * where it was.
 */
export function moveOnto(fullOrder: readonly string[], id: string, targetId: string): string[] {
  if (id === targetId || !fullOrder.includes(targetId)) return [...fullOrder];
  return moveTo(fullOrder, id, fullOrder.indexOf(targetId));
}
