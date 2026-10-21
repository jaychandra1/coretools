/**
 * The 2FA-account half of restoring a backup, worked out in memory before
 * anything is written (the vault store persists it in one transaction):
 * which accounts stay, which are added, which take a newer HOTP counter,
 * and the deletion records afterwards. Pure apart from hashing identities
 * and minting ids for new records; no key involved.
 */

import type { StoredEntry } from "./db";
import type { ExportableEntry } from "./backup";
import { accountKey } from "./backup";
import { normalizeBase32 } from "./base32";
import { newEntry, nextIndex, requireSecret } from "./entries";
import { planMerge } from "./merge";
import { mergeTombstones, withoutKeys, type Tombstone } from "./tombstones";
import { plain } from "../idb";

export interface EntryRestoreInput {
  mode: "merge" | "replace";
  /** The accounts here now (decrypted names) and their secrets. */
  entries: readonly StoredEntry[];
  secrets: ReadonlyMap<string, string>;
  /** The backup's accounts; null = this restore doesn't touch accounts. */
  incoming: readonly ExportableEntry[] | null;
  tombstones: { local: readonly Tombstone[]; remote: readonly Tombstone[] };
  now: number;
}

export interface EntryRestorePlan {
  /** Every account after the restore (kept ones first), secrets not yet stored. */
  all: StoredEntry[];
  /** Their secrets, by id. */
  secrets: Map<string, string>;
  /** The accounts' deletion records after the restore. */
  tombstones: Tombstone[];
  added: number;
  updated: number;
  removed: number;
  skipped: number;
}

export async function planEntryRestore(input: EntryRestoreInput): Promise<EntryRestorePlan> {
  const touch = input.incoming !== null;
  // Accounts this restore doesn't replace stay, with their secrets.
  const secrets = new Map<string, string>();
  const local: StoredEntry[] = [];
  if (!touch || input.mode === "merge") {
    for (const entry of input.entries) {
      secrets.set(entry.id, requireSecret(input.secrets, entry));
      local.push(plain(entry));
    }
  }
  const plan = touch
    ? await planMerge({
        mode: input.mode,
        local,
        incoming: [...(input.incoming ?? [])].sort((a, b) => a.index - b.index),
        localKey: (entry) =>
          accountKey({ secret: secrets.get(entry.id) ?? "", issuer: entry.issuer, account: entry.account }),
        incomingKey: accountKey,
        // A deletion elsewhere wins only if it came after this device added the account.
        changedAt: (entry) => entry.addedAt ?? 0,
        // The same account: only an HOTP counter can be ahead elsewhere (D-3).
        isNewer: (here, there) => here.type === "hotp" && there.counter > here.counter,
        tombstones: input.tombstones,
      })
    : { kept: local, added: [], updated: [], removed: 0, skipped: 0, revived: [] };

  for (const [here, there] of plan.updated) here.counter = there.counter;
  const keptIds = new Set(plan.kept.map((entry) => entry.id));
  for (const id of secrets.keys()) if (!keptIds.has(id)) secrets.delete(id);

  let index = nextIndex(plan.kept);
  const created: StoredEntry[] = [];
  for (const item of plan.added) {
    const secret = normalizeBase32(item.secret);
    const entry = await newEntry(item, secret, index++, input.now, item.pinned);
    secrets.set(entry.id, secret);
    created.push(entry);
  }

  return {
    all: [...plan.kept, ...created],
    secrets,
    tombstones: touch
      ? withoutKeys(
          mergeTombstones([input.tombstones.local, input.tombstones.remote], input.now),
          new Set(plan.revived),
        )
      : [...input.tombstones.local],
    added: created.length,
    updated: plan.updated.length,
    removed: plan.removed,
    skipped: plan.skipped,
  };
}
