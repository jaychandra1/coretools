import { describe, it, expect, beforeAll } from "vitest";
import { openChain, sealEvents, sealHead, type ChainCrypto } from "./audit-chain";
import { AUDIT_LIMIT, type AuditEvent, type StoredAuditEvent } from "./types";
import { decryptString, encryptString, importVaultKey, randomBytes } from "../authenticator/vault-crypto";

let crypto: ChainCrypto;
let otherCrypto: ChainCrypto;

beforeAll(async () => {
  const key = await importVaultKey(randomBytes(32));
  const other = await importVaultKey(randomBytes(32));
  crypto = {
    encrypt: (plain, aad) => encryptString(key, plain, aad),
    decrypt: (blob, aad) => decryptString(key, blob, aad),
  };
  otherCrypto = {
    encrypt: (plain, aad) => encryptString(other, plain, aad),
    decrypt: (blob, aad) => decryptString(other, blob, aad),
  };
});

function event(i: number): AuditEvent {
  return {
    id: `e${i}`,
    at: 1_760_000_000_000 + i,
    action: i % 2 ? "revealed" : "created",
    credentialId: `c${i}`,
    platform: `Platform ${i}`,
  };
}

async function chainOf(n: number) {
  const { records, head } = await sealEvents(
    Array.from({ length: n }, (_, i) => event(i)),
    null,
    crypto,
  );
  return { records, sealedHead: await sealHead(head, crypto), head };
}

describe("audit chain", () => {
  it("round-trips and verifies, newest first", async () => {
    const { records, sealedHead } = await chainOf(5);
    expect(JSON.stringify(records)).not.toContain("Platform");
    const { events, status } = await openChain(records, sealedHead, crypto);
    expect(status).toMatchObject({ state: "verified", count: 5 });
    expect(events.map((e) => e.id)).toEqual(["e4", "e3", "e2", "e1", "e0"]);
    expect(events[0]).toEqual(event(4));
  });

  it("extends an existing chain", async () => {
    const first = await sealEvents([event(0), event(1)], null, crypto);
    const second = await sealEvents([event(2)], first.head, crypto);
    const records = [...first.records, ...second.records];
    const { status } = await openChain(records, await sealHead(second.head, crypto), crypto);
    expect(status).toMatchObject({ state: "verified", count: 3 });
  });

  it("detects an edited record", async () => {
    const { records, sealedHead } = await chainOf(3);
    const forged = (await sealEvents([{ ...event(1), platform: "Elsewhere" }], null, otherCrypto)).records[0];
    const tampered: StoredAuditEvent[] = records.map((r, i) => (i === 1 ? { ...r, sealed: forged.sealed } : r));
    expect((await openChain(tampered, sealedHead, crypto)).status.state).toBe("tampered");
  });

  it("detects a deleted middle record and dropped newest records", async () => {
    const { records, sealedHead } = await chainOf(4);
    const middle = records.filter((_, i) => i !== 1);
    expect((await openChain(middle, sealedHead, crypto)).status).toMatchObject({ state: "tampered" });
    const truncated = records.slice(0, 3);
    expect((await openChain(truncated, sealedHead, crypto)).status).toMatchObject({
      state: "tampered",
      reason: expect.stringMatching(/newest/),
    });
  });

  it("detects a re-timed record (the AAD binds id, time and position)", async () => {
    const { records, sealedHead } = await chainOf(3);
    const retimed = records.map((r, i) => (i === 2 ? { ...r, at: r.at - 60_000 } : r));
    expect((await openChain(retimed, sealedHead, crypto)).status.state).toBe("tampered");
  });

  it("stays verifiable after the oldest records are pruned", async () => {
    // Pruning always keeps exactly AUDIT_LIMIT records.
    const { records, sealedHead } = await chainOf(AUDIT_LIMIT + 2);
    const { status } = await openChain(records.slice(2), sealedHead, crypto);
    expect(status).toMatchObject({ state: "verified", count: AUDIT_LIMIT });
  }, 60_000); // seals and opens ~AUDIT_LIMIT records: slow when the suite runs in parallel

  it("notices the oldest records of a short log were deleted", async () => {
    const { records, sealedHead } = await chainOf(6);
    const { status } = await openChain(records.slice(2), sealedHead, crypto);
    expect(status).toMatchObject({ state: "tampered", reason: "the oldest records were removed" });
  });

  it("refuses a log sealed under another key, and plaintext records", async () => {
    const { records, sealedHead } = await chainOf(2);
    expect((await openChain(records, sealedHead, otherCrypto)).status.state).toBe("tampered");
    const legacy: StoredAuditEvent[] = [{ id: "x", at: 1, action: "created", credentialId: "c", platform: "P" }];
    expect((await openChain(legacy, null, crypto)).status.state).toBe("tampered");
  });

  it("treats an empty log as verified, unless the head says records existed", async () => {
    expect((await openChain([], null, crypto)).status).toMatchObject({ state: "verified", count: 0 });
    const { sealedHead } = await chainOf(2);
    expect((await openChain([], sealedHead, crypto)).status.state).toBe("tampered");
  });
});
