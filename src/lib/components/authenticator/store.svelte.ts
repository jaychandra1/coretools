/**
 * Reactive state for the Authenticator section (Svelte 5 runes).
 *
 * Owns the entry list, the vault (encryption) lifecycle and the shared clock
 * every visible code ticks from. The derived AES-GCM key and the decrypted
 * secrets live ONLY in private in-memory fields — locking drops both, and
 * nothing secret is ever written to storage in plaintext once a password is
 * set.
 */

import type { ParsedAccount } from "../../core/authenticator/types";
import {
  DEFAULT_SETTINGS,
  deleteEntry as dbDeleteEntry,
  loadEntries,
  loadSettings,
  loadVaultConfig,
  saveEntries,
  saveSettings,
  saveVaultAndEntries,
  saveVaultConfig,
  wipeAll,
  type AuthSettings,
  type StoredEntry,
  type VaultConfig,
} from "../../core/authenticator/db";
import {
  decryptString,
  deriveVaultKey,
  deriveWrappingKey,
  encryptString,
  exportKeyBytes,
  importVaultKey,
  PBKDF2_ITERATIONS,
  randomBytes,
  sha256Hex,
  unwrapKeyBytes,
  VERIFIER_PLAINTEXT,
  wrapKeyBytes,
} from "../../core/authenticator/vault-crypto";
import {
  base64ToBytes,
  bytesToBase64,
} from "../../core/authenticator/legacy-crypto";
import { normalizeBase32 } from "../../core/authenticator/base32";
import { moveInDisplayOrder } from "../../core/authenticator/order";
import { accountKey, type ExportableEntry } from "../../core/authenticator/backup";
import {
  openCloudBackup,
  parseCloudBackup,
  sealCloudBackup,
  type CloudBackupDevice,
  type CloudBackupFile,
  type CloudBackupPayload,
  type RestoreParts,
} from "../../core/authenticator/cloud-backup";
import type { BackupKind } from "../../core/authenticator/cloud-sync";
import type { EncryptedBlob } from "../../core/authenticator/vault-crypto";
import type { BackupCredential, StoredCredential } from "../../core/credentials/types";
import { getPlatform } from "../../platform";

/**
 * Lifecycle notifications for observers such as the cloud backup:
 *  - "change": 2FA entries were added/edited/removed/reordered (persisted);
 *  - "credentials": Credential Manager records changed (persisted);
 *  - "unlock": the vault key is available again;
 *  - "password": the vault key changed (new password → new salt) — this
 *    affects everything encrypted with it, entries and credentials alike;
 *  - "lock": the vault key was dropped;
 *  - "wipe": everything local was deleted.
 */
export type AuthEvent = "change" | "credentials" | "unlock" | "password" | "lock" | "wipe";

export interface RestoreResult {
  /** The restore included 2FA accounts (the counts below apply). */
  restoredAccounts: boolean;
  added: number;
  skipped: number;
  /** The restore included Credential Manager records. */
  restoredCredentials: boolean;
  credentialsAdded: number;
  credentialsSkipped: number;
}

type Decrypt = (blob: EncryptedBlob) => Promise<string>;
type Encrypt = (plaintext: string) => Promise<EncryptedBlob>;

/**
 * How the Credential Manager takes part in vault-wide operations. The vault
 * (this store) owns the key; the credential store owns its records. Every
 * operation that changes the key or replaces data asks it for the records to
 * persist, and writes them in the SAME transaction as the vault itself.
 */
export interface CredentialVaultHooks {
  /** Resolves once the records are loaded; awaited before any hook below. */
  ready(): Promise<void>;
  count(): number;
  /** Plaintext of every credential (incl. trash) for the cloud backup. */
  exportPlain(decrypt: Decrypt): Promise<BackupCredential[]>;
  /** Every stored credential re-encrypted under a new key. */
  reseal(decrypt: Decrypt, encrypt: Encrypt): Promise<StoredCredential[]>;
  /** Records after restoring backup credentials (merge or replace). */
  restore(
    items: BackupCredential[],
    mode: "merge" | "replace",
    encrypt: Encrypt,
  ): Promise<{ records: StoredCredential[]; added: number; skipped: number }>;
  /** The records were persisted — make them the in-memory state. */
  adopt(records: StoredCredential[]): void;
  /** Everything was wiped. */
  clear(): void;
}

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

  #key: CryptoKey | null = null;
  #secrets = new Map<string, string>();
  #lastActivity = Date.now();
  #ticker: ReturnType<typeof setInterval> | null = null;
  #initPromise: Promise<void> | null = null;
  #credentials: CredentialVaultHooks | null = null;

  /** Called once by the Credential Manager's store. */
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

  /** The lock screen should offer the Hello button. */
  get canUnlockWithHello(): boolean {
    return this.helloEnabled && this.helloSupported;
  }

  /** Idempotent and safe to call concurrently (UI + cloud backup both do). */
  init(): Promise<void> {
    this.#initPromise ??= this.#init();
    return this.#initPromise;
  }

  async #init(): Promise<void> {
    const [vault, settings, entries] = await Promise.all([
      loadVaultConfig(),
      loadSettings(),
      loadEntries(),
    ]);
    this.vault = vault ?? null;
    this.settings = settings;
    this.entries = entries;
    this.locked = this.encrypted; // locked on page load when a password is set
    this.lockReason = this.locked ? "initial" : null;

    if (!this.encrypted) {
      for (const entry of entries) {
        if (entry.secret.plain) this.#secrets.set(entry.id, entry.secret.plain);
      }
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
    this.locked = true;
    this.lockReason = reason;
    this.#emit("lock");
  }

  async #deriveAndVerify(password: string): Promise<CryptoKey> {
    const vault = this.vault;
    if (!vault?.encrypted || !vault.salt || !vault.verifier) {
      throw new Error("No encryption password is set");
    }
    const key = await deriveVaultKey(
      password,
      vault.salt,
      vault.iterations ?? PBKDF2_ITERATIONS,
    );
    let sentinel: string;
    try {
      sentinel = await decryptString(key, vault.verifier);
    } catch {
      throw new Error("Wrong password");
    }
    if (sentinel !== VERIFIER_PLAINTEXT) throw new Error("Wrong password");
    return key;
  }

  /** Decrypt all entry secrets with `key` and enter the unlocked state. */
  async #finishUnlock(key: CryptoKey): Promise<void> {
    const secrets = new Map<string, string>();
    for (const entry of this.entries) {
      if (entry.secret.enc) {
        secrets.set(entry.id, await decryptString(key, entry.secret.enc));
      } else if (entry.secret.plain) {
        secrets.set(entry.id, entry.secret.plain);
      }
    }
    this.#key = key;
    this.#secrets = secrets;
    this.touch();
    this.locked = false;
    this.lockReason = null;
    this.#emit("unlock");
  }

  async unlock(password: string): Promise<void> {
    const key = await this.#deriveAndVerify(password);
    await this.#finishUnlock(key);
  }

  /**
   * Unlock via Windows Hello: the OS-gated signature over the stored
   * challenge unwraps the vault key. The password path stays untouched and
   * always works as a fallback.
   */
  async unlockWithHello(): Promise<void> {
    const vault = this.vault;
    const hello = getPlatform().hello;
    if (!vault?.encrypted || !vault.hello || !vault.verifier || !hello) {
      throw new Error("Windows Hello unlock is not set up");
    }

    // Nothing below mutates any state until BOTH gates pass:
    //  1. the OS-verified Hello signature must unwrap the vault key
    //     (AES-GCM authentication fails for any other signature), and
    //  2. the unwrapped key must decrypt the vault verifier.
    // A canceled or failed Hello prompt rejects inside sign() and the vault
    // stays locked; the password path is completely independent of this.
    const signature = await hello.sign(base64ToBytes(vault.hello.challenge));
    const wrappingKey = await deriveWrappingKey(signature);

    let key: CryptoKey;
    try {
      key = await importVaultKey(
        await unwrapKeyBytes(wrappingKey, vault.hello.wrapped),
      );
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
   * Enable Windows Hello unlock. Requires the current password: the working
   * key is non-extractable by design, so a transient extractable copy is
   * derived, wrapped under the Hello-signature key, and discarded.
   */
  async enableHello(password: string): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    const vault = this.vault;
    const hello = getPlatform().hello;
    if (!vault?.encrypted || !vault.salt) {
      throw new Error("Set an encryption password first");
    }
    if (!hello) throw new Error("Not available on this platform");
    await this.#deriveAndVerify(password); // throws on wrong password

    const extractable = await deriveVaultKey(
      password,
      vault.salt,
      vault.iterations ?? PBKDF2_ITERATIONS,
      true,
    );
    const raw = await exportKeyBytes(extractable);

    const challenge = randomBytes(32);
    const signature = await hello.createKey(challenge);
    const wrappingKey = await deriveWrappingKey(signature);
    const wrapped = await wrapKeyBytes(wrappingKey, raw);
    raw.fill(0);

    this.vault = {
      ...vault,
      hello: { challenge: bytesToBase64(challenge), wrapped },
    };
    await saveVaultConfig(this.vault);
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

  /** Plaintext secret for an entry — null while locked. */
  secretOf(id: string): string | null {
    return this.#secrets.get(id) ?? null;
  }

  async #storedSecret(plaintext: string): Promise<StoredEntry["secret"]> {
    if (this.#key) return { enc: await encryptString(this.#key, plaintext) };
    return { plain: plaintext };
  }

  /** Add parsed accounts as new entries. Caller pre-filters duplicates. */
  async addAccounts(accounts: ParsedAccount[]): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    let index = this.entries.reduce((max, e) => Math.max(max, e.index), -1) + 1;
    const created: StoredEntry[] = [];

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
        secret: await this.#storedSecret(secret),
      };
      this.#secrets.set(entry.id, secret);
      created.push(entry);
    }

    this.entries.push(...created);
    await saveEntries(created);
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
    await saveEntries([entry]);
    this.#emit("change");
  }

  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.#secrets.delete(id);
    await dbDeleteEntry(id);
    this.#emit("change");
  }

  async togglePin(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.pinned = !entry.pinned;
    await saveEntries([entry]);
    this.#emit("change");
  }

  async incrementCounter(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.type !== "hotp") return;
    entry.counter += 1;
    await saveEntries([entry]);
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
    await saveEntries(this.entries);
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

  /**
   * Derive a fresh salt + key from `password` and build encrypted copies of
   * `entries` (secrets taken from `secrets`). Pure: touches no state.
   */
  async #sealVault(
    password: string,
    entries: StoredEntry[],
    secrets: Map<string, string>,
  ): Promise<{ key: CryptoKey; vault: VaultConfig; entries: StoredEntry[] }> {
    const salt = bytesToBase64(randomBytes(16));
    const key = await deriveVaultKey(password, salt, PBKDF2_ITERATIONS);
    const verifier = await encryptString(key, VERIFIER_PLAINTEXT);

    const sealed: StoredEntry[] = [];
    for (const entry of entries) {
      const secret = secrets.get(entry.id);
      if (!secret) throw new Error(`Missing secret for ${entry.issuer}`);
      sealed.push({
        ...$state.snapshot(entry),
        secret: { enc: await encryptString(key, secret) },
      });
    }
    return {
      key,
      vault: { encrypted: true, salt, iterations: PBKDF2_ITERATIONS, verifier },
      entries: sealed,
    };
  }

  /**
   * Set (or change) the encryption password: derives a fresh salt + key,
   * stores a verifier, and re-encrypts every secret currently in memory.
   * The vault config and entries are written in one transaction, and the
   * in-memory state only switches over once that write succeeded.
   */
  async setPassword(password: string): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    if (!password) throw new Error("Password must not be empty");

    // A new password means a new vault key — any Hello-wrapped copy of the
    // old key is now useless, so Hello unlock must be re-enabled explicitly.
    if (this.helloEnabled) {
      await getPlatform().hello?.deleteKey().catch(() => {});
    }

    await this.#credentials?.ready();
    const sealed = await this.#sealVault(password, this.entries, this.#secrets);

    // Saved credentials are re-encrypted under the new key in the same write.
    const oldKey = this.#key;
    let credentials: StoredCredential[] | undefined;
    if (this.#credentials && this.#credentials.count() > 0) {
      if (!oldKey) throw new Error("Unlock first");
      credentials = await this.#credentials.reseal(
        (blob) => decryptString(oldKey, blob),
        (plain) => encryptString(sealed.key, plain),
      );
    }
    await saveVaultAndEntries(sealed.vault, sealed.entries, credentials);

    this.#key = sealed.key;
    this.vault = sealed.vault;
    this.entries = sealed.entries;
    if (credentials) this.#credentials?.adopt(credentials);
    this.touch();
    this.#emit("password");
  }

  /** Verify the current password (used before change/remove). */
  async verifyPassword(password: string): Promise<boolean> {
    try {
      await this.#deriveAndVerify(password);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove the password and store secrets unencrypted (with a warning). */
  async removePassword(currentPassword: string): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    await this.#deriveAndVerify(currentPassword); // throws on wrong password
    // Credential Manager passwords have no unencrypted mode.
    await this.#credentials?.ready();
    if (this.#credentials && this.#credentials.count() > 0) {
      throw new Error(
        "The Credential Manager has saved logins, which must stay encrypted. Delete them (and empty its Trash) before removing the password.",
      );
    }

    // No password → no vault key → nothing for Hello to unwrap.
    if (this.helloEnabled) {
      await getPlatform().hello?.deleteKey().catch(() => {});
    }

    const plain: StoredEntry[] = [];
    for (const entry of this.entries) {
      const secret = this.#secrets.get(entry.id);
      if (!secret) throw new Error(`Missing secret for ${entry.issuer}`);
      plain.push({ ...$state.snapshot(entry), secret: { plain: secret } });
    }
    const vault: VaultConfig = { encrypted: false };
    await saveVaultAndEntries(vault, plain);

    this.#key = null;
    this.vault = vault;
    this.entries = plain;
    this.#emit("password");
  }

  // ---- cloud backup support ----------------------------------------------------
  // These need the in-memory vault key, so they live here; the transport and
  // scheduling live in cloud.svelte.ts.

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
      salt: vault.salt,
      iterations: vault.iterations ?? PBKDF2_ITERATIONS,
      verifier: vault.verifier,
      device,
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
      });
      expected = { entries: entries.length, credentials: 0 };
    } else {
      await this.#credentials?.ready();
      const credentials =
        (await this.#credentials?.exportPlain((blob) => decryptString(key, blob))) ?? [];
      text = await sealCloudBackup({ ...sealKey, contents: "credmanager", credentials });
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
   * Open a backup sealed under this vault's CURRENT key (same salt and
   * iterations — i.e. made on this device since the last password change)
   * without asking for the password. Returns null when the key can't apply.
   */
  async openCloudBackupWithVaultKey(
    file: CloudBackupFile,
  ): Promise<CloudBackupPayload | null> {
    const vault = this.vault;
    if (this.locked || !this.#key || !vault?.encrypted || !vault.salt) return null;
    if (
      file.kdf.salt !== vault.salt ||
      file.kdf.iterations !== (vault.iterations ?? PBKDF2_ITERATIONS)
    ) {
      return null;
    }
    return openCloudBackup(file, this.#key);
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
   *               secret + issuer + account), after the existing ones;
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
    await this.#credentials?.ready();

    // Accounts this restore doesn't replace stay, with their secrets.
    const keepEntries = parts.entries === null || mode === "merge";
    const secrets = new Map<string, string>();
    const kept: StoredEntry[] = [];
    if (keepEntries) {
      for (const entry of this.entries) {
        const secret = this.#secrets.get(entry.id);
        if (!secret) throw new Error(`Missing secret for ${entry.issuer}`);
        secrets.set(entry.id, secret);
        kept.push($state.snapshot(entry) as StoredEntry);
      }
    }
    const seen = new Set(
      kept.map((entry) =>
        accountKey({
          secret: secrets.get(entry.id) ?? "",
          issuer: entry.issuer,
          account: entry.account,
        }),
      ),
    );

    let index = kept.reduce((max, e) => Math.max(max, e.index), -1) + 1;
    let skipped = 0;
    const created: StoredEntry[] = [];
    for (const item of [...(parts.entries ?? [])].sort((a, b) => a.index - b.index)) {
      const key = accountKey(item);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
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
        secret: {},
      };
      secrets.set(entry.id, secret);
      created.push(entry);
    }

    // Credential Manager records ride along in the same transaction. Without
    // credentials to restore (an Authenticator-only backup, or one from
    // before the Credential Manager) existing credentials are left alone
    // even in "replace" mode — rolling back accounts must not erase them.
    const items = parts.credentials;
    const restoreCredentials = async (encrypt: Encrypt) =>
      this.#credentials && items !== null && (items.length > 0 || mode === "replace")
        ? this.#credentials.restore(items, mode, encrypt)
        : null;

    let credentialResult: Awaited<ReturnType<typeof restoreCredentials>>;
    if (this.encrypted) {
      const key = this.#key;
      const vault = this.vault;
      if (!key || !vault) throw new Error("Unlock first");
      for (const entry of created) {
        entry.secret = { enc: await encryptString(key, secrets.get(entry.id) ?? "") };
      }
      const all = [...kept, ...created];
      credentialResult = await restoreCredentials((plain) => encryptString(key, plain));
      await saveVaultAndEntries(
        $state.snapshot(vault) as VaultConfig,
        all,
        credentialResult?.records,
      );
      this.entries = all;
      this.#secrets = secrets;
    } else {
      const sealed = await this.#sealVault(
        password ?? "",
        [...kept, ...created],
        secrets,
      );
      credentialResult = await restoreCredentials((plain) => encryptString(sealed.key, plain));
      await saveVaultAndEntries(sealed.vault, sealed.entries, credentialResult?.records);
      this.#key = sealed.key;
      this.vault = sealed.vault;
      this.entries = sealed.entries;
      this.#secrets = secrets;
      this.#emit("password");
    }
    if (credentialResult) this.#credentials?.adopt(credentialResult.records);

    this.touch();
    if (parts.entries !== null) this.#emit("change");
    if (credentialResult) this.#emit("credentials");
    return {
      restoredAccounts: parts.entries !== null,
      added: created.length,
      skipped,
      restoredCredentials: parts.credentials !== null,
      credentialsAdded: credentialResult?.added ?? 0,
      credentialsSkipped: credentialResult?.skipped ?? 0,
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
    this.#key = null;
    this.vault = null;
    this.locked = false;
    this.settings = { ...DEFAULT_SETTINGS };
    this.#emit("wipe");
  }
}

export const authStore = new AuthStore();
