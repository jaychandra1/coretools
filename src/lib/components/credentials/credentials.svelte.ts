/**
 * Reactive state for the Credential Manager (Svelte 5 runes).
 *
 * Credentials share the Authenticator's vault: the AuthStore owns the key
 * and its lifecycle (unlock, auto-lock, password change, restore, wipe); this
 * store owns the credential records and plugs into those operations through
 * `CredentialVaultHooks`.
 *
 * Plaintext handling: passwords and notes are decrypted ON DEMAND — only for
 * the one credential the user reveals, copies or edits — and are never kept
 * in this store. Revealing or copying a password requires a fresh Windows
 * Hello / master-password check (trusted for a minute) when the
 * `credentialsRevealAuth` setting is on, and is written to the audit log.
 */

import { authStore, type CredentialVaultHooks } from "../authenticator/store.svelte";
import {
  appendAudit,
  deleteCredentials,
  loadAudit,
  loadCredentials,
  saveCredentials,
} from "../../core/authenticator/db";
import {
  credentialKey,
  TRASH_RETENTION_MS,
  type AuditAction,
  type AuditEvent,
  type BackupCredential,
  type CredentialFields,
  type StoredCredential,
} from "../../core/credentials/types";

/** How long a successful reveal check is trusted. */
const REVEAL_GRACE_MS = 60_000;

export interface CredentialInput extends CredentialFields {
  /** New password; null keeps the current one (edit). */
  password: string | null;
  /** New notes; null keeps the current ones (edit). */
  notes: string | null;
}

/** Shown by the UI when the user has to confirm it's them. */
export type PasswordPrompt = () => Promise<string | null>;

function clean(fields: CredentialFields): CredentialFields {
  return {
    platform: fields.platform.trim(),
    url: fields.url.trim(),
    username: fields.username.trim(),
    category: fields.category.trim(),
    owner: fields.owner.trim(),
    tags: [...fields.tags],
  };
}

export class CredentialStore {
  ready = $state(false);
  items = $state<StoredCredential[]>([]);
  /** Loaded lazily when the activity log is opened; newest first. */
  audit = $state<AuditEvent[]>([]);

  #initPromise: Promise<void> | null = null;
  #trustedUntil = 0;
  /** Ids created by a restore that hasn't been persisted yet. */
  #pendingRestored = new Set<string>();

  get active(): StoredCredential[] {
    return this.items.filter((c) => c.deletedAt === null);
  }

  get trash(): StoredCredential[] {
    return this.items.filter((c) => c.deletedAt !== null);
  }

  init(): Promise<void> {
    this.#initPromise ??= this.#init();
    return this.#initPromise;
  }

  async #init(): Promise<void> {
    await authStore.init();
    this.items = await loadCredentials();
    authStore.subscribe((event) => {
      if (event === "lock" || event === "wipe") this.#trustedUntil = 0;
    });
    this.ready = true;
    await this.#purgeExpiredTrash();
  }

  /**
   * Registered with the vault at module load (bottom of this file) — NOT when
   * the tab first opens — so a password change, restore or backup started
   * from the Authenticator always includes the credentials. Every hook the
   * vault calls is preceded by `ready()`, which loads the records first.
   */
  vaultHooks(): CredentialVaultHooks {
    return {
      ready: () => this.init(),
      count: () => this.items.length,
      exportPlain: (decrypt) => this.#exportPlain(decrypt),
      reseal: (decrypt, encrypt) => this.#reseal(decrypt, encrypt),
      restore: (items, mode, encrypt) => this.#restoreRecords(items, mode, encrypt),
      adopt: (records) => {
        this.items = records;
        // Log restored items only now that they are actually persisted.
        const restored = records.filter((c) => this.#pendingRestored.has(c.id));
        this.#pendingRestored.clear();
        if (restored.length) {
          void this.#log(restored.map((c) => [c, "restored-from-backup"] as const));
        }
      },
      clear: () => {
        this.items = [];
        this.audit = [];
        this.#trustedUntil = 0;
      },
    };
  }

  // ---- vault hooks -------------------------------------------------------------

  async #exportPlain(
    decrypt: (blob: StoredCredential["password"]) => Promise<string>,
  ): Promise<BackupCredential[]> {
    const out: BackupCredential[] = [];
    for (const c of this.items) {
      out.push({
        ...clean(c),
        password: await decrypt(c.password),
        notes: c.notes ? await decrypt(c.notes) : "",
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        passwordUpdatedAt: c.passwordUpdatedAt,
        deletedAt: c.deletedAt,
      });
    }
    return out;
  }

  async #reseal(
    decrypt: (blob: StoredCredential["password"]) => Promise<string>,
    encrypt: (plain: string) => Promise<StoredCredential["password"]>,
  ): Promise<StoredCredential[]> {
    const out: StoredCredential[] = [];
    for (const c of this.items) {
      out.push({
        ...($state.snapshot(c) as StoredCredential),
        password: await encrypt(await decrypt(c.password)),
        notes: c.notes ? await encrypt(await decrypt(c.notes)) : null,
      });
    }
    return out;
  }

  async #restoreRecords(
    incoming: BackupCredential[],
    mode: "merge" | "replace",
    encrypt: (plain: string) => Promise<StoredCredential["password"]>,
  ): Promise<{ records: StoredCredential[]; added: number; skipped: number }> {
    const kept =
      mode === "merge" ? this.items.map((c) => $state.snapshot(c) as StoredCredential) : [];
    const seen = new Set(kept.map(credentialKey));
    const records = [...kept];
    let added = 0;
    let skipped = 0;
    for (const item of incoming) {
      const key = credentialKey(item);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      records.push({
        id: crypto.randomUUID(),
        ...clean(item),
        password: await encrypt(item.password),
        notes: item.notes ? await encrypt(item.notes) : null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        passwordUpdatedAt: item.passwordUpdatedAt,
        deletedAt: item.deletedAt,
      });
      added++;
    }
    this.#pendingRestored = new Set(records.slice(records.length - added).map((c) => c.id));
    return { records, added, skipped };
  }

  // ---- audit -----------------------------------------------------------------------

  async #log(events: ReadonlyArray<readonly [StoredCredential, AuditAction]>): Promise<void> {
    const now = Date.now();
    const records: AuditEvent[] = events.map(([c, action]) => ({
      id: crypto.randomUUID(),
      at: now,
      action,
      credentialId: c.id,
      platform: c.platform,
    }));
    try {
      await appendAudit(records);
      if (this.audit.length) this.audit = [...records.reverse(), ...this.audit];
    } catch {
      // Logging must never block the action it records.
    }
  }

  async loadAudit(): Promise<void> {
    this.audit = await loadAudit();
  }

  // ---- CRUD ------------------------------------------------------------------------

  #requireVault(): void {
    if (!authStore.encrypted) throw new Error("Set a master password first");
    if (authStore.locked) throw new Error("Unlock first");
  }

  #changed(): void {
    authStore.touch();
    authStore.notifyCredentialsChange(); // drives its encrypted cloud backup series
  }

  async add(input: CredentialInput): Promise<StoredCredential> {
    this.#requireVault();
    if (!input.platform.trim()) throw new Error("Enter a platform or application name");
    const now = Date.now();
    const credential: StoredCredential = {
      id: crypto.randomUUID(),
      ...clean(input),
      password: await authStore.encryptSecret(input.password ?? ""),
      notes: input.notes ? await authStore.encryptSecret(input.notes) : null,
      createdAt: now,
      updatedAt: now,
      passwordUpdatedAt: now,
      deletedAt: null,
    };
    await saveCredentials([credential]);
    this.items = [...this.items, credential];
    await this.#log([[credential, "created"]]);
    this.#changed();
    return credential;
  }

  async update(id: string, input: CredentialInput): Promise<void> {
    this.#requireVault();
    const current = this.items.find((c) => c.id === id);
    if (!current) throw new Error("That credential no longer exists");
    if (!input.platform.trim()) throw new Error("Enter a platform or application name");
    const now = Date.now();
    const passwordChanged = input.password !== null;
    const next: StoredCredential = {
      ...($state.snapshot(current) as StoredCredential),
      ...clean(input),
      updatedAt: now,
    };
    if (passwordChanged) {
      next.password = await authStore.encryptSecret(input.password ?? "");
      next.passwordUpdatedAt = now;
    }
    if (input.notes !== null) {
      next.notes = input.notes ? await authStore.encryptSecret(input.notes) : null;
    }
    await saveCredentials([next]);
    this.items = this.items.map((c) => (c.id === id ? next : c));
    await this.#log(
      passwordChanged ? [[next, "updated"], [next, "password-changed"]] : [[next, "updated"]],
    );
    this.#changed();
  }

  /** Soft delete: moves to the trash (restorable for 30 days). */
  async remove(id: string): Promise<void> {
    await this.#setDeleted(id, Date.now(), "deleted");
  }

  async restore(id: string): Promise<void> {
    await this.#setDeleted(id, null, "restored");
  }

  async #setDeleted(id: string, deletedAt: number | null, action: AuditAction): Promise<void> {
    this.#requireVault();
    const current = this.items.find((c) => c.id === id);
    if (!current) return;
    const next = { ...($state.snapshot(current) as StoredCredential), deletedAt };
    await saveCredentials([next]);
    this.items = this.items.map((c) => (c.id === id ? next : c));
    await this.#log([[next, action]]);
    this.#changed();
  }

  /** Permanently delete trashed credentials. */
  async purge(ids: string[]): Promise<void> {
    this.#requireVault();
    const doomed = this.items.filter((c) => ids.includes(c.id) && c.deletedAt !== null);
    if (doomed.length === 0) return;
    await deleteCredentials(doomed.map((c) => c.id));
    this.items = this.items.filter((c) => !doomed.includes(c));
    await this.#log(doomed.map((c) => [c, "purged"] as const));
    this.#changed();
  }

  async #purgeExpiredTrash(): Promise<void> {
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    const expired = this.items.filter((c) => c.deletedAt !== null && c.deletedAt < cutoff);
    if (expired.length === 0) return;
    // Plain deletion needs no key, so this works even while locked.
    await deleteCredentials(expired.map((c) => c.id));
    this.items = this.items.filter((c) => !expired.includes(c));
    await this.#log(expired.map((c) => [c, "purged"] as const));
    authStore.notifyCredentialsChange();
  }

  // ---- secrets (on demand, gated, audited) ----------------------------------------

  /**
   * Make sure it's really the user before showing a secret: Windows Hello
   * where available, otherwise the master password (via `prompt`). A success
   * is trusted for a minute; locking ends the trust immediately.
   */
  async #confirmUser(prompt: PasswordPrompt): Promise<void> {
    if (!authStore.settings.credentialsRevealAuth) return;
    if (Date.now() < this.#trustedUntil) return;
    // Windows Hello where available; a cancel rejects and nothing is shown.
    if (await authStore.verifyUserPresence()) {
      this.#trustedUntil = Date.now() + REVEAL_GRACE_MS;
      return;
    }
    const password = await prompt();
    if (password === null) throw new Error("canceled");
    if (!(await authStore.verifyPassword(password))) throw new Error("Wrong password");
    this.#trustedUntil = Date.now() + REVEAL_GRACE_MS;
  }

  /** Decrypted password for display; audited as "revealed". */
  async revealPassword(id: string, prompt: PasswordPrompt): Promise<string> {
    return this.#secret(id, prompt, "revealed");
  }

  /** Decrypted password for the clipboard; audited as "copied-password". */
  async passwordForCopy(id: string, prompt: PasswordPrompt): Promise<string> {
    return this.#secret(id, prompt, "copied-password");
  }

  async #secret(id: string, prompt: PasswordPrompt, action: AuditAction): Promise<string> {
    this.#requireVault();
    const credential = this.items.find((c) => c.id === id);
    if (!credential) throw new Error("That credential no longer exists");
    await this.#confirmUser(prompt);
    const plain = await authStore.decryptSecret(credential.password);
    authStore.touch();
    await this.#log([[credential, action]]);
    return plain;
  }

  /** Decrypted notes for the edit form (same gate; not separately audited). */
  async notesFor(id: string, prompt: PasswordPrompt): Promise<string> {
    this.#requireVault();
    const credential = this.items.find((c) => c.id === id);
    if (!credential?.notes) return "";
    await this.#confirmUser(prompt);
    return authStore.decryptSecret(credential.notes);
  }
}

export const credentialStore = new CredentialStore();
authStore.registerCredentials(credentialStore.vaultHooks());
