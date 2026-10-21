/**
 * The record-level rules of restoring a backup, shared by 2FA accounts and
 * Credential Manager logins. Records are matched by identity (`accountKey`,
 * `credentialKey`); deletions travel as tombstones (tombstones.ts, F-09).
 *
 *  - "merge": local records stay, except those another device deleted after
 *    they last changed here (remote tombstone newer than the record); backup
 *    records are added unless one with the same identity is already here or
 *    this device deleted that identity (local tombstone). When one is here
 *    and the backup's copy is newer (`isNewer`), the local record takes the
 *    backup's content — last writer wins, so a merge never brings back an
 *    older password (audit D-3).
 *  - "replace": the result is exactly the backup's records.
 *
 * Pure apart from hashing identities; the caller turns `added` into stored
 * records and persists everything in one transaction.
 */

import { tombstoneKey, type Tombstone } from "./tombstones";

export interface MergeInput<Local, Incoming> {
  mode: "merge" | "replace";
  local: readonly Local[];
  incoming: readonly Incoming[];
  localKey: (record: Local) => string;
  incomingKey: (record: Incoming) => string;
  /** When a local record last changed here: a remote deletion must be newer. */
  changedAt: (record: Local) => number;
  /** The backup's copy of a record that is already here is newer than this one. */
  isNewer?: (here: Local, there: Incoming) => boolean;
  /** Deletions recorded on this device and in the backup. */
  tombstones: { local: readonly Tombstone[]; remote: readonly Tombstone[] };
}

export interface MergePlan<Local, Incoming> {
  /** Local records that stay. */
  kept: Local[];
  /** Backup records to add, in backup order. */
  added: Incoming[];
  /** Local records whose backup copy is newer: [here, there]. */
  updated: Array<[Local, Incoming]>;
  /** Local records dropped because another device deleted them. */
  removed: number;
  /** Backup records not added: already here, or deleted here. */
  skipped: number;
  /** Tombstone keys of the added records: they are no longer deleted. */
  revived: string[];
}

export async function planMerge<Local, Incoming>(
  input: MergeInput<Local, Incoming>,
): Promise<MergePlan<Local, Incoming>> {
  const merging = input.mode === "merge";
  let kept = merging ? [...input.local] : [];

  let removed = 0;
  if (merging && input.tombstones.remote.length) {
    const deletedAt = new Map(input.tombstones.remote.map((t) => [t.k, t.at]));
    const survivors: Local[] = [];
    for (const record of kept) {
      const at = deletedAt.get(await tombstoneKey(input.localKey(record)));
      if (at !== undefined && input.changedAt(record) < at) removed++;
      else survivors.push(record);
    }
    kept = survivors;
  }

  const byKey = new Map(kept.map((record) => [input.localKey(record), record]));
  const seen = new Set(byKey.keys());
  const deletedHere = new Set(merging ? input.tombstones.local.map((t) => t.k) : []);
  const added: Incoming[] = [];
  const updated: Array<[Local, Incoming]> = [];
  const revived: string[] = [];
  let skipped = 0;
  for (const item of input.incoming) {
    const key = input.incomingKey(item);
    if (seen.has(key)) {
      const here = byKey.get(key);
      if (here && input.isNewer?.(here, item) && !updated.some(([h]) => h === here)) {
        updated.push([here, item]);
      } else {
        skipped++;
      }
      continue;
    }
    const k = await tombstoneKey(key);
    if (deletedHere.has(k)) {
      skipped++; // deleted on this device — a merge doesn't bring it back
      continue;
    }
    seen.add(key);
    revived.push(k);
    added.push(item);
  }
  return { kept, added, updated, removed, skipped, revived };
}
