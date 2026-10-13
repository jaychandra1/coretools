/**
 * Reactive state for the vault and the Authenticator section (Svelte 5 runes).
 *
 * Owns the vault (encryption) lifecycle, the 2FA entries and the shared clock
 * every visible code ticks from. The data key and every decrypted value —
 * secrets, and with a password set the account names too (audit F-14) —
 * live ONLY in memory while unlocked; locking drops them.
 *
 * Key hierarchy (vault-keys.ts): a random data key encrypts everything; the
 * password only unwraps it, through Argon2id (F-06). Vaults from before 1.2
 * (PBKDF2, the data key being the KDF output) are upgraded on the next
 * password unlock without re-encrypting anything.
 *
 * Other collections (the Credential Manager) take part in every vault-wide
 * operation through registered hooks; registration happens explicitly at
 * bootstrap (src/lib/vault-bootstrap.ts), and an operation that would
 * re-key the vault refuses to run if stored credentials exist but their
 * collection isn't registered (F-18).
 */

import type { ParsedAccount } from "../../core/authenticator/types";
import {
  countCredentials,
  DEFAULT_SETTINGS,
  deleteEntry as dbDeleteEntry,
  loadEntries,
  loadSettings,
  loadTombstones,
  loadVaultConfig,
  NewerDataError,
  saveEntries,
  saveSettings,
  saveTombstones,
  saveVaultAndEntries,
  saveVaultConfig,
  wipeAll,
  type AuthSettings,
  type StoredAuditHead,
  type StoredEntry,
  type StoredTombstones,
  type TombstoneSet,
  type VaultConfig,
} from "../../core/authenticator/db";
import {
  decryptString,
  deriveWrappingKey,
  encryptString,
  importVaultKey,
  randomBytes,
  sha256Hex,
  unwrapKeyBytes,
  VERIFIER_PLAINTEXT,
  wrapKeyBytes,
  type EncryptedBlob,
} from "../../core/authenticator/vault-crypto";
import { deriveKeyBytes, LEGACY_PBKDF2_ITERATIONS } from "../../core/authenticator/kdf";
import { generateDataKey, unwrapDataKey, wrapDataKey } from "../../core/authenticator/vault-keys";
import { assessPassword } from "../../core/authenticator/password-strength";
import {
  mergeTombstones,
  tombstoneKey,
  withoutKeys,
  type Tombstone,
} from "../../core/authenticator/tombstones";
import { base64ToBytes, bytesToBase64 } from "../../core/authenticator/legacy-crypto";
import { normalizeBase32 } from "../../core/authenticator/base32";
import { moveInDisplayOrder } from "../../core/authenticator/order";
import { accountKey, type ExportableEntry } from "../../core/authenticator/backup";
import {
  openCloudBackup,
  sealCloudBackup,
  parseCloudBackup,
  type BackupKeyHeader,
  type CloudBackupDevice,
  type CloudBackupFile,
  type CloudBackupPayload,
  type RestoreParts,
} from "../../core/authenticator/cloud-backup";
import type { BackupKind } from "../../core/authenticator/cloud-sync";
import type {
  BackupCredential,
  StoredAuditEvent,
  StoredCredential,
} from "../../core/credentials/types";
import { getPlatform } from "../../platform";

/** Windows Hello unlock needs the master password typed at least this often (F-20). */
export const HELLO_PASSWORD_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Lifecycle notifications for observers such as the cloud backup:
 *  - "change": 2FA entries were added/edited/removed/reordered (persisted);
 *  - "credentials": Credential Manager records changed (persisted);
 *  - "unlock": the vault key is available again;
 *  - "password": how the password protects the vault changed (new password,
 *    or the KDF upgrade) — every backup series needs a fresh copy;
 *  - "lock": the vault key was dropped;
 *  - "wipe": everything local was deleted.
 */
export type AuthEvent = "change" | "credentials" | "unlock" | "password" | "lock" | "wipe";

export interface RestoreResult {
  /** The restore included 2FA accounts (the counts below apply). */
  restoredAccounts: boolean;
  added: number;
  skipped: number;
  /** Accounts removed here because the backup recorded their deletion (F-09). */
  removed: number;
  /** The restore included Credential Manager records. */
  restoredCredentials: boolean;
  credentialsAdded: number;
  credentialsSkipped: number;
  credentialsRemoved: number;
}

type Decrypt = (blob: EncryptedBlob) => Promise<string>;
type Encrypt = (plaintext: string) => Promise<EncryptedBlob>;

/** Encryption under one specific key, handed to collections for vault-wide work. */
export interface VaultCrypto {
  encrypt: Encrypt;
  decrypt: Decrypt;
  /** AES-GCM with additional authenticated data (the audit chain binds positions). */
  encryptAad(plaintext: string, aad: Uint8Array): Promise<EncryptedBlob>;
  decryptAad(blob: EncryptedBlob, aad: Uint8Array): Promise<string>;
}

/** A collection's full state after a vault-wide operation, ready to persist. */
export interface CredentialSnapshot {
  /** As written to IndexedDB (metadata sealed). */
  stored: StoredCredential[];
  /** In-memory form (metadata decrypted). */
  view: StoredCredential[];
  /** The audit log re-sealed to match, when it changed. */
  audit?: { records: StoredAuditEvent[]; head: StoredAuditHead | null };
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
  exportPlain(decrypt: Decrypt): Promise<BackupCredential[]>;
  /** Every credential and the audit log re-encrypted under a new key. */
  reseal(from: VaultCrypto, to: VaultCrypto): Promise<CredentialSnapshot>;
  /** Records after restoring backup credentials (merge or replace). */
  restore(
    items: BackupCredential[],
    mode: "merge" | "replace",
    crypto: VaultCrypto,
    tombstones: { local: Tombstone[]; remote: Tombstone[] },
  ): Promise<
    CredentialSnapshot & { added: number; skipped: number; removed: number; revived: string[] }
  >;
  /** The snapshot was persisted — make it the in-memory state. */
  adopt(snapshot: CredentialSnapshot): void;
  /** Everything was wiped. */
  clear(): void;
}

function cryptoFor(key: CryptoKey): VaultCrypto {
  return {
    encrypt: (plain) => encryptString(key, plain),
    decrypt: (blob) => decryptString(key, blob),
    encryptAad: (plain, aad) => encryptString(key, plain, aad),
    decryptAad: (blob, aad) => decryptString(key, blob, aad),
  };
}

const EMPTY_TOMBSTONES: TombstoneSet = { entries: [], credentials: [] };

export class AuthStore {
  ready = $state(false);
  locked = $state(false);
  entries = $state<StoredEntry[]>([]);
  vault = $state<VaultConfig | null>(null);
  settings = $state<AuthSettings>({ ...DEFAULT_SETTINGS });
  /** Shared wall clock (ms); one interval drives every countdown ring. */
  now = $state(Date.now());
  /** Whether the host offers OS-biometric unlock (Windows Hello). */
  helloSupported = $state(false);
  /**
   * Why the vault is currently locked. Drives the Hello-first flow: the
   * prompt auto-opens only for "initial" (app start) — never right after the
   * user deliberately locked ("manual") or the idle timer fired ("auto"),
   * where a system dialog popping up unrequested would be wrong.
   */
  lockReason = $state<"initial" | "manual" | "auto" | null>(null);
  /** The master password last typed is below the current policy (F-06). */
  weakPassword = $state(false);
  /** Why the local data couldn't be opened (e.g. made by a newer version, F-12). */
  loadError = $state<string | null>(null);

  #key: CryptoKey | null = null;
  #secrets = new Map<string, string>();
  #tombstones: TombstoneSet = { ...EMPTY_TOMBSTONES };
  #lastActivity = Date.now();
  #ticker: ReturnType<typeof setInterval> | null = null;
  #initPromise: Promise<void> | null = null;
  #credentials: CredentialVaultHooks | null = null;

  /** Called once, at bootstrap, by src/lib/vault-bootstrap.ts. */
  registerCredentials(hooks: CredentialVaultHooks): void {
    this.#credentials = hooks;
  }

  /** Encrypt with the vault key (Credential Manager). Requires unlocked + encrypted. */
  async encryptSecret(plaintext: string): Promise<EncryptedBlob> {
    if (this.locked || !this.#key) throw new Error("Unlock first");
    return encryptString(this.#key, plaintext);
  }

  /** Decrypt with the vault key (Credential Manager). Requires unlocked. */
  async decryptSecret(blob: EncryptedBlob): Promise<string> {
    if (this.locked || !this.#key) throw new Error("Unlock first");
    return decryptString(this.#key, blob);
  }

  /** The current key's crypto (audit chain). Requires unlocked + encrypted. */
  vaultCrypto(): VaultCrypto {
    if (this.locked || !this.#key) throw new Error("Unlock first");
    return cryptoFor(this.#key);
  }

  /** Credential Manager records changed: back up its series. */
  notifyCredentialsChange(): void {
    this.#emit("credentials");
  }
  #listeners = new Set<(event: AuthEvent) => void>();

  /** Observe lifecycle events; returns an unsubscribe function. */
  subscribe(listener: (event: AuthEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: AuthEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // An observer's failure must never break a vault operation.
      }
    }
  }

  get encrypted(): boolean {
    return this.vault?.encrypted === true;
  }

  /** Hello unlock is configured for this vault. */
  get helloEnabled(): boolean {
    return this.encrypted && !!this.vault?.hello;
  }

  /** Hello is configured but paused until the master password is typed (F-20). */
  get helloNeedsPassword(): boolean {
    const checked = this.vault?.passwordCheckedAt ?? 0;
    return this.helloEnabled && this.now - checked > HELLO_PASSWORD_INTERVAL_MS;
  }

  /** The lock screen should offer the Hello button. */
  get canUnlockWithHello(): boolean {
    return this.helloEnabled && this.helloSupported && !this.helloNeedsPassword;
  }

  /** Idempotent and safe to call concurrently (UI + cloud backup both do). */
  init(): Promise<void> {
    this.#initPromise ??= this.#init();
    return this.#initPromise;
  }

  async #init(): Promise<void> {
    let vault: VaultConfig | undefined;
    let settings: AuthSettings;
    let entries: StoredEntry[];
    try {
      [vault, settings, entries] = await Promise.all([
        loadVaultConfig(),
        loadSettings(),
        loadEntries(),
      ]);
    } catch (e) {
      // Leave `ready` false so nothing can write into a database we couldn't
      // open; the UI shows `loadError` instead.
      this.loadError =
        e instanceof NewerDataError
          ? e.message
          : "CoreTools couldn't open its local database. Restart the app; if it keeps happening, your data is still on disk — contact support before reinstalling.";
      return;
    }
    this.vault = vault ?? null;
    this.settings = settings;
    this.entries = entries;
    this.locked = this.encrypted; // locked on page load when a password is set
    this.lockReason = this.locked ? "initial" : null;

    if (!this.encrypted) {
      for (const entry of entries) {
        if (entry.secret.plain) this.#secrets.set(entry.id, entry.secret.plain);
      }
      this.#tombstones = await this.#loadTombstones(null);
    }
    this.ready = true;

    // The shared clock lives on the store, not on the Authenticator
    // component: the idle auto-lock must keep counting while the user is on
    // other tabs of the app, otherwise decrypted secrets would stay in
    // memory indefinitely once the section is left open in the background.
    this.#ticker ??= setInterval(() => this.tick(), 500);

    // Probe biometric availability in the background — never blocks startup,
    // and simply stays false in the browser build or when Hello isn't set up.
    getPlatform()
      .hello?.available()
      .then((ok) => (this.helloSupported = ok))
      .catch(() => {});
  }

  /** Stop the shared clock (tests; the app never tears the store down). */
  dispose(): void {
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = null;
  }

  /** Advance the shared clock; auto-lock after the configured idle time. */
  tick(): void {
    this.now = Date.now();
    const minutes = this.settings.autoLockMinutes;
    if (
      this.encrypted &&
      !this.locked &&
      minutes > 0 &&
      this.now - this.#lastActivity > minutes * 60_000
    ) {
      this.lock("auto");
    }
  }

  /** Record user activity (resets the auto-lock countdown). */
  touch(): void {
    this.#lastActivity = Date.now();
  }

  lock(reason: "manual" | "auto" = "manual"): void {
    this.#key = null;
    this.#secrets.clear();
    this.#tombstones = { ...EMPTY_TOMBSTONES };
    // Sealed names leave memory too; records not yet sealed keep theirs
    // (they are sealed on the next unlock).
    for (const entry of this.entries) {
      if (entry.meta) {
        entry.issuer = "";
        entry.account = "";
      }
    }
    this.#credentials?.close();
    this.locked = true;
    this.lockReason = reason;
    this.#emit("lock");
  }

  // ---- keys ---------------------------------------------------------------------

  /**
   * The data key for `password`, checked against the verifier. Throws
   * "Wrong password". `raw` must be zeroed by the caller.
   */
  async #dataKeyFromPassword(
    password: string,
  ): Promise<{ raw: Uint8Array; key: CryptoKey; legacy: boolean }> {
    const vault = this.vault;
    if (!vault?.encrypted || !vault.salt || !vault.verifier) {
      throw new Error("No encryption password is set");
    }
    let raw: Uint8Array;
    let legacy = false;
    if (vault.wrappedKey && vault.kdf) {
      try {
        raw = await unwrapDataKey(password, {
          kdf: vault.kdf,
          salt: vault.salt,
          wrappedKey: vault.wrappedKey,
        });
      } catch {
        throw new Error("Wrong password");
      }
    } else {
      raw = await deriveKeyBytes(password, vault.salt, {
        name: "PBKDF2-SHA256",
        iterations: vault.iterations ?? LEGACY_PBKDF2_ITERATIONS,
      });
      legacy = true;
    }
    const key = await importVaultKey(raw);
    let ok = false;
    try {
      ok = (await decryptString(key, vault.verifier)) === VERIFIER_PLAINTEXT;
    } catch {
      ok = false;
    }
    if (!ok) {
      raw.fill(0);
      throw new Error("Wrong password");
    }
    return { raw, key, legacy };
  }

  /**
   * Record a successful password entry, upgrading a pre-1.2 vault to the
   * Argon2id key hierarchy on the way (same data key, so nothing is
   * re-encrypted and Windows Hello keeps working). Returns whether it upgraded.
   */
  async #passwordConfirmed(password: string, raw: Uint8Array, legacy: boolean): Promise<boolean> {
    const vault = this.vault;
    if (!vault) return false;
    let next: VaultConfig = { ...($state.snapshot(vault) as VaultConfig), passwordCheckedAt: Date.now() };
    if (legacy) {
      const wrapped = await wrapDataKey(password, raw);
      const { iterations: _legacyIterations, ...rest } = next;
      next = { ...rest, kdf: wrapped.kdf, salt: wrapped.salt, wrappedKey: wrapped.wrappedKey };
    }
    await saveVaultConfig(next);
    this.vault = next;
    return legacy;
  }

  /** Decrypt everything needed in memory with `key` and enter the unlocked state. */
  async #finishUnlock(key: CryptoKey): Promise<void> {
    const secrets = new Map<string, string>();
    let unsealed = false;
    for (const entry of this.entries) {
      if (entry.secret.enc) {
        secrets.set(entry.id, await decryptString(key, entry.secret.enc));
      } else if (entry.secret.plain) {
        secrets.set(entry.id, entry.secret.plain);
      }
      if (entry.meta) {
        const names = JSON.parse(await decryptString(key, entry.meta)) as {
          issuer: string;
          account: string;
        };
        entry.issuer = names.issuer;
        entry.account = names.account;
      } else {
        unsealed = true;
      }
    }
    const tombstones = await this.#loadTombstones(key);
    await this.#credentials?.open(cryptoFor(key));

    this.#key = key;
    this.#secrets = secrets;
    this.#tombstones = tombstones;
    // F-14: seal the names of records written before 1.2.
    if (unsealed) await this.#saveEntries(this.entries);

    this.touch();
    this.locked = false;
    this.lockReason = null;
    this.#emit("unlock");
  }

  async unlock(password: string): Promise<void> {
    const { raw, key, legacy } = await this.#dataKeyFromPassword(password);
    let upgraded: boolean;
    try {
      upgraded = await this.#passwordConfirmed(password, raw, legacy);
    } finally {
      raw.fill(0);
    }
    this.weakPassword = !assessPassword(password).ok;
    await this.#finishUnlock(key);
    // New backups must carry the Argon2id header, not the old PBKDF2 one.
    if (upgraded) this.#emit("password");
  }

  /**
   * Unlock via Windows Hello: the OS-gated signature over the stored
   * challenge unwraps the data key. The password path stays untouched and
   * always works as a fallback — and is required at least every 14 days.
   */
  async unlockWithHello(): Promise<void> {
    const vault = this.vault;
    const hello = getPlatform().hello;
    if (!vault?.encrypted || !vault.hello || !vault.verifier || !hello) {
      throw new Error("Windows Hello unlock is not set up");
    }
    if (this.helloNeedsPassword) {
      throw new Error(
        "Enter your master password — CoreTools asks for it at least every 14 days so you don't forget it, then Windows Hello works again.",
      );
    }

    // Nothing below mutates any state until BOTH gates pass:
    //  1. the OS-verified Hello signature must unwrap the data key
    //     (AES-GCM authentication fails for any other signature), and
    //  2. the unwrapped key must decrypt the vault verifier.
    // A canceled or failed Hello prompt rejects inside sign() and the vault
    // stays locked; the password path is completely independent of this.
    const signature = await hello.sign(base64ToBytes(vault.hello.challenge));
    const wrappingKey = await deriveWrappingKey(signature);

    let key: CryptoKey;
    try {
      const raw = await unwrapKeyBytes(wrappingKey, vault.hello.wrapped);
      key = await importVaultKey(raw);
      raw.fill(0);
      if ((await decryptString(key, vault.verifier)) !== VERIFIER_PLAINTEXT) {
        throw new Error("verifier mismatch");
      }
    } catch {
      throw new Error(
        "Windows Hello could not unlock the vault. Unlock with your password and re-enable Hello in Settings.",
      );
    }
    await this.#finishUnlock(key);
  }

  /**
   * Enable Windows Hello unlock. Requires the current password, which
   * recovers the data key's bytes; they are wrapped under the Hello-signature
   * key and discarded.
   */
  async enableHello(password: string): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    const vault = this.vault;
    const hello = getPlatform().hello;
    if (!vault?.encrypted || !vault.salt) {
      throw new Error("Set an encryption password first");
    }
    if (!hello) throw new Error("Not available on this platform");
    const { raw, legacy } = await this.#dataKeyFromPassword(password); // throws on wrong password
    try {
      if (await this.#passwordConfirmed(password, raw, legacy)) this.#emit("password");
      const challenge = randomBytes(32);
      const signature = await hello.createKey(challenge);
      const wrappingKey = await deriveWrappingKey(signature);
      const wrapped = await wrapKeyBytes(wrappingKey, raw);
      const current = this.vault ?? vault;
      this.vault = {
        ...($state.snapshot(current) as VaultConfig),
        hello: { challenge: bytesToBase64(challenge), wrapped },
      };
      await saveVaultConfig(this.vault);
    } finally {
      raw.fill(0);
    }
    this.touch();
  }

  /** Disable Hello unlock and delete the native Hello key (best effort). */
  async disableHello(): Promise<void> {
    if (this.vault?.hello) {
      const { hello: _hello, ...rest } = this.vault;
      this.vault = rest;
      await saveVaultConfig(this.vault);
    }
    await getPlatform().hello?.deleteKey().catch(() => {});
  }

  /**
   * Drop a Hello configuration that no longer works (e.g. Windows recreated
   * the key after biometric re-enrollment). Safe to call while locked.
   */
  async clearStaleHello(): Promise<void> {
    await this.disableHello();
  }

  /**
   * Refuse to re-key the vault while stored credentials exist that no
   * registered collection could re-encrypt — they'd become unreadable (F-18).
   */
  async #requireCollections(): Promise<void> {
    if (!this.#credentials && (await countCredentials()) > 0) {
      throw new Error(
        "The Credential Manager isn't loaded, so its saved logins couldn't be re-encrypted. Nothing was changed — restart CoreTools and try again.",
      );
    }
  }

  // ---- entries --------------------------------------------------------------------

  /** Plaintext secret for an entry — null while locked. */
  secretOf(id: string): string | null {
    return this.#secrets.get(id) ?? null;
  }

  async #storedSecret(plaintext: string): Promise<StoredEntry["secret"]> {
    if (this.#key) return { enc: await encryptString(this.#key, plaintext) };
    return { plain: plaintext };
  }

  /** The on-disk form: with a key, the names are sealed (F-14). */
  async #toStored(entry: StoredEntry, key: CryptoKey | null): Promise<StoredEntry> {
    const plain = JSON.parse(JSON.stringify(entry)) as StoredEntry;
    if (!key) {
      delete plain.meta;
      return plain;
    }
    const meta = await encryptString(
      key,
      JSON.stringify({ issuer: plain.issuer, account: plain.account }),
    );
    return { ...plain, issuer: "", account: "", meta };
  }

  /** Persist entries, keeping each in-memory record's `meta` in step with disk. */
  async #saveEntries(entries: StoredEntry[]): Promise<void> {
    if (this.encrypted && !this.#key) throw new Error("Unlock first");
    const stored = await Promise.all(entries.map((e) => this.#toStored(e, this.#key)));
    await saveEntries(stored);
    entries.forEach((entry, i) => {
      if (stored[i].meta) entry.meta = stored[i].meta;
      else delete entry.meta;
    });
  }

  async #entryTombstoneKey(entry: StoredEntry): Promise<string> {
    return tombstoneKey(
      accountKey({
        secret: this.#secrets.get(entry.id) ?? "",
        issuer: entry.issuer,
        account: entry.account,
      }),
    );
  }

  /** Add parsed accounts as new entries. Caller pre-filters duplicates. */
  async addAccounts(accounts: ParsedAccount[]): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    let index = this.entries.reduce((max, e) => Math.max(max, e.index), -1) + 1;
    const created: StoredEntry[] = [];
    const now = Date.now();

    for (const account of accounts) {
      const secret = normalizeBase32(account.secret);
      const entry: StoredEntry = {
        id: crypto.randomUUID(),
        hash: await sha256Hex(secret),
        issuer: account.issuer.trim(),
        account: account.account.trim(),
        type: account.type,
        algorithm: account.algorithm,
        digits: account.digits,
        period: account.period,
        counter: account.counter,
        index: index++,
        pinned: false,
        addedAt: now,
        secret: await this.#storedSecret(secret),
      };
      this.#secrets.set(entry.id, secret);
      created.push(entry);
    }

    this.entries.push(...created);
    await this.#saveEntries(this.entries.slice(-created.length));
    // Re-adding something deleted earlier: it's no longer deleted.
    const revived = new Set(await Promise.all(created.map((e) => this.#entryTombstoneKey(e))));
    if (this.#tombstones.entries.some((t) => revived.has(t.k))) {
      this.#tombstones = {
        ...this.#tombstones,
        entries: withoutKeys(this.#tombstones.entries, revived),
      };
      await this.#saveTombstones();
    }
    if (!this.vault) {
      // Record the (implicit) "no password" choice; the warning banner stays.
      this.vault = { encrypted: false };
      await saveVaultConfig({ encrypted: false });
    }
    this.#emit("change");
  }

  async rename(id: string, issuer: string, account: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.issuer = issuer.trim();
    entry.account = account.trim();
    await this.#saveEntries([entry]);
    this.#emit("change");
  }

  async remove(id: string): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    const k = await this.#entryTombstoneKey(entry);
    this.entries = this.entries.filter((e) => e.id !== id);
    this.#secrets.delete(id);
    await dbDeleteEntry(id);
    this.#tombstones = {
      ...this.#tombstones,
      entries: mergeTombstones([this.#tombstones.entries, [{ k, at: Date.now() }]]),
    };
    await this.#saveTombstones();
    this.#emit("change");
  }

  async togglePin(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.pinned = !entry.pinned;
    await this.#saveEntries([entry]);
    this.#emit("change");
  }

  async incrementCounter(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.type !== "hotp") return;
    entry.counter += 1;
    await this.#saveEntries([entry]);
    this.#emit("change");
  }

  /**
   * Move `fromId` to where `toId` is in the DISPLAYED order (pinned first),
   * persisting the new order. Positions in `this.entries` are irrelevant.
   */
  async reorder(fromId: string, toId: string): Promise<void> {
    const next = moveInDisplayOrder(this.entries, fromId, toId);
    if (!next) return;
    for (const entry of this.entries) {
      entry.index = next.get(entry.id) ?? entry.index;
    }
    this.entries.sort((a, b) => a.index - b.index);
    await this.#saveEntries(this.entries);
    this.#emit("change");
  }

  /** Entries + plaintext secrets for export/backup. Requires unlocked. */
  exportables(): ExportableEntry[] {
    if (this.locked) throw new Error("Unlock first");
    return this.entries.map((entry) => {
      const secret = this.#secrets.get(entry.id);
      if (!secret) throw new Error(`Missing secret for ${entry.issuer}`);
      return {
        type: entry.type,
        issuer: entry.issuer,
        account: entry.account,
        secret,
        algorithm: entry.algorithm,
        digits: entry.digits,
        period: entry.period,
        counter: entry.counter,
        index: entry.index,
        pinned: entry.pinned,
      };
    });
  }

  // ---- tombstones (F-09) ----------------------------------------------------------

  async #loadTombstones(key: CryptoKey | null): Promise<TombstoneSet> {
    const stored = await loadTombstones();
    let set: TombstoneSet = EMPTY_TOMBSTONES;
    try {
      if (stored?.sealed && key) {
        set = JSON.parse(await decryptString(key, stored.sealed)) as TombstoneSet;
      } else if (stored?.plain) {
        set = stored.plain;
      }
    } catch {
      // Unreadable deletion records only weaken merges; never block unlock.
      set = EMPTY_TOMBSTONES;
    }
    return {
      entries: mergeTombstones([set.entries ?? []]),
      credentials: mergeTombstones([set.credentials ?? []]),
    };
  }

  async #sealTombstones(set: TombstoneSet, key: CryptoKey | null): Promise<StoredTombstones> {
    return key ? { sealed: await encryptString(key, JSON.stringify(set)) } : { plain: set };
  }

  async #saveTombstones(): Promise<void> {
    if (this.encrypted && !this.#key) throw new Error("Unlock first");
    await saveTombstones(await this.#sealTombstones(this.#tombstones, this.#key));
  }

  /** Record permanently deleted credentials (their identity keys). */
  async recordCredentialDeletions(identities: string[]): Promise<void> {
    if (identities.length === 0) return;
    const now = Date.now();
    const added = await Promise.all(identities.map(async (id) => ({ k: await tombstoneKey(id), at: now })));
    this.#tombstones = {
      ...this.#tombstones,
      credentials: mergeTombstones([this.#tombstones.credentials, added]),
    };
    await this.#saveTombstones();
  }

  /** Credentials saved again under an identity deleted earlier are no longer deleted. */
  async forgetCredentialDeletions(identities: string[]): Promise<void> {
    const keys = new Set(await Promise.all(identities.map(tombstoneKey)));
    if (!this.#tombstones.credentials.some((t) => keys.has(t.k))) return;
    this.#tombstones = {
      ...this.#tombstones,
      credentials: withoutKeys(this.#tombstones.credentials, keys),
    };
    await this.#saveTombstones();
  }

  // ---- password -------------------------------------------------------------------

  /**
   * A fresh data key, wrapped under `password` (Argon2id), plus copies of
   * `entries` encrypted under it (secrets from `secrets`). Pure: touches no state.
   */
  async #sealVault(
    password: string,
    entries: StoredEntry[],
    secrets: Map<string, string>,
  ): Promise<{ key: CryptoKey; vault: VaultConfig; stored: StoredEntry[]; view: StoredEntry[] }> {
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
      const secret = secrets.get(entry.id);
      if (!secret) throw new Error(`Missing secret for ${entry.issuer}`);
      const withSecret: StoredEntry = {
        ...(JSON.parse(JSON.stringify(entry)) as StoredEntry),
        secret: { enc: await encryptString(key, secret) },
      };
      const sealed = await this.#toStored(withSecret, key);
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

  /**
   * Set (or change) the encryption password: a fresh data key, wrapped
   * under the new password, re-encrypts every secret and name in memory,
   * every credential and the audit log. Everything is written in one
   * transaction, and the in-memory state only switches over once that write
   * succeeded. Rejects passwords below the policy (F-06).
   */
  async setPassword(password: string): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    const policy = assessPassword(password);
    if (!policy.ok) throw new Error(policy.message || "Choose a stronger password");
    await this.#requireCollections();
    await this.#credentials?.ready();

    // A new password means a new data key — any Hello-wrapped copy of the
    // old key is now useless, so Hello unlock must be re-enabled explicitly.
    if (this.helloEnabled) {
      await getPlatform().hello?.deleteKey().catch(() => {});
    }

    const sealed = await this.#sealVault(password, this.entries, this.#secrets);
    const oldKey = this.#key;
    let credentials: CredentialSnapshot | undefined;
    if (this.#credentials && oldKey) {
      credentials = await this.#credentials.reseal(cryptoFor(oldKey), cryptoFor(sealed.key));
    }
    await saveVaultAndEntries(sealed.vault, sealed.stored, {
      credentials: credentials?.stored,
      audit: credentials?.audit,
      meta: { tombstones: await this.#sealTombstones(this.#tombstones, sealed.key) },
    });

    this.#key = sealed.key;
    this.vault = sealed.vault;
    this.entries = sealed.view;
    if (credentials) this.#credentials?.adopt(credentials);
    this.weakPassword = false;
    this.touch();
    this.#emit("password");
  }

  /** Verify the current password (used before change/remove and reveals). */
  async verifyPassword(password: string): Promise<boolean> {
    try {
      const { raw } = await this.#dataKeyFromPassword(password);
      raw.fill(0);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove the password and store secrets unencrypted (with a warning). */
  async removePassword(currentPassword: string): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    const { raw } = await this.#dataKeyFromPassword(currentPassword); // throws on wrong password
    raw.fill(0);
    // Credential Manager passwords have no unencrypted mode.
    await this.#credentials?.ready();
    if ((this.#credentials?.count() ?? 0) > 0 || (await countCredentials()) > 0) {
      throw new Error(
        "The Credential Manager has saved logins, which must stay encrypted. Delete them (and empty its Trash) before removing the password.",
      );
    }

    // No password → no data key → nothing for Hello to unwrap.
    if (this.helloEnabled) {
      await getPlatform().hello?.deleteKey().catch(() => {});
    }

    const plain: StoredEntry[] = [];
    for (const entry of this.entries) {
      const secret = this.#secrets.get(entry.id);
      if (!secret) throw new Error(`Missing secret for ${entry.issuer}`);
      const record = { ...(JSON.parse(JSON.stringify(entry)) as StoredEntry), secret: { plain: secret } };
      delete record.meta;
      plain.push(record);
    }
    const vault: VaultConfig = { encrypted: false };
    // The sealed audit log can't outlive the key that seals it.
    await saveVaultAndEntries(vault, plain, {
      audit: { records: [], head: null },
      meta: { tombstones: { plain: this.#tombstones } },
    });

    this.#key = null;
    this.vault = vault;
    this.entries = plain;
    this.weakPassword = false;
    this.#emit("password");
  }

  // ---- cloud backup support ----------------------------------------------------
  // These need the in-memory key, so they live here; the transport and
  // scheduling live in cloud.svelte.ts.

  /** What a backup header needs to turn the password back into the data key. */
  #keyHeader(vault: VaultConfig): BackupKeyHeader {
    if (vault.wrappedKey && vault.kdf && vault.salt) {
      return { kdf: vault.kdf, salt: vault.salt, wrappedKey: vault.wrappedKey };
    }
    return {
      kdf: { name: "PBKDF2-SHA256", iterations: vault.iterations ?? LEGACY_PBKDF2_ITERATIONS },
      salt: vault.salt ?? "",
    };
  }

  /**
   * Encrypt one backup series — the 2FA accounts ("authenticator") or the
   * Credential Manager ("credmanager") — into a cloud backup file. The result
   * is opened again with the same key and checked before it is returned, so
   * a file that couldn't be restored never leaves the device.
   */
  async sealCloudBackup(device: CloudBackupDevice, series: BackupKind): Promise<string> {
    const vault = this.vault;
    const key = this.#key;
    if (this.locked || !key) throw new Error("Unlock first");
    if (!vault?.encrypted || !vault.salt || !vault.verifier) {
      throw new Error("Set an encryption password first");
    }
    const sealKey = {
      key,
      keyHeader: this.#keyHeader($state.snapshot(vault) as VaultConfig),
      verifier: vault.verifier,
      device,
      writer: __APP_VERSION__,
    };

    let text: string;
    let expected: { entries: number; credentials: number };
    if (series === "authenticator") {
      const entries = this.exportables();
      text = await sealCloudBackup({
        ...sealKey,
        contents: "authenticator",
        entries,
        settings: {
          autoLockMinutes: this.settings.autoLockMinutes,
          clipboardClear: this.settings.clipboardClear,
          groupCodes: this.settings.groupCodes,
        },
        tombstones: this.#tombstones.entries,
      });
      expected = { entries: entries.length, credentials: 0 };
    } else {
      await this.#credentials?.ready();
      const credentials =
        (await this.#credentials?.exportPlain((blob) => decryptString(key, blob))) ?? [];
      text = await sealCloudBackup({
        ...sealKey,
        contents: "credmanager",
        credentials,
        tombstones: this.#tombstones.credentials,
      });
      expected = { entries: 0, credentials: credentials.length };
    }

    const check = await openCloudBackup(parseCloudBackup(text), key);
    if (
      check.contents !== series ||
      check.entryCount !== expected.entries ||
      check.credentials.length !== expected.credentials
    ) {
      throw new Error("Backup self-check failed");
    }
    return text;
  }

  /** How many records a backup series would hold right now. */
  async seriesCount(series: BackupKind): Promise<number> {
    if (series === "authenticator") return this.entries.length;
    await this.#credentials?.ready();
    return this.#credentials?.count() ?? 0;
  }

  /**
   * Open a backup sealed under this vault's CURRENT data key (made on this
   * device since the last password change — including before the 1.2 KDF
   * upgrade, which kept the key) without asking for the password. Returns
   * null when the key doesn't apply.
   */
  async openCloudBackupWithVaultKey(
    file: CloudBackupFile,
  ): Promise<CloudBackupPayload | null> {
    const key = this.#key;
    if (this.locked || !key || !this.encrypted) return null;
    try {
      if ((await decryptString(key, file.verifier)) !== VERIFIER_PLAINTEXT) return null;
    } catch {
      return null;
    }
    return openCloudBackup(file, key);
  }

  /**
   * Device-authentication gate before restoring secrets. Returns true after
   * a successful Windows Hello verification, false when this device has no
   * OS verifier (the caller then requires the password instead). Rejects if
   * the user cancels or fails verification.
   */
  async verifyUserPresence(): Promise<boolean> {
    const hello = getPlatform().hello;
    if (!hello || !this.helloSupported) return false;
    await hello.verifyUser();
    return true;
  }

  /**
   * Restore accounts and/or credentials from decrypted cloud backups (see
   * `restoreParts`). Each part that is present is restored with `mode`:
   *  - "merge":   add only records that aren't here yet (for accounts: same
   *               secret + issuer + account), after the existing ones, and
   *               honour deletions recorded on either side (F-09);
   *  - "replace": that part becomes exactly the backup (rollback).
   * A part that is null is left exactly as it is, in either mode.
   *
   * Pins and order come back as they were. When no encryption password is
   * set yet (fresh install), `password` — the one the backup was made with —
   * becomes the vault password, so the device ends up as the original was.
   *
   * Everything is built in memory first and persisted in ONE transaction:
   * an interrupted restore changes nothing.
   */
  async restoreFromBackup(
    parts: RestoreParts,
    mode: "merge" | "replace",
    password?: string,
  ): Promise<RestoreResult> {
    if (this.locked) throw new Error("Unlock first");
    if (!this.encrypted && !password) {
      throw new Error("The backup's password is required to restore it");
    }
    await this.#requireCollections();
    await this.#credentials?.ready();
    const now = Date.now();
    const touchEntries = parts.entries !== null;

    // Accounts this restore doesn't replace stay, with their secrets.
    const secrets = new Map<string, string>();
    let kept: StoredEntry[] = [];
    if (!touchEntries || mode === "merge") {
      for (const entry of this.entries) {
        const secret = this.#secrets.get(entry.id);
        if (!secret) throw new Error(`Missing secret for ${entry.issuer}`);
        secrets.set(entry.id, secret);
        kept.push(JSON.parse(JSON.stringify(entry)) as StoredEntry);
      }
    }
    const keyOf = (entry: StoredEntry) =>
      accountKey({ secret: secrets.get(entry.id) ?? "", issuer: entry.issuer, account: entry.account });

    // Deletions another device recorded after this device added the account.
    let removed = 0;
    if (touchEntries && mode === "merge" && parts.entryTombstones.length) {
      const remote = new Map(parts.entryTombstones.map((t) => [t.k, t.at]));
      const survivors: StoredEntry[] = [];
      for (const entry of kept) {
        const at = remote.get(await tombstoneKey(keyOf(entry)));
        if (at !== undefined && (entry.addedAt ?? 0) < at) {
          removed++;
          secrets.delete(entry.id);
          continue;
        }
        survivors.push(entry);
      }
      kept = survivors;
    }

    const seen = new Set(kept.map(keyOf));
    const deletedHere = new Set(
      mode === "merge" ? this.#tombstones.entries.map((t) => t.k) : [],
    );
    const revived = new Set<string>();
    let index = kept.reduce((max, e) => Math.max(max, e.index), -1) + 1;
    let skipped = 0;
    const created: StoredEntry[] = [];
    for (const item of [...(parts.entries ?? [])].sort((a, b) => a.index - b.index)) {
      const key = accountKey(item);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      const k = await tombstoneKey(key);
      if (deletedHere.has(k)) {
        skipped++; // deleted on this device — a merge doesn't bring it back
        continue;
      }
      seen.add(key);
      revived.add(k);
      const secret = normalizeBase32(item.secret);
      const entry: StoredEntry = {
        id: crypto.randomUUID(),
        hash: await sha256Hex(secret),
        issuer: item.issuer.trim(),
        account: item.account.trim(),
        type: item.type,
        algorithm: item.algorithm,
        digits: item.digits,
        period: item.period,
        counter: item.counter,
        index: index++,
        pinned: item.pinned,
        addedAt: now,
        secret: {},
      };
      secrets.set(entry.id, secret);
      created.push(entry);
    }
    const entryTombstones = touchEntries
      ? withoutKeys(mergeTombstones([this.#tombstones.entries, parts.entryTombstones], now), revived)
      : this.#tombstones.entries;

    // Credential Manager records ride along in the same transaction. Without
    // credentials to restore (an Authenticator-only backup, or one from
    // before the Credential Manager) existing credentials are left alone
    // even in "replace" mode — rolling back accounts must not erase them.
    const items = parts.credentials;
    const localCredentialTombstones = this.#tombstones.credentials;
    const restoreCredentials = async (crypto: VaultCrypto) =>
      this.#credentials && items !== null
        ? this.#credentials.restore(items, mode, crypto, {
            local: localCredentialTombstones,
            remote: parts.credentialTombstones,
          })
        : null;
    const credentialTombstonesAfter = (
      result: Awaited<ReturnType<typeof restoreCredentials>>,
    ): Tombstone[] =>
      result
        ? withoutKeys(
            mergeTombstones([localCredentialTombstones, parts.credentialTombstones], now),
            new Set(result.revived),
          )
        : localCredentialTombstones;

    let credentialResult: Awaited<ReturnType<typeof restoreCredentials>>;
    const all = [...kept, ...created];
    if (this.encrypted) {
      const key = this.#key;
      const vault = this.vault;
      if (!key || !vault) throw new Error("Unlock first");
      for (const entry of created) {
        entry.secret = { enc: await encryptString(key, secrets.get(entry.id) ?? "") };
      }
      credentialResult = await restoreCredentials(cryptoFor(key));
      const tombstones: TombstoneSet = {
        entries: entryTombstones,
        credentials: credentialTombstonesAfter(credentialResult),
      };
      const stored = await Promise.all(all.map((e) => this.#toStored(e, key)));
      await saveVaultAndEntries($state.snapshot(vault) as VaultConfig, stored, {
        credentials: credentialResult?.stored,
        meta: { tombstones: await this.#sealTombstones(tombstones, key) },
      });
      all.forEach((entry, i) => (entry.meta = stored[i].meta));
      this.entries = all;
      this.#secrets = secrets;
      this.#tombstones = tombstones;
    } else {
      const sealed = await this.#sealVault(password ?? "", all, secrets);
      credentialResult = await restoreCredentials(cryptoFor(sealed.key));
      const tombstones: TombstoneSet = {
        entries: entryTombstones,
        credentials: credentialTombstonesAfter(credentialResult),
      };
      await saveVaultAndEntries(sealed.vault, sealed.stored, {
        credentials: credentialResult?.stored,
        meta: { tombstones: await this.#sealTombstones(tombstones, sealed.key) },
      });
      this.#key = sealed.key;
      this.vault = sealed.vault;
      this.entries = sealed.view;
      this.#secrets = secrets;
      this.#tombstones = tombstones;
      this.weakPassword = !assessPassword(password ?? "").ok;
      this.#emit("password");
    }
    if (credentialResult) this.#credentials?.adopt(credentialResult);

    this.touch();
    if (touchEntries) this.#emit("change");
    if (credentialResult) this.#emit("credentials");
    return {
      restoredAccounts: touchEntries,
      added: created.length,
      skipped,
      removed,
      restoredCredentials: parts.credentials !== null,
      credentialsAdded: credentialResult?.added ?? 0,
      credentialsSkipped: credentialResult?.skipped ?? 0,
      credentialsRemoved: credentialResult?.removed ?? 0,
    };
  }

  async updateSettings(patch: Partial<AuthSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await saveSettings(this.settings);
  }

  /** Danger zone: delete everything, including the vault config. */
  async wipe(): Promise<void> {
    if (this.helloEnabled) {
      await getPlatform().hello?.deleteKey().catch(() => {});
    }
    await wipeAll();
    this.#credentials?.clear();
    this.entries = [];
    this.#secrets.clear();
    this.#tombstones = { ...EMPTY_TOMBSTONES };
    this.#key = null;
    this.vault = null;
    this.locked = false;
    this.weakPassword = false;
    this.settings = { ...DEFAULT_SETTINGS };
    this.#emit("wipe");
  }
}

export const authStore = new AuthStore();
