/**
 * Reactive state for the Credential Manager (Svelte 5 runes).
 *
 * Credentials share the Authenticator's vault: the AuthStore owns the key
 * and its lifecycle (unlock, auto-lock, password change, restore, wipe); this
 * store owns the credential records and plugs into those operations through
 * `CredentialVaultHooks` (registered at bootstrap, src/lib/vault-bootstrap.ts).
 *
 * At rest everything identifying is sealed (audit F-14): the metadata in
 * `meta`, the password and notes each in their own blob. In memory, while
 * unlocked, `items` carry the decrypted metadata for listing and search;
 * passwords and notes are decrypted ON DEMAND — only for the one credential
 * the user reveals, copies or edits — and never kept here. Revealing or
 * copying a password requires a fresh Windows Hello / master-password check
 * (trusted for a minute) when `credentialsRevealAuth` is on, and is written
 * to the tamper-evident audit log (F-19).
 */

import {
  authStore,
  type CredentialSnapshot,
  type CredentialVaultHooks,
  type VaultCrypto,
} from "../authenticator/store.svelte";
import {
  appendAuditRecords,
  deleteCredentials,
  loadAuditHead,
  loadAuditRecords,
  CREDENTIAL_ORDER_KEY,
  loadCredentialOrder,
  loadCredentials,
  loadSpaceOrder,
  replaceAuditRecords,
  saveCredentialOrder,
  saveCredentials,
  saveSpaceOrder,
  SPACE_ORDER_KEY,
  type StoredSealedList,
} from "../../core/authenticator/db";
import {
  credentialKey,
  TRASH_RETENTION_MS,
  type AuditAction,
  type AuditEvent,
  type BackupCredential,
  type CredentialFields,
  type StoredAuditEvent,
  type StoredCredential,
} from "../../core/credentials/types";
import {
  openChain,
  openHead,
  sealEvents,
  sealHead,
  type ChainCrypto,
  type ChainHead,
  type ChainStatus,
} from "../../core/credentials/audit-chain";
import { tombstoneKey, type Tombstone } from "../../core/authenticator/tombstones";
import { normalizeSpaceName } from "../../core/credentials/spaces";

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

const BLANK_FIELDS: CredentialFields = {
  platform: "",
  url: "",
  username: "",
  category: "",
  owner: "",
  tags: [],
  space: "",
};

function clean(fields: CredentialFields): CredentialFields {
  return {
    platform: fields.platform.trim(),
    url: fields.url.trim(),
    username: fields.username.trim(),
    category: fields.category.trim(),
    owner: fields.owner.trim(),
    tags: [...fields.tags],
    // Absent in records and backups made before spaces existed.
    space: normalizeSpaceName(fields.space ?? ""),
  };
}

/** Normalized, non-empty, case-insensitively distinct space names. */
function cleanOrder(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names
    .map(normalizeSpaceName)
    .filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

function snapshot(c: StoredCredential): StoredCredential {
  return JSON.parse(JSON.stringify(c)) as StoredCredential;
}

function chainCrypto(crypto: VaultCrypto): ChainCrypto {
  return { encrypt: crypto.encryptAad, decrypt: crypto.decryptAad };
}

export class CredentialStore {
  ready = $state(false);
  /** Decrypted metadata while unlocked; blank while locked. */
  items = $state<StoredCredential[]>([]);
  /** Loaded when the activity log is opened; newest first. */
  audit = $state<AuditEvent[]>([]);
  /** What verifying the audit log proved (F-19); null until loaded. */
  auditStatus = $state<ChainStatus | null>(null);
  /** The space tab on screen ("" = All); kept while switching app tabs. */
  activeSpace = $state("");
  /**
   * Spaces created this session that no login uses yet. Memory only: a space
   * is saved by the logins filed under it.
   */
  pendingSpaces = $state<string[]>([]);
  /**
   * The user's tab order, while unlocked. Sealed at rest (it names spaces),
   * per device — backups carry each login's space, not the arrangement.
   */
  spaceOrder = $state<string[]>([]);
  /** The user's own login order (credential ids), while unlocked. Sealed, per device. */
  credentialOrder = $state<string[]>([]);

  #initPromise: Promise<void> | null = null;
  #trustedUntil = 0;
  /** Ids created by a restore that hasn't been persisted yet. */
  #pendingRestored = new Set<string>();
  /** Audit appends run one at a time: each extends the chain head. */
  #auditQueue: Promise<void> = Promise.resolve();

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
      if (event === "lock" || event === "wipe") {
        this.#trustedUntil = 0;
        // Space names are login metadata: nothing of them stays in view when locked.
        this.activeSpace = "";
        this.pendingSpaces = [];
      }
      if (event === "unlock") void this.#afterUnlock();
    });
    this.ready = true;
  }

  /**
   * Registered with the vault at bootstrap — NOT when the tab first opens —
   * so a password change, restore or backup started from the Authenticator
   * always includes the credentials. Every hook the vault calls is preceded
   * by `ready()`, which loads the records first.
   */
  vaultHooks(): CredentialVaultHooks {
    return {
      ready: () => this.init(),
      count: () => this.items.length,
      open: (crypto) => this.#open(crypto),
      close: () => this.#close(),
      exportPlain: (decrypt) => this.#exportPlain(decrypt),
      reseal: (from, to) => this.#reseal(from, to),
      restore: (items, mode, crypto, tombstones) =>
        this.#restoreRecords(items, mode, crypto, tombstones),
      adopt: (snap) => {
        this.items = snap.view;
        // Log restored items only now that they are actually persisted.
        const restored = snap.view.filter((c) => this.#pendingRestored.has(c.id));
        this.#pendingRestored.clear();
        if (restored.length) {
          void this.#log(restored.map((c) => [c, "restored-from-backup"] as const));
        }
      },
      clear: () => {
        this.items = [];
        this.audit = [];
        this.auditStatus = null;
        this.#trustedUntil = 0;
        this.activeSpace = "";
        this.pendingSpaces = [];
        this.spaceOrder = [];
        this.credentialOrder = [];
      },
    };
  }

  // ---- sealing (F-14) -----------------------------------------------------------

  /** The on-disk form: metadata sealed, plaintext fields empty. */
  async #toStored(c: StoredCredential, crypto: VaultCrypto): Promise<StoredCredential> {
    const plain = snapshot(c);
    const meta = await crypto.encrypt(JSON.stringify(clean(plain)));
    return { ...plain, ...BLANK_FIELDS, meta };
  }

  /** Persist records, keeping each in-memory record's `meta` in step with disk. */
  async #persist(records: StoredCredential[]): Promise<void> {
    const crypto = authStore.vaultCrypto();
    const stored = await Promise.all(records.map((c) => this.#toStored(c, crypto)));
    await saveCredentials(stored);
    records.forEach((c, i) => (c.meta = stored[i].meta));
  }

  async #open(crypto: VaultCrypto): Promise<void> {
    await this.init();
    const view: StoredCredential[] = [];
    let unsealed = false;
    for (const c of this.items) {
      const record = snapshot(c);
      if (record.meta) {
        const fields = JSON.parse(await crypto.decrypt(record.meta)) as CredentialFields;
        view.push({ ...record, ...clean(fields) });
      } else {
        view.push({ ...record, ...clean(record) });
        unsealed = true;
      }
    }
    if (unsealed) {
      // Records written before 1.2 kept their metadata in the clear.
      const stored = await Promise.all(view.map((c) => this.#toStored(c, crypto)));
      await saveCredentials(stored);
      view.forEach((c, i) => (c.meta = stored[i].meta));
    }
    this.items = view;
    this.spaceOrder = cleanOrder(await this.#openList(loadSpaceOrder, crypto));
    this.credentialOrder = [...new Set(await this.#openList(loadCredentialOrder, crypto))];
  }

  /** A saved order; one sealed under an older key reads as none. */
  async #openList(
    load: () => Promise<StoredSealedList | undefined>,
    crypto: VaultCrypto,
  ): Promise<string[]> {
    const stored = await load();
    if (!stored) return [];
    try {
      const list: unknown = JSON.parse(await crypto.decrypt(stored.sealed));
      return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [];
    } catch {
      return [];
    }
  }

  #close(): void {
    this.items = this.items.map((c) => (c.meta ? { ...snapshot(c), ...BLANK_FIELDS } : c));
    this.spaceOrder = [];
    this.credentialOrder = [];
    this.audit = [];
    this.auditStatus = null;
    this.#trustedUntil = 0;
  }

  /** Maintenance that needs the key: trash expiry and sealing an old audit log. */
  async #afterUnlock(): Promise<void> {
    try {
      await this.#sealLegacyAudit();
      await this.#purgeExpiredTrash();
    } catch {
      // Best effort; retried on the next unlock.
    }
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

  async #reseal(from: VaultCrypto, to: VaultCrypto): Promise<CredentialSnapshot> {
    const stored: StoredCredential[] = [];
    const view: StoredCredential[] = [];
    for (const c of this.items) {
      const next: StoredCredential = {
        ...snapshot(c),
        password: await to.encrypt(await from.decrypt(c.password)),
        notes: c.notes ? await to.encrypt(await from.decrypt(c.notes)) : null,
      };
      const sealed = await this.#toStored(next, to);
      stored.push(sealed);
      view.push({ ...next, meta: sealed.meta });
    }
    // The audit log moves to the new key as a fresh chain with the same events.
    const { events } = await this.#openAudit(from);
    const chain = await sealEvents([...events].reverse(), null, chainCrypto(to));
    const head = chain.records.length
      ? { sealed: await sealHead(chain.head, chainCrypto(to)) }
      : null;
    // The saved orders (tabs, logins) move to the new key too.
    const meta: Record<string, StoredSealedList> = {};
    if (this.spaceOrder.length) {
      meta[SPACE_ORDER_KEY] = { sealed: await to.encrypt(JSON.stringify(this.spaceOrder)) };
    }
    if (this.credentialOrder.length) {
      meta[CREDENTIAL_ORDER_KEY] = { sealed: await to.encrypt(JSON.stringify(this.credentialOrder)) };
    }
    return { stored, view, audit: { records: chain.records, head }, meta };
  }

  async #restoreRecords(
    incoming: BackupCredential[],
    mode: "merge" | "replace",
    crypto: VaultCrypto,
    tombstones: { local: Tombstone[]; remote: Tombstone[] },
  ): Promise<CredentialSnapshot & { added: number; skipped: number; removed: number; revived: string[] }> {
    let kept = mode === "merge" ? this.items.map(snapshot) : [];

    // Deletions another device recorded after this record last changed here.
    let removed = 0;
    if (mode === "merge" && tombstones.remote.length) {
      const remote = new Map(tombstones.remote.map((t) => [t.k, t.at]));
      const survivors: StoredCredential[] = [];
      for (const c of kept) {
        const at = remote.get(await tombstoneKey(credentialKey(c)));
        if (at !== undefined && c.updatedAt < at) {
          removed++;
          continue;
        }
        survivors.push(c);
      }
      kept = survivors;
    }

    const seen = new Set(kept.map(credentialKey));
    const deletedHere = new Set(mode === "merge" ? tombstones.local.map((t) => t.k) : []);
    const view = [...kept];
    const revived: string[] = [];
    let added = 0;
    let skipped = 0;
    for (const item of incoming) {
      const key = credentialKey(item);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      const k = await tombstoneKey(key);
      if (deletedHere.has(k)) {
        skipped++; // permanently deleted on this device — a merge doesn't bring it back
        continue;
      }
      seen.add(key);
      revived.push(k);
      view.push({
        id: globalThis.crypto.randomUUID(), // `crypto` here is the vault's
        ...clean(item),
        password: await crypto.encrypt(item.password),
        notes: item.notes ? await crypto.encrypt(item.notes) : null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        passwordUpdatedAt: item.passwordUpdatedAt,
        deletedAt: item.deletedAt,
      });
      added++;
    }
    const stored = await Promise.all(view.map((c) => this.#toStored(c, crypto)));
    view.forEach((c, i) => (c.meta = stored[i].meta));
    this.#pendingRestored = new Set(view.slice(view.length - added).map((c) => c.id));
    return { stored, view, added, skipped, removed, revived };
  }

  // ---- audit (F-19) ---------------------------------------------------------------

  async #openAudit(crypto: VaultCrypto): Promise<{ events: AuditEvent[]; status: ChainStatus }> {
    const [records, head] = await Promise.all([loadAuditRecords(), loadAuditHead()]);
    return openChain(records, head?.sealed ?? null, chainCrypto(crypto));
  }

  /** Seal a pre-1.2 plaintext log into the chain (oldest first). */
  async #sealLegacyAudit(): Promise<void> {
    const records = await loadAuditRecords();
    if (records.length === 0 || records.every((r) => r.sealed)) return;
    const crypto = authStore.vaultCrypto();
    const legacy: AuditEvent[] = records
      .filter((r): r is StoredAuditEvent & { action: AuditAction } => !r.sealed && !!r.action)
      .sort((a, b) => a.at - b.at)
      .map((r) => ({
        id: r.id,
        at: r.at,
        action: r.action,
        credentialId: r.credentialId ?? "",
        platform: r.platform ?? "",
      }));
    const chain = await sealEvents(legacy, null, chainCrypto(crypto));
    await replaceAuditRecords(chain.records, {
      sealed: await sealHead(chain.head, chainCrypto(crypto)),
    });
  }

  async #log(events: ReadonlyArray<readonly [StoredCredential, AuditAction]>): Promise<void> {
    const now = Date.now();
    const records: AuditEvent[] = events.map(([c, action]) => ({
      id: crypto.randomUUID(),
      at: now,
      action,
      credentialId: c.id,
      platform: c.platform,
    }));
    const run = this.#auditQueue.then(async () => {
      const vault = chainCrypto(authStore.vaultCrypto());
      const stored = await loadAuditHead();
      let head: ChainHead | null = null;
      if (stored) head = await openHead(stored.sealed, vault);
      const chain = await sealEvents(records, head, vault);
      await appendAuditRecords(chain.records, { sealed: await sealHead(chain.head, vault) });
      if (this.audit.length) this.audit = [...[...records].reverse(), ...this.audit];
    });
    this.#auditQueue = run.catch(() => {});
    try {
      await run;
    } catch {
      // Logging must never block the action it records.
    }
  }

  /** Decrypt and verify the log for display. Requires unlocked. */
  async loadAudit(): Promise<void> {
    await this.#auditQueue;
    const { events, status } = await this.#openAudit(authStore.vaultCrypto());
    this.audit = events;
    this.auditStatus = status;
  }

  /**
   * The log as a JSON document for an auditor: the events, the verification
   * result and the chain head, so a later export can be checked against it.
   */
  async exportAudit(appVersion: string): Promise<string> {
    await this.loadAudit();
    const status = this.auditStatus;
    return JSON.stringify(
      {
        format: "coretools-audit-export-v1",
        exportedAt: new Date().toISOString(),
        app: `CoreTools ${appVersion}`,
        integrity:
          status?.state === "verified"
            ? { verified: true, events: status.count, head: status.head }
            : { verified: false, reason: status?.state === "tampered" ? status.reason : "unknown" },
        events: this.audit.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
      },
      null,
      2,
    );
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
    await this.#persist([credential]);
    this.items = [...this.items, credential];
    await authStore.forgetCredentialDeletions([credentialKey(credential)]);
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
      ...snapshot(current),
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
    await this.#persist([next]);
    this.items = this.items.map((c) => (c.id === id ? next : c));
    await authStore.forgetCredentialDeletions([credentialKey(next)]);
    await this.#log(
      passwordChanged ? [[next, "updated"], [next, "password-changed"]] : [[next, "updated"]],
    );
    this.#changed();
  }

  /**
   * File logins under `space` ("" = no space) in one write: moving a login,
   * renaming a space (all its logins, trashed ones included, so a restore
   * lands in the renamed space) or removing one (its logins stay saved).
   */
  async moveToSpace(ids: readonly string[], space: string): Promise<number> {
    this.#requireVault();
    const target = normalizeSpaceName(space);
    const now = Date.now();
    const moved = this.items
      .filter((c) => ids.includes(c.id) && c.space !== target)
      .map((c) => ({ ...snapshot(c), space: target, updatedAt: now }));
    if (moved.length === 0) return 0;
    await this.#persist(moved);
    const byId = new Map(moved.map((c) => [c.id, c]));
    this.items = this.items.map((c) => byId.get(c.id) ?? c);
    await this.#log(moved.map((c) => [c, "updated"] as const));
    this.#changed();
    return moved.length;
  }

  /** Save the tab order (a view setting: not audited, not backed up). */
  async setSpaceOrder(order: readonly string[]): Promise<void> {
    this.#requireVault();
    const next = cleanOrder(order);
    const sealed = await authStore.vaultCrypto().encrypt(JSON.stringify(next));
    await saveSpaceOrder({ sealed });
    this.spaceOrder = next;
  }

  /**
   * Save the user's own login order ([] = back to A–Z). Ids no longer in the
   * vault are dropped. A view setting: not audited, not backed up.
   */
  async setCredentialOrder(ids: readonly string[]): Promise<void> {
    this.#requireVault();
    const known = new Set(this.items.map((c) => c.id));
    const next = [...new Set(ids)].filter((id) => known.has(id));
    const sealed = await authStore.vaultCrypto().encrypt(JSON.stringify(next));
    await saveCredentialOrder({ sealed });
    this.credentialOrder = next;
  }

  /** Ids of every login (trash included) filed under `space`. */
  idsInSpace(space: string): string[] {
    return space ? this.items.filter((c) => c.space === space).map((c) => c.id) : [];
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
    // updatedAt moves too, so a deletion recorded elsewhere earlier doesn't win.
    const next = { ...snapshot(current), deletedAt, updatedAt: Date.now() };
    await this.#persist([next]);
    this.items = this.items.map((c) => (c.id === id ? next : c));
    await this.#log([[next, action]]);
    this.#changed();
  }

  /** Permanently delete trashed credentials. */
  async purge(ids: string[]): Promise<void> {
    this.#requireVault();
    const doomed = this.items.filter((c) => ids.includes(c.id) && c.deletedAt !== null);
    if (doomed.length === 0) return;
    await this.#forget(doomed);
    this.#changed();
  }

  async #forget(doomed: StoredCredential[]): Promise<void> {
    await deleteCredentials(doomed.map((c) => c.id));
    this.items = this.items.filter((c) => !doomed.includes(c));
    // So an older backup merged later doesn't bring them back (F-09).
    await authStore.recordCredentialDeletions(doomed.map(credentialKey));
    await this.#log(doomed.map((c) => [c, "purged"] as const));
  }

  async #purgeExpiredTrash(): Promise<void> {
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    const expired = this.items.filter((c) => c.deletedAt !== null && c.deletedAt < cutoff);
    if (expired.length === 0) return;
    await this.#forget(expired);
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
