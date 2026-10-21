/**
 * The contract between the vault (store.svelte.ts) and the collections that
 * live in it: the events it emits, the crypto it hands out, and the hooks the
 * Credential Manager implements so it takes part in every vault-wide
 * operation (password change, restore, wipe).
 */

import type { StoredAuditHead } from "../../core/authenticator/db";
import {
  decryptString,
  encryptString,
  openField,
  sealField,
  type EncryptedBlob,
  type FieldBinding,
} from "../../core/authenticator/vault-crypto";
import type { Tombstone } from "../../core/authenticator/tombstones";
import type {
  BackupCredential,
  StoredAuditEvent,
  StoredCredential,
} from "../../core/credentials/types";

/**
 * Lifecycle notifications for observers such as the cloud backup:
 *  - "change": 2FA entries were added/edited/removed/reordered (persisted);
 *  - "credentials": Credential Manager records changed (persisted);
 *  - "unlock": the vault key is available again;
 *  - "password": how the password protects the vault changed (new password,
 *    or the KDF upgrade) — every backup series needs a fresh copy;
 *  - "lock": the vault key was dropped;
 *  - "wipe": everything local was deleted;
 *  - "reload": the vault was read again from disk — another window changed
 *    it, or a snapshot was restored (D-1). It stays unlocked when its key is
 *    unchanged; otherwise "lock" came first.
 */
export type AuthEvent =
  | "change"
  | "credentials"
  | "unlock"
  | "password"
  | "lock"
  | "wipe"
  | "reload";

export interface RestoreResult {
  /** The restore included 2FA accounts (the counts below apply). */
  restoredAccounts: boolean;
  added: number;
  /** Accounts here that took a newer state from the backup (an HOTP counter, D-3). */
  updated: number;
  skipped: number;
  /** Accounts removed here because the backup recorded their deletion (F-09). */
  removed: number;
  /** The restore included Credential Manager records. */
  restoredCredentials: boolean;
  credentialsAdded: number;
  /** Logins here replaced by a newer copy from the backup (D-3). */
  credentialsUpdated: number;
  credentialsSkipped: number;
  credentialsRemoved: number;
}

type Decrypt = (blob: EncryptedBlob) => Promise<string>;
type Encrypt = (plaintext: string) => Promise<EncryptedBlob>;

/** Encryption under one specific key, handed to collections for vault-wide work. */
export interface VaultCrypto {
  /** Unbound blobs (opening older single records; new ones are sealed bound). */
  encrypt: Encrypt;
  decrypt: Decrypt;
  /** A record's field, or a single record (recordBinding), bound to where it lives (audit L2). */
  seal(plaintext: string, binding: FieldBinding): Promise<EncryptedBlob>;
  open(blob: EncryptedBlob, binding: FieldBinding): Promise<string>;
  /** AES-GCM with additional authenticated data (the audit chain binds positions). */
  encryptAad(plaintext: string, aad: Uint8Array): Promise<EncryptedBlob>;
  decryptAad(blob: EncryptedBlob, aad: Uint8Array): Promise<string>;
}

export function cryptoFor(key: CryptoKey): VaultCrypto {
  return {
    encrypt: (plain) => encryptString(key, plain),
    decrypt: (blob) => decryptString(key, blob),
    seal: (plain, binding) => sealField(key, plain, binding),
    open: (blob, binding) => openField(key, blob, binding),
    encryptAad: (plain, aad) => encryptString(key, plain, aad),
    decryptAad: (blob, aad) => decryptString(key, blob, aad),
  };
}

/** Shown by the UI when the user has to confirm it's them; null = canceled. */
export type PasswordPrompt = () => Promise<string | null>;

/** A collection's full state after a vault-wide operation, ready to persist. */
export interface CredentialSnapshot {
  /** As written to IndexedDB (metadata sealed). */
  stored: StoredCredential[];
  /** In-memory form (metadata decrypted). */
  view: StoredCredential[];
  /** The audit log re-sealed to match, when it changed. */
  audit?: { records: StoredAuditEvent[]; head: StoredAuditHead | null };
  /** Other sealed meta records re-keyed with it (e.g. the space-tab order). */
  meta?: Record<string, unknown>;
}

/**
 * How the Credential Manager takes part in vault-wide operations. The vault
 * owns the key; the credential store owns its records. Every operation that
 * changes the key or replaces data asks it for the records to persist, and
 * writes them in the SAME transaction as the vault itself.
 */
export interface CredentialVaultHooks {
  /** Resolves once the records are loaded; awaited before any hook below. */
  ready(): Promise<void>;
  count(): number;
  /** The vault is being unlocked: decrypt metadata into memory. */
  open(crypto: VaultCrypto): Promise<void>;
  /** The vault locked: drop decrypted metadata from memory. */
  close(): void;
  /** Plaintext of every credential (incl. trash) for the cloud backup. */
  exportPlain(crypto: VaultCrypto): Promise<BackupCredential[]>;
  /** Every credential and the audit log re-encrypted under a new key. */
  reseal(from: VaultCrypto, to: VaultCrypto): Promise<CredentialSnapshot>;
  /** Records after restoring backup credentials (merge or replace). */
  restore(
    items: BackupCredential[],
    mode: "merge" | "replace",
    crypto: VaultCrypto,
    tombstones: { local: Tombstone[]; remote: Tombstone[] },
  ): Promise<
    CredentialSnapshot & {
      added: number;
      updated: number;
      skipped: number;
      removed: number;
      revived: string[];
    }
  >;
  /**
   * The records on disk changed (another window, a snapshot restore): read
   * them again (D-1) — and decrypt them with `crypto` when the vault stays
   * unlocked, or leave them locked when it is null. Never waits for the
   * vault's own reload (it runs inside it).
   */
  reload(crypto: VaultCrypto | null): Promise<void>;
  /** The snapshot was persisted — make it the in-memory state. */
  adopt(snapshot: CredentialSnapshot): void;
  /** Everything was wiped. */
  clear(): void;
}
