/**
 * Deletion records ("tombstones") for backup merges (audit F-09).
 *
 * A backup is a snapshot, so on its own a merge can't tell "this device
 * deleted X" from "this device never had X" and would bring deleted
 * accounts and logins (say, a rotated, compromised password) back. Each
 * collection therefore remembers what it deleted — as the SHA-256 of the
 * record's identity, never the identity itself — and the list travels in
 * the encrypted backup. A merge then:
 *  - skips backup records this device deleted (local tombstone), and
 *  - removes local records another device deleted after this device last
 *    added them (remote tombstone newer than the record).
 * A record added again later clears its tombstone. Tombstones expire after
 * TOMBSTONE_TTL_MS; by then every backup old enough to resurrect the
 * record has been pruned or is a deliberate rollback ("replace").
 */

import { sha256Hex } from "./vault-crypto";

export interface Tombstone {
  k: string;
  at: number;
}

export const TOMBSTONE_TTL_MS = 400 * 24 * 60 * 60 * 1000;
/** Keeps a pathological delete-everything loop from growing the list unbounded. */
export const TOMBSTONE_LIMIT = 5000;

export function tombstoneKey(identity: string): Promise<string> {
  return sha256Hex(identity);
}

/** Union of lists (newest deletion per key wins), expired ones dropped. */
export function mergeTombstones(
  lists: ReadonlyArray<readonly Tombstone[]>,
  now = Date.now(),
): Tombstone[] {
  const byKey = new Map<string, number>();
  for (const list of lists) {
    for (const t of list) {
      if (now - t.at > TOMBSTONE_TTL_MS) continue;
      byKey.set(t.k, Math.max(byKey.get(t.k) ?? 0, t.at));
    }
  }
  return [...byKey]
    .map(([k, at]) => ({ k, at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, TOMBSTONE_LIMIT);
}

export function withoutKeys(list: readonly Tombstone[], keys: ReadonlySet<string>): Tombstone[] {
  return list.filter((t) => !keys.has(t.k));
}
