/**
 * Display order for authenticator entries: pinned first, then by `index`.
 *
 * Both the list view and drag-to-reorder go through here, so a drop always
 * acts on exactly what the user sees. (Reordering by raw array position used
 * to misplace cards whenever something was pinned, because pinned entries
 * are displayed first regardless of where they sit in the array.)
 */

export interface Orderable {
  id: string;
  index: number;
  pinned: boolean;
}

export function compareDisplay(a: Orderable, b: Orderable): number {
  return Number(b.pinned) - Number(a.pinned) || a.index - b.index;
}

export function displayOrder<T extends Orderable>(entries: readonly T[]): T[] {
  return [...entries].sort(compareDisplay);
}

/**
 * Move `fromId` to where `toId` is in the displayed order and return the new
 * `index` for every entry (id → index), or null when nothing changes.
 *
 * Moving down lands the card after the target, moving up lands it before —
 * the usual drag-and-drop feel. A card dropped across the pinned/unpinned
 * boundary keeps its pin state, so it settles at the nearest edge of its own
 * group.
 */
export function moveInDisplayOrder(
  entries: readonly Orderable[],
  fromId: string,
  toId: string,
): Map<string, number> | null {
  if (fromId === toId) return null;
  const ordered = displayOrder(entries);
  const from = ordered.findIndex((e) => e.id === fromId);
  const to = ordered.findIndex((e) => e.id === toId);
  if (from < 0 || to < 0) return null;

  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);

  const next = new Map<string, number>();
  ordered.forEach((entry, i) => next.set(entry.id, i));
  const before = displayOrder(entries).map((e) => e.id).join(" ");
  const after = displayOrder(
    entries.map((e) => ({ ...e, index: next.get(e.id) ?? e.index })),
  )
    .map((e) => e.id)
    .join(" ");
  return before === after ? null : next;
}
