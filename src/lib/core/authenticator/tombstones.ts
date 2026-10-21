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
 * TOMBSTONE_TTL_MS, a little longer than the year Drive keeps versions
 * (cloud-sync.ts RETENTION — the version protected from before a mass
 * deletion too). An exported file never expires, though: merging one older
 * than TOMBSTONE_TTL_MS can bring back a record deleted since. "Replace"
 * restores exactly the backup either way.
 */

import { openField, recordBinding, sealField, sha256Hex } from "./vault-crypto";
import type { StoredTombstones, TombstoneSet } from "./db";

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

const BINDING = recordBinding("tombstones");

/** Only well-formed records: a planted or damaged list can't smuggle in anything else. */
function validList(value: unknown): Tombstone[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (t): t is Tombstone =>
        !!t &&
        typeof t === "object" &&
        typeof (t as Tombstone).k === "string" &&
        /^[0-9a-f]{64}$/.test((t as Tombstone).k) &&
        Number.isFinite((t as Tombstone).at),
    )
    .map((t) => ({ k: t.k, at: t.at }));
}

/**
 * The deletion records as stored: sealed under the vault key when a password
 * is set, plain otherwise. Throws when sealed ones can't be decrypted. With a
 * key, plain ones are ignored: an encrypted vault always seals them, so plain
 * ones there were planted.
 */
export async function openTombstones(
  stored: StoredTombstones | undefined,
  key: CryptoKey | null,
): Promise<TombstoneSet> {
  let set: unknown = {};
  if (key) {
    if (stored?.sealed) set = JSON.parse(await openField(key, stored.sealed, BINDING));
  } else if (stored?.plain) {
    set = stored.plain;
  }
  const lists = (set ?? {}) as Record<string, unknown>;
  return {
    entries: mergeTombstones([validList(lists.entries)]),
    credentials: mergeTombstones([validList(lists.credentials)]),
  };
}

export async function sealTombstones(
  set: TombstoneSet,
  key: CryptoKey | null,
): Promise<StoredTombstones> {
  return key ? { sealed: await sealField(key, JSON.stringify(set), BINDING) } : { plain: set };
}
