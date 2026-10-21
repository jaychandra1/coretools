/**
 * Reactive state for the Credential Manager (Svelte 5 runes).
 *
 * Credentials share the Authenticator's vault: the AuthStore owns the key
 * and its lifecycle (unlock, auto-lock, password change, restore, wipe); this
 * store owns the credential records and plugs into those operations through
 * `CredentialVaultHooks` (registered at bootstrap, src/lib/vault-bootstrap.ts).
 *
 * At rest everything identifying is sealed (audit F-14): the metadata in
 * `meta`, the password and notes each in their own blob, each bound to its
 * record and field (L2). In memory, while unlocked, `items` carry the
 * decrypted metadata for listing and search; passwords and notes are
 * decrypted ON DEMAND — only for the one credential the user reveals,
 * copies or edits — and never kept here. Revealing or copying a password
 * requires a fresh Windows Hello / master-password check (trusted for a
 * minute) when `credentialsRevealAuth` is on, and is written to the
 * tamper-evident audit log (F-19).
 */

import {
  authStore,
  type CredentialSnapshot,
  type CredentialVaultHooks,
  type PasswordPrompt,
  type VaultCrypto,
} from "../authenticator/store.svelte";
import {
  appendAuditRecords,
  loadAuditHead,
  loadAuditRecords,
  CREDENTIAL_ORDER_KEY,
  loadCredentials,
  loadSealedList,
  replaceAuditRecords,
  saveCredentials,
  saveSealedList,
  SPACE_ORDER_KEY,
  StaleVaultError,
  type SealedListKey,
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
import type { Tombstone } from "../../core/authenticator/tombstones";
import { isUnbound, recordBinding, type FieldBinding } from "../../core/authenticator/vault-crypto";
import { inBatches } from "../../core/batches";
import { planMerge } from "../../core/authenticator/merge";
import { normalizeSpaceName } from "../../core/credentials/spaces";
import { noteFailure } from "../../diagnostics";

export type { PasswordPrompt } from "../authenticator/store.svelte";

export interface CredentialInput extends CredentialFields {
  /** New password; null keeps the current one (edit). */
  password: string | null;
  /** New notes; null keeps the current ones (edit). */
  notes: string | null;
}

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
  return $state.snapshot(c) as StoredCredential;
}

function chainCrypto(crypto: VaultCrypto): ChainCrypto {
  return { encrypt: crypto.encryptAad, decrypt: crypto.decryptAad };
}

/** Where a credential's encrypted field is bound (audit L2). */
function bound(id: string, field: "meta" | "password" | "notes"): FieldBinding {
  return { kind: "credential", id, field };
}

/** A saved order (space names or credential ids), sealed under the vault key, bound to `key`. */
async function sealList(
  list: readonly string[],
  crypto: VaultCrypto,
  key: SealedListKey,
): Promise<StoredSealedList> {
  return { sealed: await crypto.seal(JSON.stringify(list), recordBinding(key)) };
}

/** Audit appends retry this often when another write got in first (D-1). */
const AUDIT_ATTEMPTS = 3;

export class CredentialStore {
  ready = $state(false);
  /** Decrypted metadata while unlocked; blank while locked. */
  items = $state<StoredCredential[]>([]);
  /** Loaded when the activity log is opened; newest first. */
  audit = $state<AuditEvent[]>([]);
  /** What verifying the audit log proved (F-19); null until loaded. */
  auditStatus = $state<ChainStatus | null>(null);
  /** An event couldn't be appended to the audit log this session (D-9). */
  auditWriteFailed = $state(false);
  /** Logins that couldn't be decrypted and are set aside (D-2). */
  unreadable = $state(0);
  /** Logins the trash deleted for good this session after TRASH_RETENTION_MS (shown once). */
  autoPurged = $state(0);
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
  /** Records that failed to decrypt: kept as stored, out of `items` (D-2). */
  #damaged: StoredCredential[] = [];
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
      // Read from disk, not memory: another window may have written since.
      open: async (crypto) => {
        await this.init();
        await this.#open(crypto, await loadCredentials());
      },
      close: () => this.#close(),
      exportPlain: (crypto) => this.#exportPlain(crypto),
      reseal: (from, to) => this.#reseal(from, to),
      restore: (items, mode, crypto, tombstones) =>
        this.#restoreRecords(items, mode, crypto, tombstones),
      adopt: (snap) => {
        this.items = snap.view;
        if (snap.damaged) {
          this.#damaged = snap.damaged;
          this.unreadable = snap.damaged.length;
        }
        // Log restored items only now that they are actually persisted.
        const restored = snap.view.filter((c) => this.#pendingRestored.has(c.id));
        this.#pendingRestored.clear();
        if (restored.length) {
          void this.#log(restored.map((c) => [c, "restored-from-backup"] as const));
        }
      },
      reload: async (crypto) => {
        await this.init();
        const records = await loadCredentials();
        if (crypto) {
          // Still unlocked: decrypted before it replaces what is shown.
          await this.#open(crypto, records);
          return;
        }
        this.items = records;
        this.#damaged = [];
        this.unreadable = 0;
        this.#close();
      },
      clear: () => {
        this.items = [];
        this.#damaged = [];
        this.unreadable = 0;
        this.audit = [];
        this.auditStatus = null;
        this.auditWriteFailed = false;
        this.activeSpace = "";
        this.pendingSpaces = [];
        this.spaceOrder = [];
        this.credentialOrder = [];
      },
    };
  }

  // ---- sealing (F-14, L2) ---------------------------------------------------------

  /** The on-disk form: metadata sealed, plaintext fields empty. */
  async #toStored(c: StoredCredential, crypto: VaultCrypto): Promise<StoredCredential> {
    const plain = snapshot(c);
    const meta = await crypto.seal(JSON.stringify(clean(plain)), bound(plain.id, "meta"));
    return { ...plain, ...BLANK_FIELDS, meta };
  }

  /**
   * Persist records, keeping each in-memory record's `meta` in step with
   * disk. Refused when the vault was replaced since `epoch` (D-1).
   */
  async #persist(records: StoredCredential[], epoch: number): Promise<void> {
    const crypto = authStore.vaultCrypto();
    const stored = await Promise.all(records.map((c) => this.#toStored(c, crypto)));
    authStore.assertCurrent(epoch);
    await saveCredentials(stored);
    records.forEach((c, i) => (c.meta = stored[i].meta));
  }

  /**
   * Decrypt every record's metadata (`records`: as read from disk; by default
   * the ones in memory) and make it the state; set aside the ones that won't
   * open (D-2). Nothing on screen changes until all of it is decrypted.
   */
  async #open(
    crypto: VaultCrypto,
    records: StoredCredential[] = [...this.items, ...this.#damaged],
  ): Promise<void> {
    await this.init();
    const epoch = authStore.epoch;
    const candidates = records.map(snapshot);
    const opened = await inBatches(candidates, async (record) => {
      try {
        const fields = record.meta
          ? (JSON.parse(await crypto.open(record.meta, bound(record.id, "meta"))) as CredentialFields)
          : record;
        return { ...record, ...clean(fields) };
      } catch (e) {
        noteFailure("credentials", "login unreadable", e);
        return null;
      }
    });
    const view: StoredCredential[] = [];
    const damaged: StoredCredential[] = [];
    const legacy: StoredCredential[] = [];
    opened.forEach((record, i) => {
      if (!record) {
        damaged.push(candidates[i]);
        return;
      }
      view.push(record);
      // Records from before 1.2 (clear metadata) or 1.3 (unbound fields).
      if (!record.meta || isUnbound(record.meta) || isUnbound(record.password) || isUnbound(record.notes)) {
        legacy.push(record);
      }
    });
    if (legacy.length) await this.#upgrade(legacy, crypto, epoch);
    const spaceOrder = cleanOrder(await this.#openList(SPACE_ORDER_KEY, crypto));
    const credentialOrder = [...new Set(await this.#openList(CREDENTIAL_ORDER_KEY, crypto))];
    // Locked or read again meanwhile: what was decrypted here no longer
    // applies (and must not reappear in a locked vault). The caller retries.
    if (authStore.epoch !== epoch) return;
    this.items = view;
    this.#damaged = damaged;
    this.unreadable = damaged.length;
    this.spaceOrder = spaceOrder;
    this.credentialOrder = credentialOrder;
  }

  /** Seal older records the current way: metadata sealed, every field bound. */
  async #upgrade(records: StoredCredential[], crypto: VaultCrypto, epoch: number): Promise<void> {
    try {
      for (const record of records) {
        record.password = await crypto.seal(
          await crypto.open(record.password, bound(record.id, "password")),
          bound(record.id, "password"),
        );
        if (record.notes) {
          record.notes = await crypto.seal(
            await crypto.open(record.notes, bound(record.id, "notes")),
            bound(record.id, "notes"),
          );
        }
      }
      const stored = await Promise.all(records.map((c) => this.#toStored(c, crypto)));
      authStore.assertCurrent(epoch);
      await saveCredentials(stored);
      records.forEach((c, i) => (c.meta = stored[i].meta));
    } catch (e) {
      // They stay readable as they are; retried on the next unlock.
      noteFailure("credentials", "upgrade of older logins failed", e);
    }
  }

  /** A saved order. An unreadable one reads as none: the list falls back to A–Z. */
  async #openList(key: SealedListKey, crypto: VaultCrypto): Promise<string[]> {
    const stored = await loadSealedList(key);
    if (!stored) return [];
    try {
      const list: unknown = JSON.parse(await crypto.open(stored.sealed, recordBinding(key)));
      return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [];
    } catch (e) {
      noteFailure("credentials", `${key} unreadable`, e);
      return [];
    }
  }

  #close(): void {
    this.items = this.items.map((c) => (c.meta ? { ...snapshot(c), ...BLANK_FIELDS } : c));
    this.spaceOrder = [];
    this.credentialOrder = [];
    this.audit = [];
    this.auditStatus = null;
  }

  /** Maintenance that needs the key: trash expiry and sealing an old audit log. */
  async #afterUnlock(): Promise<void> {
    try {
      await this.#sealLegacyAudit();
      await this.#purgeExpiredTrash();
    } catch (e) {
      // Best effort; retried on the next unlock.
      noteFailure("credentials", "unlock maintenance failed", e);
    }
  }

  // ---- vault hooks -------------------------------------------------------------

  async #exportPlain(crypto: VaultCrypto): Promise<BackupCredential[]> {
    const out: BackupCredential[] = [];
    for (const c of this.items) {
      out.push({
        ...clean(c),
        password: await crypto.open(c.password, bound(c.id, "password")),
        notes: c.notes ? await crypto.open(c.notes, bound(c.id, "notes")) : "",
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
        password: await to.seal(
          await from.open(c.password, bound(c.id, "password")),
          bound(c.id, "password"),
        ),
        notes: c.notes
          ? await to.seal(await from.open(c.notes, bound(c.id, "notes")), bound(c.id, "notes"))
          : null,
      };
      const sealed = await this.#toStored(next, to);
      stored.push(sealed);
      view.push({ ...next, meta: sealed.meta });
    }
    // The audit log moves to the new key as a fresh chain with the same
    // events. A tampered log isn't laundered into a "verified" one: the new
    // chain carries what could be verified plus a record of the reset (D-9).
    const { events, status } = await this.#openAudit(from);
    const carried = [...events].reverse();
    if (status.state === "tampered") {
      carried.push({ id: crypto.randomUUID(), at: Date.now(), action: "log-reset", credentialId: "", platform: "" });
    }
    const chain = await sealEvents(carried, null, chainCrypto(to));
    const head = chain.records.length
      ? { sealed: await sealHead(chain.head, chainCrypto(to)) }
      : null;
    // The saved orders (tabs, logins) move to the new key too.
    const meta: Partial<Record<SealedListKey, StoredSealedList>> = {};
    if (this.spaceOrder.length) {
      meta[SPACE_ORDER_KEY] = await sealList(this.spaceOrder, to, SPACE_ORDER_KEY);
    }
    if (this.credentialOrder.length) {
      meta[CREDENTIAL_ORDER_KEY] = await sealList(this.credentialOrder, to, CREDENTIAL_ORDER_KEY);
    }
    // Logins that couldn't be decrypted stay as they are (D-2, NEW-5).
    return {
      stored: [...stored, ...this.#damaged],
      view,
      audit: { records: chain.records, head },
      meta,
    };
  }

  async #restoreRecords(
    incoming: BackupCredential[],
    mode: "merge" | "replace",
    vault: VaultCrypto,
    tombstones: { local: Tombstone[]; remote: Tombstone[] },
  ): Promise<
    CredentialSnapshot & {
      added: number;
      updated: number;
      skipped: number;
      removed: number;
      revived: string[];
    }
  > {
    const plan = await planMerge({
      mode,
      local: this.items.map(snapshot),
      incoming,
      localKey: credentialKey,
      incomingKey: credentialKey,
      // A deletion elsewhere wins only if it came after this login last changed here.
      changedAt: (c) => c.updatedAt,
      // Last writer wins: a newer copy in the backup replaces this one (D-3).
      isNewer: (here, there) => there.updatedAt > here.updatedAt,
      tombstones,
    });
    const fromBackup = async (id: string, item: BackupCredential): Promise<StoredCredential> => ({
      id,
      ...clean(item),
      password: await vault.seal(item.password, bound(id, "password")),
      notes: item.notes ? await vault.seal(item.notes, bound(id, "notes")) : null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      passwordUpdatedAt: item.passwordUpdatedAt,
      deletedAt: item.deletedAt,
    });
    const replaced = new Map<string, StoredCredential>();
    for (const [here, there] of plan.updated) replaced.set(here.id, await fromBackup(here.id, there));
    const view = plan.kept.map((c) => replaced.get(c.id) ?? c);
    for (const item of plan.added) view.push(await fromBackup(crypto.randomUUID(), item));
    const stored = await Promise.all(view.map((c) => this.#toStored(c, vault)));
    view.forEach((c, i) => (c.meta = stored[i].meta));
    this.#pendingRestored = new Set([
      ...view.slice(plan.kept.length).map((c) => c.id),
      ...replaced.keys(),
    ]);
    // Logins that couldn't be decrypted survive a merge, not a replace (NEW-5).
    const damaged = mode === "merge" ? this.#damaged : [];
    return {
      stored: [...stored, ...damaged],
      view,
      damaged,
      added: plan.added.length,
      updated: plan.updated.length,
      skipped: plan.skipped,
      removed: plan.removed,
      revived: plan.revived,
    };
  }

  // ---- audit (F-19) ---------------------------------------------------------------

  async #openAudit(crypto: VaultCrypto): Promise<{ events: AuditEvent[]; status: ChainStatus }> {
    const [records, head] = await Promise.all([loadAuditRecords(), loadAuditHead()]);
    return openChain(records, head?.sealed ?? null, chainCrypto(crypto));
  }

  /**
   * Seal a pre-1.2 plaintext log into the chain (oldest first). Only a log
   * that is entirely plaintext, with no chain head, is migrated: an unsealed
   * record next to sealed ones is tampering, and re-sealing it would erase
   * the real history (audit S-4). openChain reports it instead.
   */
  async #sealLegacyAudit(): Promise<void> {
    const epoch = await authStore.beginWrite();
    const [records, head] = await Promise.all([loadAuditRecords(), loadAuditHead()]);
    if (records.length === 0 || head || records.some((r) => r.sealed)) return;
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
    // Nothing proves these weren't planted (deleting a sealed log and its
    // head looks just like a pre-1.2 one): the log says where they came from.
    legacy.push({ id: globalThis.crypto.randomUUID(), at: Date.now(), action: "log-imported", credentialId: "", platform: "" });
    const chain = await sealEvents(legacy, null, chainCrypto(crypto));
    const sealed = await sealHead(chain.head, chainCrypto(crypto));
    authStore.assertCurrent(epoch);
    await replaceAuditRecords(chain.records, { sealed });
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
      // The chain head is read fresh each time; another window's write
      // getting in first only means extending the chain from its new head.
      for (let attempt = 1; ; attempt++) {
        try {
          const vault = chainCrypto(authStore.vaultCrypto());
          const stored = await loadAuditHead();
          let head: ChainHead | null = null;
          if (stored) head = await openHead(stored.sealed, vault);
          const chain = await sealEvents(records, head, vault);
          const sealed = await sealHead(chain.head, vault);
          // Refused if the head moved since it was read (another window appended).
          await appendAuditRecords(chain.records, { sealed }, stored);
          break;
        } catch (e) {
          if (!(e instanceof StaleVaultError) || attempt >= AUDIT_ATTEMPTS) throw e;
          await authStore.beginWrite();
        }
      }
      if (this.audit.length) this.audit = [...[...records].reverse(), ...this.audit];
    });
    this.#auditQueue = run.catch(() => {}); // the failure is noted below
    try {
      await run;
    } catch (e) {
      // Logging must never block the action it records — but it must not
      // fail unnoticed either: the activity log says so.
      this.auditWriteFailed = true;
      noteFailure("audit", "append failed", e);
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
    const epoch = await authStore.beginWrite();
    const now = Date.now();
    const id = crypto.randomUUID();
    const credential: StoredCredential = {
      id,
      ...clean(input),
      password: await authStore.sealSecret(input.password ?? "", bound(id, "password")),
      notes: input.notes ? await authStore.sealSecret(input.notes, bound(id, "notes")) : null,
      createdAt: now,
      updatedAt: now,
      passwordUpdatedAt: now,
      deletedAt: null,
    };
    await this.#persist([credential], epoch);
    this.items = [...this.items, credential];
    await authStore.forgetCredentialDeletions([credentialKey(credential)], epoch);
    await this.#log([[credential, "created"]]);
    this.#changed();
    return credential;
  }

  async update(id: string, input: CredentialInput): Promise<void> {
    this.#requireVault();
    const epoch = await authStore.beginWrite();
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
      next.password = await authStore.sealSecret(input.password ?? "", bound(id, "password"));
      next.passwordUpdatedAt = now;
    }
    if (input.notes !== null) {
      next.notes = input.notes ? await authStore.sealSecret(input.notes, bound(id, "notes")) : null;
    }
    await this.#persist([next], epoch);
    this.items = this.items.map((c) => (c.id === id ? next : c));
    await authStore.forgetCredentialDeletions([credentialKey(next)], epoch);
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
    const epoch = await authStore.beginWrite();
    const target = normalizeSpaceName(space);
    const now = Date.now();
    const moved = this.items
      .filter((c) => ids.includes(c.id) && c.space !== target)
      .map((c) => ({ ...snapshot(c), space: target, updatedAt: now }));
    if (moved.length === 0) return 0;
    await this.#persist(moved, epoch);
    const byId = new Map(moved.map((c) => [c.id, c]));
    this.items = this.items.map((c) => byId.get(c.id) ?? c);
    await this.#log(moved.map((c) => [c, "updated"] as const));
    this.#changed();
    return moved.length;
  }

  /** Save the tab order (a view setting: not audited, not backed up). */
  async setSpaceOrder(order: readonly string[]): Promise<void> {
    this.#requireVault();
    const epoch = await authStore.beginWrite();
    const next = cleanOrder(order);
    const sealed = await sealList(next, authStore.vaultCrypto(), SPACE_ORDER_KEY);
    authStore.assertCurrent(epoch);
    await saveSealedList(SPACE_ORDER_KEY, sealed);
    this.spaceOrder = next;
  }

  /**
   * Save the user's own login order ([] = back to A–Z). Ids no longer in the
   * vault are dropped. A view setting: not audited, not backed up.
   */
  async setCredentialOrder(ids: readonly string[]): Promise<void> {
    this.#requireVault();
    const epoch = await authStore.beginWrite();
    const known = new Set(this.items.map((c) => c.id));
    const next = [...new Set(ids)].filter((id) => known.has(id));
    const sealed = await sealList(next, authStore.vaultCrypto(), CREDENTIAL_ORDER_KEY);
    authStore.assertCurrent(epoch);
    await saveSealedList(CREDENTIAL_ORDER_KEY, sealed);
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
    const epoch = await authStore.beginWrite();
    const current = this.items.find((c) => c.id === id);
    if (!current) return;
    // updatedAt moves too, so a deletion recorded elsewhere earlier doesn't win.
    const next = { ...snapshot(current), deletedAt, updatedAt: Date.now() };
    await this.#persist([next], epoch);
    this.items = this.items.map((c) => (c.id === id ? next : c));
    await this.#log([[next, action]]);
    this.#changed();
  }

  /** Permanently delete trashed credentials. */
  async purge(ids: string[]): Promise<void> {
    this.#requireVault();
    const epoch = await authStore.beginWrite();
    const doomed = this.items.filter((c) => ids.includes(c.id) && c.deletedAt !== null);
    if (doomed.length === 0) return;
    await this.#forget(doomed, epoch);
    this.#changed();
  }

  /**
   * Delete for good, recording the deletions so an older backup merged later
   * doesn't bring them back (F-09) — both in one transaction (D-6).
   */
  async #forget(doomed: StoredCredential[], epoch: number): Promise<void> {
    await authStore.deleteCredentials(
      doomed.map((c) => c.id),
      doomed.map(credentialKey),
      epoch,
    );
    this.items = this.items.filter((c) => !doomed.includes(c));
    await this.#log(doomed.map((c) => [c, "purged"] as const));
  }

  async #purgeExpiredTrash(): Promise<void> {
    const epoch = await authStore.beginWrite();
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    const expired = this.items.filter((c) => c.deletedAt !== null && c.deletedAt < cutoff);
    if (expired.length === 0) return;
    await this.#forget(expired, epoch);
    this.autoPurged += expired.length; // the Credential Manager says so
    authStore.notifyCredentialsChange();
  }

  // ---- secrets (on demand, gated, audited) ----------------------------------------

  /** The reveal check, when the setting asks for it (F-19). */
  async #confirmUser(prompt: PasswordPrompt): Promise<void> {
    // Revealing several logins in a row asks once a minute, not every time.
    if (authStore.settings.credentialsRevealAuth) await authStore.confirmUser(prompt, { reuse: true });
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
    const plain = await authStore.openSecret(credential.password, bound(id, "password"));
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
    return authStore.openSecret(credential.notes, bound(id, "notes"));
  }
}

export const credentialStore = new CredentialStore();
