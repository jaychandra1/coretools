import { describe, expect, it } from "vitest";
import { newEntry, nextIndex, requireSecret, sealEntry, sealVault } from "./entries";
import {
  decryptString,
  importVaultKey,
  openField,
  randomBytes,
  recordBinding,
  sealField,
  VERIFIER_PLAINTEXT,
} from "./vault-crypto";
import { unwrapDataKey } from "./vault-keys";
import { openTombstones, sealTombstones } from "./tombstones";

const ACCOUNT = {
  issuer: "  Example ",
  account: " me@example.com ",
  type: "totp" as const,
  algorithm: "SHA1" as const,
  digits: 6,
  period: 30,
  counter: 0,
};

describe("entries", () => {
  it("builds a record with trimmed names and an empty secret", async () => {
    const entry = await newEntry(ACCOUNT, "JBSWY3DPEHPK3PXP", 4, 1000, true);
    expect(entry).toMatchObject({
      issuer: "Example",
      account: "me@example.com",
      index: 4,
      addedAt: 1000,
      pinned: true,
      secret: {},
    });
    // No unsalted hash of the secret is stored any more (L3).
    expect(entry.hash).toBeUndefined();
  });

  it("refuses OTP parameters that can't make codes (S-10)", async () => {
    await expect(newEntry({ ...ACCOUNT, digits: 200_000_000 }, "S", 0, 0)).rejects.toThrow(/digits/);
    await expect(newEntry({ ...ACCOUNT, period: 0.5 }, "S", 0, 0)).rejects.toThrow(/period/);
  });

  it("finds the next free index", () => {
    expect(nextIndex([])).toBe(0);
    expect(nextIndex([{ index: 3 }, { index: 1 }])).toBe(4);
  });

  it("requires a secret for every entry", () => {
    expect(requireSecret(new Map([["a", "S"]]), { id: "a", issuer: "X" })).toBe("S");
    expect(() => requireSecret(new Map(), { id: "b", issuer: "X" })).toThrow(/Missing secret for X/);
  });

  it("seals names under a key and leaves them clear without one", async () => {
    const key = await importVaultKey(randomBytes(32));
    const entry = { ...(await newEntry(ACCOUNT, "S", 0, 0)), meta: { iv: "x", ct: "y" } };
    const sealed = await sealEntry(entry, key);
    expect(sealed.issuer).toBe("");
    // Bound to its record: another record's id doesn't open it (L2).
    await expect(openField(key, sealed.meta!, { kind: "entry", id: "other", field: "meta" })).rejects.toThrow();
    expect(JSON.parse(await openField(key, sealed.meta!, { kind: "entry", id: entry.id, field: "meta" }))).toEqual({
      issuer: "Example",
      account: "me@example.com",
    });
    const clear = await sealEntry(entry, null);
    expect(clear.meta).toBeUndefined();
    expect(clear.issuer).toBe("Example");
  });

  it("seals a fresh vault the password unlocks", async () => {
    const entry = await newEntry(ACCOUNT, "JBSWY3DPEHPK3PXP", 0, 0);
    const sealed = await sealVault("correct horse battery", [entry], new Map([[entry.id, "JBSWY3DPEHPK3PXP"]]));
    const raw = await unwrapDataKey("correct horse battery", {
      kdf: sealed.vault.kdf!,
      salt: sealed.vault.salt!,
      wrappedKey: sealed.vault.wrappedKey!,
    });
    const key = await importVaultKey(raw);
    expect(await decryptString(key, sealed.vault.verifier!)).toBe(VERIFIER_PLAINTEXT);
    expect(
      await openField(key, sealed.stored[0].secret.enc!, { kind: "entry", id: entry.id, field: "secret" }),
    ).toBe("JBSWY3DPEHPK3PXP");
    expect(sealed.stored[0].issuer).toBe("");
    expect(sealed.view[0].issuer).toBe("Example");
  }, 30_000);
});

describe("tombstone sets", () => {
  it("round-trips sealed and plain", async () => {
    const key = await importVaultKey(randomBytes(32));
    const set = { entries: [{ k: "a".repeat(64), at: Date.now() }], credentials: [] };
    expect(await openTombstones(await sealTombstones(set, key), key)).toEqual(set);
    expect(await openTombstones(await sealTombstones(set, null), null)).toEqual(set);
    expect(await openTombstones(undefined, key)).toEqual({ entries: [], credentials: [] });
  });

  it("drops malformed records and refuses another sealed record in their place", async () => {
    const key = await importVaultKey(randomBytes(32));
    const planted = {
      plain: {
        entries: [{ k: "not-a-hash", at: 1 }, { k: "b".repeat(64), at: "soon" }, null],
        credentials: "everything",
      },
    } as unknown as Parameters<typeof openTombstones>[0];
    expect(await openTombstones(planted, null)).toEqual({ entries: [], credentials: [] });
    // A blob sealed for another record (here: bound as the settings) doesn't open as tombstones.
    const other = await sealField(key, JSON.stringify({ entries: [], credentials: [] }), recordBinding("settings"));
    await expect(openTombstones({ sealed: other }, key)).rejects.toThrow();
  });

  it("throws when sealed records can't be decrypted", async () => {
    const sealed = await sealTombstones({ entries: [], credentials: [] }, await importVaultKey(randomBytes(32)));
    await expect(openTombstones(sealed, await importVaultKey(randomBytes(32)))).rejects.toThrow();
  });
});
