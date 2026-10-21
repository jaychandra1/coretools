/**
 * 2FA account records: building new ones and their on-disk form. The
 * vault store (components/authenticator/store.svelte.ts) owns the key and
 * the in-memory secrets; these helpers are pure apart from encryption.
 */

import type { StoredEntry, VaultConfig } from "./db";
import { otpParamsError, type ParsedAccount } from "./types";
import { encryptString, importVaultKey, sealField, VERIFIER_PLAINTEXT } from "./vault-crypto";
import { generateDataKey, wrapDataKey } from "./vault-keys";
import { plain } from "../idb";

/**
 * A new account record from parsed (or restored) fields. Its `secret` is
 * left empty: the caller stores it plain or encrypted, depending on the vault.
 */
export async function newEntry(
  account: Pick<
    ParsedAccount,
    "issuer" | "account" | "type" | "algorithm" | "digits" | "period" | "counter"
  >,
  secret: string,
  index: number,
  addedAt: number,
  pinned = false,
): Promise<StoredEntry> {
  if (!secret) throw new Error("Missing secret");
  const problem = otpParamsError(account);
  if (problem) throw new Error(problem);
  return {
    id: crypto.randomUUID(),
    issuer: account.issuer.trim(),
    account: account.account.trim(),
    type: account.type,
    algorithm: account.algorithm,
    digits: account.digits,
    period: account.period,
    counter: account.counter,
    index,
    pinned,
    addedAt,
    secret: {},
  };
}

/** The next free display index after `entries`. */
export function nextIndex(entries: readonly Pick<StoredEntry, "index">[]): number {
  return entries.reduce((max, e) => Math.max(max, e.index), -1) + 1;
}

/** The on-disk form: with a key, the names are sealed (F-14). */
export async function sealEntry(entry: StoredEntry, key: CryptoKey | null): Promise<StoredEntry> {
  const copy = plain(entry);
  delete copy.hash; // see OtpEntry.hash (L3)
  if (!key) {
    delete copy.meta;
    return copy;
  }
  const meta = await sealField(key, JSON.stringify({ issuer: copy.issuer, account: copy.account }), {
    kind: "entry",
    id: copy.id,
    field: "meta",
  });
  return { ...copy, issuer: "", account: "", meta };
}

/** An entry's secret as stored in an encrypted vault, bound to the entry (L2). */
export function sealEntrySecret(key: CryptoKey, id: string, secret: string) {
  return sealField(key, secret, { kind: "entry", id, field: "secret" });
}

/** An entry's decrypted secret; every unlocked entry has one. */
export function requireSecret(
  secrets: ReadonlyMap<string, string>,
  entry: Pick<StoredEntry, "id" | "issuer">,
): string {
  const secret = secrets.get(entry.id);
  if (!secret) throw new Error(`Missing secret for ${entry.issuer}`);
  return secret;
}

export interface SealedVault {
  key: CryptoKey;
  vault: VaultConfig;
  /** As written to IndexedDB (names sealed). */
  stored: StoredEntry[];
  /** In-memory form (names in clear). */
  view: StoredEntry[];
}

/**
 * A fresh vault for `password`: a new random data key wrapped under it
 * (Argon2id, vault-keys.ts), its verifier, and `entries` re-encrypted under
 * the new key with their secrets from `secrets`. Touches no state: the
 * caller persists it in one transaction and only then switches over.
 */
export async function sealVault(
  password: string,
  entries: readonly StoredEntry[],
  secrets: ReadonlyMap<string, string>,
): Promise<SealedVault> {
  const raw = generateDataKey();
  let key: CryptoKey;
  let wrapped: Awaited<ReturnType<typeof wrapDataKey>>;
  try {
    wrapped = await wrapDataKey(password, raw);
    key = await importVaultKey(raw);
  } finally {
    raw.fill(0);
  }
  const verifier = await encryptString(key, VERIFIER_PLAINTEXT);

  const stored: StoredEntry[] = [];
  const view: StoredEntry[] = [];
  for (const entry of entries) {
    const withSecret: StoredEntry = {
      ...plain(entry),
      secret: { enc: await sealEntrySecret(key, entry.id, requireSecret(secrets, entry)) },
    };
    const sealed = await sealEntry(withSecret, key);
    stored.push(sealed);
    view.push({ ...sealed, issuer: withSecret.issuer, account: withSecret.account });
  }
  return {
    key,
    vault: {
      encrypted: true,
      kdf: wrapped.kdf,
      salt: wrapped.salt,
      wrappedKey: wrapped.wrappedKey,
      verifier,
      passwordCheckedAt: Date.now(),
    },
    stored,
    view,
  };
}
