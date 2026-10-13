/**
 * Tamper-evident audit log (audit F-19).
 *
 * Each record's content is AES-GCM-sealed under the vault key with its
 * position bound in as additional data, and each record names the SHA-256
 * of the previous record's ciphertext. A sealed head record (meta
 * "auditHead") names the newest position and hash. So, without the vault
 * key, nobody can:
 *  - edit a record (its GCM tag fails),
 *  - move, renumber or splice records (the AAD and the `prev` links fail),
 *  - drop the newest records (the head no longer matches).
 * What cannot be prevented on a device the attacker fully controls is
 * deleting the whole log, or rolling log + head back together to an older
 * copy; verification reports what it can prove and nothing more.
 *
 * Pruning drops the oldest records beyond AUDIT_LIMIT; the chain is then
 * verified from the oldest record kept.
 */

import type { AuditAction, AuditEvent, StoredAuditEvent } from "./types";
import type { EncryptedBlob } from "../authenticator/vault-crypto";
import { sha256Hex } from "../authenticator/vault-crypto";

export interface ChainCrypto {
  encrypt(plaintext: string, aad: Uint8Array): Promise<EncryptedBlob>;
  decrypt(blob: EncryptedBlob, aad: Uint8Array): Promise<string>;
}

/** The newest position and hash, as sealed into meta "auditHead". */
export interface ChainHead {
  seq: number;
  hash: string;
}

export type ChainStatus =
  | { state: "verified"; count: number; head: ChainHead | null }
  | { state: "tampered"; reason: string; count: number };

const HEAD_AAD = new TextEncoder().encode("coretools-audit-head-v1");

function aadFor(record: { id: string; at: number; seq: number; prev: string }): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(["coretools-audit-v1", record.id, record.at, record.seq, record.prev]),
  );
}

export function hashOf(record: StoredAuditEvent): Promise<string> {
  return sha256Hex(record.sealed?.ct ?? "");
}

/** Seal `events` (oldest first) after `head`. Returns the records and the new head. */
export async function sealEvents(
  events: AuditEvent[],
  head: ChainHead | null,
  crypto: ChainCrypto,
): Promise<{ records: StoredAuditEvent[]; head: ChainHead }> {
  let seq = head ? head.seq + 1 : 0;
  let prev = head?.hash ?? "";
  const records: StoredAuditEvent[] = [];
  for (const event of events) {
    const base = { id: event.id, at: event.at, seq, prev };
    const sealed = await crypto.encrypt(
      JSON.stringify({
        action: event.action,
        credentialId: event.credentialId,
        platform: event.platform,
      }),
      aadFor(base),
    );
    const record: StoredAuditEvent = { ...base, sealed };
    records.push(record);
    prev = await hashOf(record);
    seq++;
  }
  const last = records.at(-1);
  return {
    records,
    head: last ? { seq: last.seq ?? 0, hash: prev } : (head ?? { seq: -1, hash: "" }),
  };
}

export async function sealHead(head: ChainHead, crypto: ChainCrypto): Promise<EncryptedBlob> {
  return crypto.encrypt(JSON.stringify(head), HEAD_AAD);
}

export async function openHead(blob: EncryptedBlob, crypto: ChainCrypto): Promise<ChainHead> {
  const head = JSON.parse(await crypto.decrypt(blob, HEAD_AAD)) as ChainHead;
  if (!Number.isInteger(head.seq) || typeof head.hash !== "string") throw new Error("bad head");
  return head;
}

/**
 * Decrypt and verify the chain (records oldest first). Returns the events,
 * newest first, and what could be proven about them.
 */
export async function openChain(
  records: StoredAuditEvent[],
  sealedHead: EncryptedBlob | null,
  crypto: ChainCrypto,
): Promise<{ events: AuditEvent[]; status: ChainStatus }> {
  const chained = records.filter((r) => r.sealed && Number.isInteger(r.seq));
  const events: AuditEvent[] = [];
  const tampered = (reason: string) => ({
    events: events.slice().reverse(),
    status: { state: "tampered", reason, count: chained.length } as ChainStatus,
  });

  if (chained.length !== records.length) return tampered("unsealed records in the log");
  let head: ChainHead | null = null;
  if (sealedHead) {
    try {
      head = await openHead(sealedHead, crypto);
    } catch {
      return tampered("the log's head record was modified");
    }
  }
  if (chained.length === 0) {
    return head && head.seq >= 0
      ? tampered("records were deleted")
      : { events, status: { state: "verified", count: 0, head } };
  }

  let previous: StoredAuditEvent | null = null;
  for (const record of chained) {
    const seq = record.seq as number;
    const prev = record.prev ?? "";
    if (previous) {
      if (seq !== (previous.seq as number) + 1) return tampered("records are missing or out of order");
      if (prev !== (await hashOf(previous))) return tampered("a record was replaced");
    } else if (seq === 0 && prev !== "") {
      return tampered("the first record was replaced");
    }
    let content: { action: AuditAction; credentialId: string; platform: string };
    try {
      content = JSON.parse(
        await crypto.decrypt(record.sealed as EncryptedBlob, aadFor({ id: record.id, at: record.at, seq, prev })),
      );
    } catch {
      return tampered("a record was modified");
    }
    events.push({ id: record.id, at: record.at, ...content });
    previous = record;
  }

  const last = chained[chained.length - 1];
  const lastHash = await hashOf(last);
  if (!head || head.seq !== last.seq || head.hash !== lastHash) {
    return tampered("the newest records were removed or replaced");
  }
  return {
    events: events.reverse(),
    status: { state: "verified", count: chained.length, head },
  };
}
