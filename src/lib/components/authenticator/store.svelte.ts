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
import { accountKey, type ExportableEntry } from "../../core/authenticator/backup";
import {
  openCloudBackup,
  parseCloudBackup,
  sealCloudBackup,
  type CloudBackupDevice,
  type CloudBackupFile,
  type CloudBackupPayload,
  type CloudBackupSettings,
} from "../../core/authenticator/cloud-backup";
import { getPlatform } from "../../platform";

/**
 * Lifecycle notifications for observers such as the cloud backup:
 *  - "change": entries were added/edited/removed/reordered (persisted);
 *  - "unlock": the vault key is available again;
 *  - "password": the vault key changed (new password → new salt);
 *  - "wipe": everything local was deleted.
 */
export type AuthEvent = "change" | "unlock" | "password" | "wipe";

export interface RestoreResult {
  added: number;
  skipped: number;
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

  /** Move `fromId` to the position of `toId`, persisting the new order. */
  async reorder(fromId: string, toId: string): Promise<void> {
    const from = this.entries.findIndex((e) => e.id === fromId);
    const to = this.entries.findIndex((e) => e.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = this.entries.splice(from, 1);
    this.entries.splice(to, 0, moved);
    this.entries.forEach((entry, i) => (entry.index = i));
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

    const sealed = await this.#sealVault(password, this.entries, this.#secrets);
    await saveVaultAndEntries(sealed.vault, sealed.entries);

    this.#key = sealed.key;
    this.vault = sealed.vault;
    this.entries = sealed.entries;
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
   * Encrypt the whole vault into a cloud backup file. The result is opened
   * again with the same key and checked before it is returned, so a file
   * that couldn't be restored never leaves the device.
   */
  async sealCloudBackup(device: CloudBackupDevice): Promise<string> {
    const vault = this.vault;
    const key = this.#key;
    if (this.locked || !key) throw new Error("Unlock first");
    if (!vault?.encrypted || !vault.salt || !vault.verifier) {
      throw new Error("Set an encryption password first");
    }
    const entries = this.exportables();
    const settings: CloudBackupSettings = {
      autoLockMinutes: this.settings.autoLockMinutes,
      clipboardClear: this.settings.clipboardClear,
      groupCodes: this.settings.groupCodes,
    };
    const text = await sealCloudBackup({
      key,
      salt: vault.salt,
      iterations: vault.iterations ?? PBKDF2_ITERATIONS,
      verifier: vault.verifier,
      device,
      entries,
      settings,
    });

    const check = await openCloudBackup(parseCloudBackup(text), key);
    if (check.entryCount !== entries.length) {
      throw new Error("Backup self-check failed");
    }
    return text;
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
   * Restore accounts from a decrypted cloud backup.
   *  - "merge":   add only accounts that aren't here yet (same secret +
   *               issuer + account), after the existing ones;
   *  - "replace": the vault becomes exactly the backup (rollback).
   *
   * Pins and order come back as they were. When no encryption password is
   * set yet (fresh install), `password` — the one the backup was made with —
   * becomes the vault password, so the device ends up as the original was.
   *
   * Everything is built in memory first and persisted in ONE transaction:
   * an interrupted restore changes nothing.
   */
  async restoreFromBackup(
    payload: CloudBackupPayload,
    mode: "merge" | "replace",
    password?: string,
  ): Promise<RestoreResult> {
    if (this.locked) throw new Error("Unlock first");
    if (!this.encrypted && !password) {
      throw new Error("The backup's password is required to restore it");
    }

    const secrets = new Map<string, string>();
    const kept: StoredEntry[] = [];
    if (mode === "merge") {
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
    for (const item of [...payload.entries].sort((a, b) => a.index - b.index)) {
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

    if (this.encrypted) {
      const key = this.#key;
      const vault = this.vault;
      if (!key || !vault) throw new Error("Unlock first");
      for (const entry of created) {
        entry.secret = { enc: await encryptString(key, secrets.get(entry.id) ?? "") };
      }
      const all = [...kept, ...created];
      await saveVaultAndEntries($state.snapshot(vault) as VaultConfig, all);
      this.entries = all;
      this.#secrets = secrets;
    } else {
      const sealed = await this.#sealVault(
        password ?? "",
        [...kept, ...created],
        secrets,
      );
      await saveVaultAndEntries(sealed.vault, sealed.entries);
      this.#key = sealed.key;
      this.vault = sealed.vault;
      this.entries = sealed.entries;
      this.#secrets = secrets;
      this.#emit("password");
    }

    this.touch();
    this.#emit("change");
    return { added: created.length, skipped };
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
