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
  replaceAllEntries,
  saveEntries,
  saveSettings,
  saveVaultConfig,
  wipeAll,
  type AuthSettings,
  type StoredEntry,
  type VaultConfig,
} from "../../core/authenticator/db";
import {
  decryptString,
  deriveVaultKey,
  encryptString,
  PBKDF2_ITERATIONS,
  randomBytes,
  sha256Hex,
  VERIFIER_PLAINTEXT,
} from "../../core/authenticator/vault-crypto";
import { bytesToBase64 } from "../../core/authenticator/legacy-crypto";
import { normalizeBase32 } from "../../core/authenticator/base32";
import type { ExportableEntry } from "../../core/authenticator/backup";

export class AuthStore {
  ready = $state(false);
  locked = $state(false);
  entries = $state<StoredEntry[]>([]);
  vault = $state<VaultConfig | null>(null);
  settings = $state<AuthSettings>({ ...DEFAULT_SETTINGS });
  /** Shared wall clock (ms); one interval drives every countdown ring. */
  now = $state(Date.now());

  #key: CryptoKey | null = null;
  #secrets = new Map<string, string>();
  #lastActivity = Date.now();

  get encrypted(): boolean {
    return this.vault?.encrypted === true;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    const [vault, settings, entries] = await Promise.all([
      loadVaultConfig(),
      loadSettings(),
      loadEntries(),
    ]);
    this.vault = vault ?? null;
    this.settings = settings;
    this.entries = entries;
    this.locked = this.encrypted; // locked on page load when a password is set

    if (!this.encrypted) {
      for (const entry of entries) {
        if (entry.secret.plain) this.#secrets.set(entry.id, entry.secret.plain);
      }
    }
    this.ready = true;
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
      this.lock();
    }
  }

  /** Record user activity (resets the auto-lock countdown). */
  touch(): void {
    this.#lastActivity = Date.now();
  }

  lock(): void {
    this.#key = null;
    this.#secrets.clear();
    this.locked = true;
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

  async unlock(password: string): Promise<void> {
    const key = await this.#deriveAndVerify(password);
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
  }

  async rename(id: string, issuer: string, account: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.issuer = issuer.trim();
    entry.account = account.trim();
    await saveEntries([entry]);
  }

  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.#secrets.delete(id);
    await dbDeleteEntry(id);
  }

  async togglePin(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.pinned = !entry.pinned;
    await saveEntries([entry]);
  }

  async incrementCounter(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.type !== "hotp") return;
    entry.counter += 1;
    await saveEntries([entry]);
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
   * Set (or change) the encryption password: derives a fresh salt + key,
   * stores a verifier, and re-encrypts every secret currently in memory.
   */
  async setPassword(password: string): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    if (!password) throw new Error("Password must not be empty");

    const salt = bytesToBase64(randomBytes(16));
    const key = await deriveVaultKey(password, salt, PBKDF2_ITERATIONS);
    const verifier = await encryptString(key, VERIFIER_PLAINTEXT);

    for (const entry of this.entries) {
      const secret = this.#secrets.get(entry.id);
      if (!secret) throw new Error(`Missing secret for ${entry.issuer}`);
      entry.secret = { enc: await encryptString(key, secret) };
    }

    this.#key = key;
    this.vault = {
      encrypted: true,
      salt,
      iterations: PBKDF2_ITERATIONS,
      verifier,
    };
    await saveVaultConfig(this.vault);
    await replaceAllEntries(this.entries);
    this.touch();
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

    for (const entry of this.entries) {
      const secret = this.#secrets.get(entry.id);
      if (!secret) throw new Error(`Missing secret for ${entry.issuer}`);
      entry.secret = { plain: secret };
    }
    this.#key = null;
    this.vault = { encrypted: false };
    await saveVaultConfig(this.vault);
    await replaceAllEntries(this.entries);
  }

  async updateSettings(patch: Partial<AuthSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await saveSettings(this.settings);
  }

  /** Danger zone: delete everything, including the vault config. */
  async wipe(): Promise<void> {
    await wipeAll();
    this.entries = [];
    this.#secrets.clear();
    this.#key = null;
    this.vault = null;
    this.locked = false;
    this.settings = { ...DEFAULT_SETTINGS };
  }
}

export const authStore = new AuthStore();
