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
 * password unlock without re-encrypting anything. Each record's encrypted
 * fields are bound to the record (L2); older ones are re-sealed on unlock.
 *
 * Other collections (the Credential Manager) take part in every vault-wide
 * operation through registered hooks; registration happens explicitly at
 * bootstrap (src/lib/vault-bootstrap.ts), and an operation that would
 * re-key the vault refuses to run if stored credentials exist but their
 * collection isn't registered (F-18).
 *
 * Robustness: when another window writes, this one reads the vault again —
 * staying unlocked unless the key changed — and a write prepared from the
 * state it replaced is refused (D-1, db.ts; see #epoch); a record that can't
 * be decrypted is set aside instead of blocking unlock, and kept through
 * vault-wide writes (D-2); destructive operations take a local snapshot
 * first (D-8).
 */

import type { ParsedAccount } from "../../core/authenticator/types";
import {
  countCredentials,
  DEFAULT_SETTINGS,
  deleteSnapshotsBefore,
  deleteWithTombstones,
  listSnapshots as dbListSnapshots,
  loadSettings,
  loadSnapshotVault,
  loadTombstones,
  loadVaultState,
  NewerDataError,
  restoreEntryWithTombstones,
  restoreSnapshot as dbRestoreSnapshot,
  saveEntries,
  saveSettings,
  saveTombstones,
  saveVaultAndEntries,
  saveVaultConfig,
  StaleVaultError,
  takeSnapshot,
  watchExternalChanges,
  wipeAll,
  type AuthSettings,
  type SnapshotReason,
  type SnapshotSummary,
  type StoredEntry,
  type StoredSettings,
  type TombstoneSet,
  type VaultConfig,
  type VaultState,
} from "../../core/authenticator/db";
import {
  decryptString,
  deriveWrappingKey,
  importVaultKey,
  isUnbound,
  openField,
  randomBytes,
  sealField,
  unwrapKeyBytes,
  VERIFIER_PLAINTEXT,
  wrapKeyBytes,
  type EncryptedBlob,
  type FieldBinding,
} from "../../core/authenticator/vault-crypto";
import { deriveKeyBytes, LEGACY_PBKDF2_ITERATIONS, parseKdf } from "../../core/authenticator/kdf";
import { unwrapDataKey, wrapDataKey, WrongPasswordError } from "../../core/authenticator/vault-keys";
import { assessPassword } from "../../core/authenticator/password-strength";
import {
  mergeTombstones,
  openTombstones,
  sealTombstones,
  tombstoneKey,
  withoutKeys,
  type Tombstone,
} from "../../core/authenticator/tombstones";
import {
  newEntry,
  nextIndex,
  requireSecret,
  sealEntry,
  sealEntrySecret,
  sealVault,
} from "../../core/authenticator/entries";
import { planEntryRestore } from "../../core/authenticator/restore-plan";
import {
  MAX_AUTO_LOCK_MINUTES,
  openSecuritySettings,
  sealSecuritySettings,
  securityOf,
  stricterOf,
  type SecuritySettings,
} from "../../core/authenticator/security-settings";
import { inBatches } from "../../core/batches";

export { weakensSecurity } from "../../core/authenticator/security-settings";
import { base64ToBytes, bytesToBase64 } from "../../core/authenticator/legacy-crypto";
import { normalizeBase32 } from "../../core/authenticator/base32";
import { moveInDisplayOrder } from "../../core/authenticator/order";
import { accountKey, type ExportableEntry } from "../../core/authenticator/backup";
import {
  backupKeyHeader,
  openCloudBackup,
  sealCloudBackup,
  parseCloudBackup,
  type CloudBackupDevice,
  type CloudBackupFile,
  type CloudBackupPayload,
  type RestoreParts,
} from "../../core/authenticator/cloud-backup";
import type { BackupKind } from "../../core/authenticator/cloud-sync";
import { getPlatform } from "../../platform";
import { noteFailure } from "../../diagnostics";
import {
  cryptoFor,
  type AuthEvent,
  type CredentialSnapshot,
  type CredentialVaultHooks,
  type PasswordPrompt,
  type RestoreResult,
  type VaultCrypto,
} from "./vault-contract";

export type {
  AuthEvent,
  CredentialSnapshot,
  CredentialVaultHooks,
  PasswordPrompt,
  RestoreResult,
  VaultCrypto,
} from "./vault-contract";

/** Windows Hello unlock needs the master password typed at least this often (F-20). */
export const HELLO_PASSWORD_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

/** How long a successful "confirm it's you" check is trusted, where reuse is allowed. */
const CONFIRM_GRACE_MS = 60_000;

const EMPTY_TOMBSTONES: TombstoneSet = { entries: [], credentials: [] };

const SECURITY_KEYS = ["autoLockMinutes", "clipboardClear", "credentialsRevealAuth"] as const;

/** `key` opens `vault`: its verifier decrypts. */
async function opens(key: CryptoKey, vault: VaultConfig | null | undefined): Promise<boolean> {
  if (!vault?.encrypted || !vault.verifier) return false;
  try {
    return (await decryptString(key, vault.verifier)) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

/** The user dismissed the Windows Hello prompt (as opposed to Hello failing). */
function isCanceled(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return message === "hello_canceled" || message === "canceled";
}

/** What decrypting the vault under a key produced, before it becomes the state. */
interface Opened {
  readable: StoredEntry[];
  /** Records that wouldn't decrypt, as stored (D-2). */
  damaged: StoredEntry[];
  secrets: Map<string, string>;
  tombstones: TombstoneSet;
  security: SecuritySettings;
  /** A valid sealed copy of the security settings exists. */
  sealedSettings: boolean;
  /** Some records are still in an older form and should be sealed again. */
  reseal: boolean;
}


/** An account deleted moments ago, kept in memory so Undo can put it back. */
export interface RemovedEntry {
  readonly stored: StoredEntry;
  readonly secret: string;
  readonly tombstoneKey: string;
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
  /** The master password last typed is below the current policy (F-06). */
  weakPassword = $state(false);
  /** Why the local data couldn't be opened (e.g. made by a newer version, F-12). */
  loadError = $state<string | null>(null);
  /** Shown on the lock screen: why the vault locked by itself (another window, D-1). */
  notice = $state<string | null>(null);
  /** 2FA accounts that couldn't be decrypted and are set aside (D-2). */
  unreadableEntries = $state(0);
  /** The browser promised to keep this data (web build, D-4); null = unknown / desktop. */
  storagePersisted = $state<boolean | null>(null);

  #key: CryptoKey | null = null;
  #secrets = new Map<string, string>();
  #tombstones: TombstoneSet = { ...EMPTY_TOMBSTONES };
  /** Records that failed to decrypt: kept as stored, out of `entries` (D-2). */
  #damaged: StoredEntry[] = [];
  #lastActivity = Date.now();
  #ticker: ReturnType<typeof setInterval> | null = null;
  #initPromise: Promise<void> | null = null;
  #credentials: CredentialVaultHooks | null = null;
  #trustedUntil = 0;
  #reloading: Promise<void> | null = null;
  /** Another change arrived while a reload was running: read once more. */
  #reloadAgain = false;
  /**
   * Which version of the in-memory vault an operation started from. Bumped
   * whenever that is replaced — a reload, a snapshot restore, a wipe. An
   * operation checks it right before each write and stops (StaleVaultError)
   * if it changed: it was prepared from state that no longer applies (D-1).
   */
  #epoch = 0;
  /** Settings changes run one at a time, each from the result of the last. */
  #settingsQueue: Promise<void> = Promise.resolve();

  /** Called once, at bootstrap, by src/lib/vault-bootstrap.ts. */
  registerCredentials(hooks: CredentialVaultHooks): void {
    this.#credentials = hooks;
  }

  /** Seal a Credential Manager record field. Requires unlocked + encrypted. */
  async sealSecret(plaintext: string, binding: FieldBinding): Promise<EncryptedBlob> {
    if (this.locked || !this.#key) throw new Error("Unlock first");
    return sealField(this.#key, plaintext, binding);
  }

  /** Open a Credential Manager record field. Requires unlocked. */
  async openSecret(blob: EncryptedBlob, binding: FieldBinding): Promise<string> {
    if (this.locked || !this.#key) throw new Error("Unlock first");
    return openField(this.#key, blob, binding);
  }

  /** The current key's crypto (audit chain, sealed lists). Requires unlocked + encrypted. */
  vaultCrypto(): VaultCrypto {
    if (this.locked || !this.#key) throw new Error("Unlock first");
    return cryptoFor(this.#key);
  }

  /** See #epoch. */
  get epoch(): number {
    return this.#epoch;
  }

  /**
   * Start an operation that will write: waits out a reload in progress and
   * returns the epoch to check (assertCurrent) right before each write.
   * Never called from inside a reload (it would wait for itself).
   */
  async beginWrite(): Promise<number> {
    while (this.#reloading) await this.#reloading;
    return this.#epoch;
  }

  /** Throws StaleVaultError when the in-memory vault was replaced since `epoch`. */
  assertCurrent(epoch: number): void {
    if (epoch !== this.#epoch) throw new StaleVaultError();
  }

  /** When the password was changed, until older copies were dealt with (S-13). */
  get passwordChangedAt(): number | null {
    return this.vault?.passwordChangedAt ?? null;
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
      } catch (e) {
        // An observer's failure must never break a vault operation.
        noteFailure("vault", `listener failed on ${event}`, e);
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

  /** Try opening the local data again after it failed (`loadError`). */
  retryInit(): Promise<void> {
    if (!this.ready && this.loadError) {
      this.loadError = null;
      this.#initPromise = null;
    }
    return this.init();
  }

  async #init(): Promise<void> {
    try {
      await this.#load("initial");
    } catch (e) {
      // Leave `ready` false so nothing can write into a database we couldn't
      // open; the UI shows `loadError` instead, with a way to try again.
      this.loadError =
        e instanceof NewerDataError
          ? e.message
          : e instanceof Error && e.message.startsWith("An older version of CoreTools")
            ? e.message
            : "CoreTools couldn't open its local database. Try again, or restart the app; if it keeps happening, your data is still on disk — contact support before reinstalling.";
      noteFailure("vault", "database open failed", e);
      return;
    }
    watchExternalChanges(() => void this.#reloadAfterExternalChange());
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
      .catch((e) => noteFailure("vault", "hello probe failed", e));

    if (getPlatform().kind === "browser") {
      navigator.storage
        ?.persisted?.()
        .then((granted) => (this.storagePersisted = granted))
        .catch(() => (this.storagePersisted = null));
    }
  }

  /** Read the vault from disk into memory; locked when a password is set. */
  async #load(reason: "initial" | "auto" | "manual"): Promise<void> {
    this.#apply(await loadVaultState(), reason);
    if (!this.encrypted) this.#tombstones = await this.#loadTombstones(null);
  }

  /** Make `state` the in-memory vault, locked when a password is set. */
  #apply({ vault, settings, entries }: VaultState, reason: "initial" | "auto" | "manual"): void {
    this.vault = vault ?? null;
    const { sealed: _sealed, ...plainSettings } = settings;
    this.settings = plainSettings;
    this.#key = null;
    this.#secrets = new Map();
    this.#tombstones = { ...EMPTY_TOMBSTONES };
    this.#damaged = [];
    this.locked = this.encrypted; // locked on load when a password is set
    this.lockReason = this.locked ? (this.lockReason ?? reason) : null;
    if (this.encrypted) {
      this.entries = entries;
    } else {
      // Without a password every record holds its secret in the clear; one
      // that doesn't (still sealed under an earlier key) is set aside (D-2).
      const readable: StoredEntry[] = [];
      for (const entry of entries) {
        if (entry.secret.plain) {
          this.#secrets.set(entry.id, entry.secret.plain);
          readable.push(entry);
        } else {
          this.#damaged.push(entry);
        }
      }
      this.entries = readable;
    }
    this.unreadableEntries = this.#damaged.length;
  }

  /**
   * Another window wrote to the vault (or a write here was refused as
   * stale): read it again (D-1). An unlocked window stays unlocked while the
   * vault key is unchanged — the new state is decrypted with it before it
   * replaces what is shown (NEW-4) — and locks after a password change or a
   * rollback elsewhere. A change arriving during a reload triggers one more
   * pass (NEW-8).
   */
  #reloadAfterExternalChange(): Promise<void> {
    if (this.#reloading) {
      this.#reloadAgain = true;
      return this.#reloading;
    }
    this.#reloading = (async () => {
      try {
        do {
          this.#reloadAgain = false;
          await this.#reload();
        } while (this.#reloadAgain);
      } catch (e) {
        noteFailure("vault", "reload after external change failed", e);
      } finally {
        this.#reloading = null;
      }
    })();
    return this.#reloading;
  }

  async #reload(): Promise<void> {
    this.#epoch++;
    try {
      const key = this.locked ? null : this.#key;
      const state = await loadVaultState();
      if (key && (await opens(key, state.vault))) {
        try {
          await this.#reopen(key, state);
          return;
        } catch (e) {
          noteFailure("vault", "reopen after external change failed", e);
        }
      }
      const wasUnlocked = this.encrypted && !this.locked;
      if (wasUnlocked) this.lock("auto");
      this.#apply(state, "auto");
      if (!this.encrypted) this.#tombstones = await this.#loadTombstones(null);
      await this.#credentials?.reload(null);
      if (wasUnlocked) {
        this.notice =
          "The vault was changed in another window — a new password, or it was rolled back — so it was locked here. Unlock to continue.";
      }
    } finally {
      this.#epoch++;
      this.#emit("reload");
    }
  }

  /** The vault changed on disk but its key didn't: show the new state, still unlocked. */
  async #reopen(key: CryptoKey, state: VaultState): Promise<void> {
    const opened = await this.#decrypt(key, state.entries, state.settings);
    await this.#credentials?.reload(cryptoFor(key));
    this.vault = state.vault ?? null;
    const { sealed: _sealed, ...plainSettings } = state.settings;
    this.settings = plainSettings;
    this.#enter(key, opened);
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
    this.#trustedUntil = 0;
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
   * WrongPasswordError for a wrong password; anything else (the KDF running
   * out of memory, say) propagates as itself, so the user isn't told a
   * correct password is wrong. `raw` must be zeroed by the caller. `vault`
   * defaults to the current one (a snapshot's, when restoring one).
   */
  async #dataKeyFromPassword(
    password: string,
    vault: VaultConfig | null | undefined = this.vault,
  ): Promise<{ raw: Uint8Array; key: CryptoKey; legacy: boolean }> {
    if (!vault?.encrypted || !vault.salt || !vault.verifier) {
      throw new Error("No encryption password is set");
    }
    // The key-stretching settings come from disk: bounded, so a planted
    // value can't make unlock run out of memory or take forever.
    const kdf = parseKdf(
      vault.wrappedKey && vault.kdf
        ? vault.kdf
        : { name: "PBKDF2-SHA256", iterations: vault.iterations ?? LEGACY_PBKDF2_ITERATIONS },
    );
    if (!kdf) throw new Error("The vault's key settings are damaged, so it can't be opened.");
    let raw: Uint8Array;
    let legacy = false;
    if (vault.wrappedKey && vault.kdf) {
      raw = await unwrapDataKey(password, { kdf, salt: vault.salt, wrappedKey: vault.wrappedKey });
    } else {
      raw = await deriveKeyBytes(password, vault.salt, kdf);
      legacy = true;
    }
    const key = await importVaultKey(raw);
    let ok = false;
    try {
      ok = (await decryptString(key, vault.verifier)) === VERIFIER_PLAINTEXT;
    } catch {
      ok = false; // the verifier fails authentication under any other key
    }
    if (!ok) {
      raw.fill(0);
      throw new WrongPasswordError();
    }
    return { raw, key, legacy };
  }

  /**
   * Record a successful password entry, upgrading a pre-1.2 vault to the
   * Argon2id key hierarchy on the way (same data key, so nothing is
   * re-encrypted and Windows Hello keeps working). Returns whether it upgraded.
   */
  async #passwordConfirmed(
    password: string,
    raw: Uint8Array,
    legacy: boolean,
    epoch: number,
  ): Promise<boolean> {
    const vault = this.vault;
    if (!vault) return false;
    let next: VaultConfig = { ...($state.snapshot(vault) as VaultConfig), passwordCheckedAt: Date.now() };
    if (legacy) {
      const wrapped = await wrapDataKey(password, raw);
      const { iterations: _legacyIterations, ...rest } = next;
      next = { ...rest, kdf: wrapped.kdf, salt: wrapped.salt, wrappedKey: wrapped.wrappedKey };
    }
    this.assertCurrent(epoch);
    await saveVaultConfig(next);
    this.vault = next;
    return legacy;
  }

  /**
   * Decrypt `entries` (and the deletion records and settings that go with
   * them) under `key`, changing no state. A record that won't decrypt is set
   * aside, not fatal (D-2). The security settings are the sealed copy, or —
   * when that is missing, damaged or not settings at all — the stricter of
   * the plaintext ones and the defaults (N3).
   */
  async #decrypt(
    key: CryptoKey,
    entries: readonly StoredEntry[],
    settings: StoredSettings,
  ): Promise<Opened> {
    const opened = await inBatches(entries, async (stored) => {
      const entry = $state.snapshot(stored) as StoredEntry;
      try {
        let secret: string | undefined;
        if (entry.secret.enc) {
          secret = await openField(key, entry.secret.enc, { kind: "entry", id: entry.id, field: "secret" });
        } else if (entry.secret.plain) {
          secret = entry.secret.plain;
        }
        let names: { issuer: string; account: string } | null = null;
        if (entry.meta) {
          names = JSON.parse(
            await openField(key, entry.meta, { kind: "entry", id: entry.id, field: "meta" }),
          ) as { issuer: string; account: string };
        }
        return { entry, secret, names, ok: true as const };
      } catch (e) {
        noteFailure("vault", "entry unreadable", e);
        return { entry, ok: false as const };
      }
    });

    const readable: StoredEntry[] = [];
    const damaged: StoredEntry[] = [];
    const secrets = new Map<string, string>();
    let reseal = false;
    for (const result of opened) {
      if (!result.ok) {
        damaged.push(result.entry);
        continue;
      }
      const { entry, secret, names } = result;
      if (names) {
        entry.issuer = names.issuer;
        entry.account = names.account;
      }
      if (secret !== undefined) secrets.set(entry.id, secret);
      // F-14 / L2: records still in an older form are sealed again after unlock.
      if (!entry.meta || isUnbound(entry.meta) || isUnbound(entry.secret.enc) || entry.hash) {
        reseal = true;
      }
      readable.push(entry);
    }
    const sealed = settings.sealed ? await openSecuritySettings(key, settings.sealed) : null;
    if (settings.sealed && !sealed) {
      noteFailure("vault", "sealed settings unreadable", new Error("not valid settings"));
    }
    return {
      readable,
      damaged,
      secrets,
      tombstones: await this.#loadTombstones(key),
      security: sealed ?? stricterOf(securityOf(settings), securityOf(DEFAULT_SETTINGS)),
      sealedSettings: sealed !== null,
      reseal,
    };
  }

  /** Make decrypted state the in-memory vault (no writes). */
  #enter(key: CryptoKey, opened: Opened): void {
    this.#key = key;
    this.#secrets = opened.secrets;
    this.#tombstones = opened.tombstones;
    this.entries = opened.readable;
    this.#damaged = opened.damaged;
    this.unreadableEntries = opened.damaged.length;
    this.settings = { ...this.settings, ...opened.security };
  }

  /**
   * Decrypt everything needed in memory with `key` and enter the unlocked
   * state. Nothing changes unless all of it succeeds (NEW-9); a reload that
   * runs meanwhile is waited out and the state it read is decrypted instead.
   * Then, best effort, records still in an older form are sealed again.
   */
  async #finishUnlock(key: CryptoKey): Promise<void> {
    let opened: Opened;
    let epoch: number;
    for (let attempt = 0; ; attempt++) {
      epoch = await this.beginWrite();
      if (!(await opens(key, this.vault))) {
        throw new Error("The password was changed in another window. Unlock with the new one.");
      }
      opened = await this.#decrypt(key, [...this.entries, ...this.#damaged], await loadSettings());
      try {
        await this.#credentials?.open(cryptoFor(key));
      } catch (e) {
        this.#credentials?.close();
        throw e;
      }
      if (epoch === this.#epoch) break;
      this.#credentials?.close();
      if (attempt >= 2) throw new StaleVaultError();
    }
    this.#enter(key, opened);
    this.touch();
    this.locked = false;
    this.lockReason = null;
    this.notice = null;
    this.#emit("unlock");
    try {
      await this.#maintain(key, opened, epoch);
    } catch (e) {
      // Retried on the next unlock; the vault is fully usable as it is.
      noteFailure("vault", "unlock maintenance failed", e);
    }
  }

  /** After unlock: seal what is still in an older form (L2, N3). */
  async #maintain(key: CryptoKey, opened: Opened, epoch: number): Promise<void> {
    if (!opened.sealedSettings) {
      const stored = await this.#storedSettings(this.settings, key);
      this.assertCurrent(epoch);
      await saveSettings(stored);
    }
    if (opened.reseal) {
      const readable = this.entries;
      for (const entry of readable) {
        const secret = this.#secrets.get(entry.id);
        if (secret !== undefined) entry.secret = { enc: await sealEntrySecret(key, entry.id, secret) };
      }
      await this.#saveEntries(readable, epoch);
    }
  }

  async unlock(password: string): Promise<void> {
    // Never unlock a copy that is still being re-read (D-1).
    const epoch = await this.beginWrite();
    const { raw, key, legacy } = await this.#dataKeyFromPassword(password);
    let upgraded = false;
    try {
      upgraded = await this.#passwordConfirmed(password, raw, legacy, epoch);
    } catch (e) {
      // Only bookkeeping (and the KDF upgrade, retried next time): the
      // password was right, so the unlock goes ahead.
      noteFailure("vault", "password check not recorded", e);
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
    await this.beginWrite();
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
    let raw: Uint8Array | null = null;
    try {
      raw = await unwrapKeyBytes(wrappingKey, vault.hello.wrapped);
      key = await importVaultKey(raw);
      if ((await decryptString(key, vault.verifier)) !== VERIFIER_PLAINTEXT) {
        throw new Error("verifier mismatch");
      }
    } catch (e) {
      noteFailure("vault", "hello unwrap failed", e);
      throw new Error(
        "Windows Hello could not unlock the vault. Unlock with your password and re-enable Hello in Settings.",
      );
    } finally {
      raw?.fill(0);
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
    const epoch = await this.beginWrite();
    const { raw, legacy } = await this.#dataKeyFromPassword(password); // throws on wrong password
    try {
      if (await this.#passwordConfirmed(password, raw, legacy, epoch)) this.#emit("password");
      const challenge = randomBytes(32);
      const signature = await hello.createKey(challenge);
      const wrappingKey = await deriveWrappingKey(signature);
      const wrapped = await wrapKeyBytes(wrappingKey, raw);
      const next: VaultConfig = {
        ...($state.snapshot(this.vault ?? vault) as VaultConfig),
        hello: { challenge: bytesToBase64(challenge), wrapped },
      };
      this.assertCurrent(epoch);
      await saveVaultConfig(next); // disk first, then memory (L3)
      this.vault = next;
    } finally {
      raw.fill(0);
    }
    this.touch();
  }

  /** Disable Hello unlock and delete the native Hello key (best effort). */
  async disableHello(): Promise<void> {
    await this.beginWrite();
    if (this.vault?.hello) {
      const { hello: _hello, ...rest } = $state.snapshot(this.vault) as VaultConfig;
      await saveVaultConfig(rest);
      this.vault = rest;
    }
    await this.#deleteHelloKey();
  }

  /**
   * Delete the native Hello key. Best effort: a key left behind can't unlock
   * anything once the vault no longer holds a copy of the data key for it.
   */
  async #deleteHelloKey(): Promise<void> {
    await getPlatform()
      .hello?.deleteKey()
      .catch((e) => noteFailure("vault", "hello key delete failed", e));
  }

  /**
   * Drop a Hello configuration that no longer works (e.g. Windows recreated
   * the key after biometric re-enrollment). Safe to call while locked.
   */
  async clearStaleHello(): Promise<void> {
    await this.disableHello();
  }

  /**
   * Make sure it's really the user before something sensitive: Windows Hello
   * when the user turned it on for this vault, otherwise — or when Hello
   * fails rather than being canceled — the master password (via `prompt`).
   * Rejects with "canceled" or "Wrong password". Without a password set
   * there is nothing to check.
   *
   * `reuse`: a success is trusted for a minute, for other checks that also
   * pass `reuse` (revealing several logins in a row). Without it — rolling
   * back, wiping, lowering a protection — the check always runs, and earns
   * no trust for others (N7). Locking ends the trust.
   */
  async confirmUser(prompt: PasswordPrompt, options: { reuse?: boolean } = {}): Promise<void> {
    if (!this.encrypted) return;
    if (this.locked) throw new Error("Unlock first");
    const reuse = options.reuse === true;
    if (reuse && Date.now() < this.#trustedUntil) return;
    const trust = () => {
      if (reuse) this.#trustedUntil = Date.now() + CONFIRM_GRACE_MS;
    };
    try {
      if (await this.verifyUserPresence()) {
        trust();
        return;
      }
    } catch (e) {
      if (isCanceled(e)) throw new Error("canceled");
      noteFailure("vault", "hello verification failed; asking for the password", e);
    }
    const password = await prompt();
    if (password === null) throw new Error("canceled");
    if (!(await this.verifyPassword(password))) throw new Error("Wrong password");
    trust();
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

  /** Ask the browser to keep this data (web build only, D-4). */
  #requestPersistence(): void {
    if (getPlatform().kind !== "browser" || this.storagePersisted) return;
    navigator.storage
      ?.persist?.()
      .then((granted) => (this.storagePersisted = granted))
      .catch((e) => noteFailure("vault", "persistent storage request failed", e));
  }

  // ---- entries --------------------------------------------------------------------

  /** Plaintext secret for an entry — null while locked. */
  secretOf(id: string): string | null {
    return this.#secrets.get(id) ?? null;
  }

  async #storedSecret(id: string, plaintext: string): Promise<StoredEntry["secret"]> {
    if (this.#key) return { enc: await sealEntrySecret(this.#key, id, plaintext) };
    return { plain: plaintext };
  }

  /**
   * Persist entries, keeping each in-memory record's `meta` in step with
   * disk. Refused when the vault was replaced since `epoch`.
   */
  async #saveEntries(entries: StoredEntry[], epoch: number): Promise<void> {
    if (this.encrypted && !this.#key) throw new Error("Unlock first");
    const stored = await Promise.all(entries.map((e) => sealEntry(e, this.#key)));
    this.assertCurrent(epoch);
    await saveEntries(stored);
    entries.forEach((entry, i) => {
      if (stored[i].meta) entry.meta = stored[i].meta;
      else delete entry.meta;
      delete entry.hash;
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
    if (accounts.length === 0) return;
    const epoch = await this.beginWrite();
    let index = nextIndex(this.entries);
    const created: StoredEntry[] = [];
    const secrets = new Map<string, string>();
    const now = Date.now();

    for (const account of accounts) {
      const secret = normalizeBase32(account.secret);
      const entry = await newEntry(account, secret, index++, now); // validates (S-10)
      entry.secret = await this.#storedSecret(entry.id, secret);
      secrets.set(entry.id, secret);
      created.push(entry);
    }

    // Disk first; memory only once the write succeeded (L3).
    const previous = this.#secrets;
    this.#secrets = new Map([...previous, ...secrets]);
    try {
      await this.#saveEntries(created, epoch);
    } catch (e) {
      this.#secrets = previous;
      throw e;
    }
    this.entries.push(...created);
    // Re-adding something deleted earlier: it's no longer deleted.
    const revived = new Set(await Promise.all(created.map((e) => this.#entryTombstoneKey(e))));
    if (this.#tombstones.entries.some((t) => revived.has(t.k))) {
      this.#tombstones = {
        ...this.#tombstones,
        entries: withoutKeys(this.#tombstones.entries, revived),
      };
      await this.#saveTombstones(epoch);
    }
    if (!this.vault) {
      // Record the (implicit) "no password" choice; the warning banner stays.
      this.assertCurrent(epoch);
      await saveVaultConfig({ encrypted: false });
      this.vault = { encrypted: false };
    }
    this.#requestPersistence();
    this.#emit("change");
  }

  async rename(id: string, issuer: string, account: string): Promise<void> {
    const epoch = await this.beginWrite();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    const next = { ...($state.snapshot(entry) as StoredEntry), issuer: issuer.trim(), account: account.trim() };
    await this.#saveEntries([next], epoch); // disk first (L3)
    entry.issuer = next.issuer;
    entry.account = next.account;
    entry.meta = next.meta;
    this.#emit("change");
  }

  /**
   * Delete an account. The deletion and its tombstone are written together
   * (D-6); the returned value lets the UI offer Undo.
   */
  async remove(id: string): Promise<RemovedEntry | null> {
    if (this.locked) throw new Error("Unlock first");
    const epoch = await this.beginWrite();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    const secret = requireSecret(this.#secrets, entry);
    const k = await this.#entryTombstoneKey(entry);
    const stored = await sealEntry(entry, this.#key);
    const tombstones: TombstoneSet = {
      ...this.#tombstones,
      entries: mergeTombstones([this.#tombstones.entries, [{ k, at: Date.now() }]]),
    };
    const sealed = await sealTombstones(tombstones, this.#key);
    this.assertCurrent(epoch);
    await deleteWithTombstones({ entries: [id] }, sealed);
    this.entries = this.entries.filter((e) => e.id !== id);
    this.#secrets.delete(id);
    this.#tombstones = tombstones;
    this.#emit("change");
    return { stored, secret, tombstoneKey: k };
  }

  /**
   * Undo a `remove`: the same record, in its old place, no longer deleted.
   * It counts as added now, so a copy of the deletion that already reached a
   * backup doesn't delete it again on the next merge (N10).
   */
  async restoreRemoved(removed: RemovedEntry): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    const epoch = await this.beginWrite();
    if (this.entries.some((e) => e.id === removed.stored.id)) return;
    const stored: StoredEntry = { ...removed.stored, addedAt: Date.now() };
    const tombstones: TombstoneSet = {
      ...this.#tombstones,
      entries: withoutKeys(this.#tombstones.entries, new Set([removed.tombstoneKey])),
    };
    const sealed = await sealTombstones(tombstones, this.#key);
    this.assertCurrent(epoch);
    await restoreEntryWithTombstones(stored, sealed);
    this.#tombstones = tombstones;
    this.#secrets.set(stored.id, removed.secret);
    let view: StoredEntry = stored;
    if (stored.meta && this.#key) {
      const names = JSON.parse(
        await openField(this.#key, stored.meta, { kind: "entry", id: view.id, field: "meta" }),
      ) as { issuer: string; account: string };
      view = { ...stored, ...names };
    }
    this.entries = [...this.entries, view].sort((a, b) => a.index - b.index);
    this.#emit("change");
  }

  async togglePin(id: string): Promise<void> {
    const epoch = await this.beginWrite();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    const next = { ...($state.snapshot(entry) as StoredEntry), pinned: !entry.pinned };
    await this.#saveEntries([next], epoch);
    entry.pinned = next.pinned;
    entry.meta = next.meta;
    this.#emit("change");
  }

  async incrementCounter(id: string): Promise<void> {
    const epoch = await this.beginWrite();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.type !== "hotp") return;
    const next = { ...($state.snapshot(entry) as StoredEntry), counter: entry.counter + 1 };
    await this.#saveEntries([next], epoch);
    entry.counter = next.counter;
    entry.meta = next.meta;
    this.#emit("change");
  }

  /**
   * Move `fromId` to where `toId` is in the DISPLAYED order (pinned first),
   * persisting the new order. Positions in `this.entries` are irrelevant.
   */
  async reorder(fromId: string, toId: string): Promise<void> {
    const epoch = await this.beginWrite();
    const next = moveInDisplayOrder(this.entries, fromId, toId);
    if (!next) return;
    const reordered = this.entries.map((entry) => ({
      ...($state.snapshot(entry) as StoredEntry),
      index: next.get(entry.id) ?? entry.index,
    }));
    await this.#saveEntries(reordered, epoch);
    this.entries = reordered.sort((a, b) => a.index - b.index);
    this.#emit("change");
  }

  /** Entries + plaintext secrets for export/backup. Requires unlocked. */
  exportables(): ExportableEntry[] {
    if (this.locked) throw new Error("Unlock first");
    return this.entries.map((entry) => ({
      type: entry.type,
      issuer: entry.issuer,
      account: entry.account,
      secret: requireSecret(this.#secrets, entry),
      algorithm: entry.algorithm,
      digits: entry.digits,
      period: entry.period,
      counter: entry.counter,
      index: entry.index,
      pinned: entry.pinned,
    }));
  }

  // ---- tombstones (F-09) ----------------------------------------------------------

  async #loadTombstones(key: CryptoKey | null): Promise<TombstoneSet> {
    const stored = await loadTombstones();
    try {
      return await openTombstones(stored, key);
    } catch (e) {
      // Unreadable deletion records only weaken merges; never block unlock.
      noteFailure("vault", "tombstones unreadable", e);
      return { ...EMPTY_TOMBSTONES };
    }
  }

  async #saveTombstones(epoch: number): Promise<void> {
    if (this.encrypted && !this.#key) throw new Error("Unlock first");
    const sealed = await sealTombstones(this.#tombstones, this.#key);
    this.assertCurrent(epoch);
    await saveTombstones(sealed);
  }

  /**
   * Permanently delete credentials and record the deletions (their identity
   * keys) in one transaction (D-6). Called by the Credential Manager, with
   * the epoch its operation started from.
   */
  async deleteCredentials(ids: string[], identities: string[], epoch = this.#epoch): Promise<void> {
    if (this.locked || !this.#key) throw new Error("Unlock first");
    if (ids.length === 0) return;
    const now = Date.now();
    const added = await Promise.all(identities.map(async (id) => ({ k: await tombstoneKey(id), at: now })));
    const tombstones: TombstoneSet = {
      ...this.#tombstones,
      credentials: mergeTombstones([this.#tombstones.credentials, added]),
    };
    const sealed = await sealTombstones(tombstones, this.#key);
    this.assertCurrent(epoch);
    await deleteWithTombstones({ credentials: ids }, sealed);
    this.#tombstones = tombstones;
  }

  /** Credentials saved again under an identity deleted earlier are no longer deleted. */
  async forgetCredentialDeletions(identities: string[], epoch = this.#epoch): Promise<void> {
    const keys = new Set(await Promise.all(identities.map(tombstoneKey)));
    if (!this.#tombstones.credentials.some((t) => keys.has(t.k))) return;
    this.#tombstones = {
      ...this.#tombstones,
      credentials: withoutKeys(this.#tombstones.credentials, keys),
    };
    await this.#saveTombstones(epoch);
  }

  // ---- settings -----------------------------------------------------------------------

  /** The settings as stored: with a key, the security ones sealed under it too. */
  async #storedSettings(settings: AuthSettings, key: CryptoKey | null): Promise<StoredSettings> {
    const stored: StoredSettings = { ...($state.snapshot(settings) as AuthSettings) };
    if (key) stored.sealed = await sealSecuritySettings(key, settings);
    return stored;
  }

  /**
   * Change settings, disk first (L3). Changes run one at a time. While an
   * encrypted vault is locked only the others can change: the security
   * settings couldn't be sealed, and their sealed copy is kept as it is.
   */
  updateSettings(patch: Partial<AuthSettings>): Promise<void> {
    const run = this.#settingsQueue.then(() => this.#updateSettings(patch));
    this.#settingsQueue = run.catch(() => undefined);
    return run;
  }

  async #updateSettings(patch: Partial<AuthSettings>): Promise<void> {
    const epoch = await this.beginWrite();
    const clean = { ...patch };
    if (clean.autoLockMinutes !== undefined) {
      const minutes = Math.round(Number(clean.autoLockMinutes) || 0);
      clean.autoLockMinutes = Math.min(MAX_AUTO_LOCK_MINUTES, Math.max(0, minutes));
    }
    const next = { ...this.settings, ...clean };
    if (this.encrypted && !this.#key) {
      if (SECURITY_KEYS.some((k) => next[k] !== this.settings[k])) throw new Error("Unlock first");
      this.assertCurrent(epoch);
      await saveSettings($state.snapshot(next) as AuthSettings, true);
    } else {
      const stored = await this.#storedSettings(next, this.encrypted ? this.#key : null);
      this.assertCurrent(epoch);
      await saveSettings(stored);
    }
    this.settings = next;
  }

  // ---- password -------------------------------------------------------------------

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
    const epoch = await this.beginWrite();
    await this.#requireCollections();
    await this.#credentials?.ready();
    if (this.encrypted) await this.#snapshot("password-change");

    const hadHello = this.helloEnabled;
    const sealed = await sealVault(password, this.entries, this.#secrets);
    const oldKey = this.#key;
    let credentials: CredentialSnapshot | undefined;
    if (this.#credentials && oldKey) {
      credentials = await this.#credentials.reseal(cryptoFor(oldKey), cryptoFor(sealed.key));
    }
    const vault: VaultConfig = oldKey ? { ...sealed.vault, passwordChangedAt: Date.now() } : sealed.vault;
    const meta = {
      ...credentials?.meta,
      tombstones: await sealTombstones(this.#tombstones, sealed.key),
      // The security settings, sealed under the new key in the same write (N3).
      settings: await this.#storedSettings(this.settings, sealed.key),
    };
    this.assertCurrent(epoch);
    // Records that couldn't be decrypted stay as they are (D-2, NEW-5).
    await saveVaultAndEntries(vault, [...sealed.stored, ...this.#damaged], {
      credentials: credentials?.stored,
      audit: credentials?.audit,
      meta,
    });

    this.#key = sealed.key;
    this.vault = vault;
    this.entries = sealed.view;
    if (credentials) this.#credentials?.adopt(credentials);
    this.weakPassword = false;
    // A new password means a new data key: any Hello-wrapped copy of the old
    // key is useless now, so Hello must be re-enabled. Only after the write
    // succeeded (L2 of the data audit).
    if (hadHello) await this.#deleteHelloKey();
    this.touch();
    this.#requestPersistence();
    this.#emit("password");
  }

  /** Verify the current password (used before change/remove and reveals). */
  async verifyPassword(password: string): Promise<boolean> {
    try {
      const { raw } = await this.#dataKeyFromPassword(password);
      raw.fill(0);
      return true;
    } catch (e) {
      if (e instanceof WrongPasswordError) return false;
      throw e;
    }
  }

  /** Remove the password and store secrets unencrypted (with a warning). */
  async removePassword(currentPassword: string): Promise<void> {
    if (this.locked) throw new Error("Unlock first");
    const epoch = await this.beginWrite();
    const { raw } = await this.#dataKeyFromPassword(currentPassword); // throws on wrong password
    raw.fill(0);
    // Credential Manager passwords have no unencrypted mode.
    await this.#credentials?.ready();
    if ((this.#credentials?.count() ?? 0) > 0 || (await countCredentials()) > 0) {
      throw new Error(
        "The Credential Manager has saved logins, which must stay encrypted. Delete them (and empty its Trash) before removing the password.",
      );
    }
    await this.#snapshot("password-removal");

    const hadHello = this.helloEnabled;
    const plain: StoredEntry[] = [];
    for (const entry of this.entries) {
      const record: StoredEntry = {
        ...($state.snapshot(entry) as StoredEntry),
        secret: { plain: requireSecret(this.#secrets, entry) },
      };
      delete record.meta;
      delete record.hash;
      plain.push(record);
    }
    const vault: VaultConfig = { encrypted: false };
    const settings = await this.#storedSettings(this.settings, null); // no sealed copy without a key
    this.assertCurrent(epoch);
    // The sealed audit log can't outlive the key that seals it. Records that
    // couldn't be decrypted stay as they are, set aside (D-2, NEW-5).
    await saveVaultAndEntries(vault, [...plain, ...this.#damaged], {
      audit: { records: [], head: null },
      meta: { tombstones: { plain: this.#tombstones }, settings },
    });

    this.#key = null;
    this.vault = vault;
    this.entries = plain;
    this.weakPassword = false;
    // No password → no data key → nothing for Hello to unwrap.
    if (hadHello) await this.#deleteHelloKey();
    this.#emit("password");
  }

  // ---- local snapshots (D-8) ------------------------------------------------------

  /**
   * Best effort: a failed snapshot is noted but never blocks the operation.
   * `keep`: a snapshot that must survive the pruning (the one being restored).
   */
  async #snapshot(reason: SnapshotReason, keep?: string): Promise<void> {
    try {
      await takeSnapshot(reason, keep);
    } catch (e) {
      noteFailure("vault", "snapshot failed", e);
    }
  }

  listSnapshots(): Promise<SnapshotSummary[]> {
    return dbListSnapshots();
  }

  /**
   * Put the vault back as it was in a snapshot (D-8); the current state is
   * snapshotted first, so this can be undone too. A snapshot from before a
   * password change opens with the password in use then: `snapshotPassword`
   * asks for it, and it is checked BEFORE anything changes — a forgotten
   * one can't lock the user out (NEW-6). The vault is unlocked with it
   * afterwards, and the current settings come along, sealed under its key.
   */
  async restoreSnapshot(
    id: string,
    prompt: PasswordPrompt,
    snapshotPassword: PasswordPrompt,
  ): Promise<void> {
    await this.confirmUser(prompt);
    const epoch = await this.beginWrite();
    const vault = await loadSnapshotVault(id);
    if (vault === null) throw new Error("That snapshot no longer exists.");
    const previousKey = this.#key;
    let key: CryptoKey | null = null;
    let password: string | null = null;
    if (vault?.encrypted) {
      if (previousKey && (await opens(previousKey, vault))) {
        key = previousKey;
      } else {
        password = await snapshotPassword();
        if (password === null) throw new Error("canceled");
        try {
          const opened = await this.#dataKeyFromPassword(password, vault);
          opened.raw.fill(0);
          key = opened.key;
        } catch (e) {
          if (e instanceof WrongPasswordError) {
            throw new Error("That isn't the password the vault had then. Nothing was changed.");
          }
          throw e;
        }
      }
    }
    const settings = await this.#storedSettings(this.settings, key);
    await this.#snapshot("before-snapshot-restore", id);
    this.assertCurrent(epoch);
    // A Windows Hello setup wrapping another key would only fail (NEW-7).
    await dbRestoreSnapshot(id, { settings, dropHello: key !== previousKey });

    // The vault on disk is the snapshot now: read it back and open it.
    this.#epoch++;
    try {
      if (this.encrypted && !this.locked) this.lock("manual");
      await this.#load("manual");
      await this.#credentials?.reload(null);
    } finally {
      this.#epoch++;
    }
    if (key) {
      if (password !== null) this.weakPassword = !assessPassword(password).ok;
      await this.#finishUnlock(key);
    }
    this.#emit("reload");
    // Every backup series changed; under another key, they need a fresh copy.
    this.#emit(key !== previousKey ? "password" : "change");
    this.#emit("credentials");
  }

  /** After a password change: delete snapshots that still open with the old password (S-13). */
  deleteSnapshotsBefore(time: number): Promise<number> {
    return deleteSnapshotsBefore(time);
  }

  /** The older copies after a password change were dealt with: stop offering it (S-13). */
  async forgetPasswordChange(): Promise<void> {
    await this.beginWrite();
    if (!this.vault?.passwordChangedAt) return;
    const { passwordChangedAt: _done, ...rest } = $state.snapshot(this.vault) as VaultConfig;
    await saveVaultConfig(rest);
    this.vault = rest;
  }

  // ---- cloud backup support ----------------------------------------------------
  // These need the in-memory key, so they live here; the transport and
  // scheduling live in cloud.svelte.ts.

  /**
   * Encrypt one backup series — the 2FA accounts ("authenticator") or the
   * Credential Manager ("credmanager") — into a cloud backup file. The result
   * is opened again with the same key and checked before it is returned, so
   * a file that couldn't be restored never leaves the device. `records` is
   * how many records it holds (shrink protection, D-5).
   */
  async sealCloudBackup(
    device: CloudBackupDevice,
    series: BackupKind,
  ): Promise<{ content: string; records: number }> {
    const vault = this.vault;
    const key = this.#key;
    if (this.locked || !key) throw new Error("Unlock first");
    if (!vault?.encrypted || !vault.salt || !vault.verifier) {
      throw new Error("Set an encryption password first");
    }
    const sealKey = {
      key,
      keyHeader: backupKeyHeader($state.snapshot(vault) as VaultConfig),
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
      const credentials = (await this.#credentials?.exportPlain(cryptoFor(key))) ?? [];
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
    return { content: text, records: expected.entries + expected.credentials };
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
      return null; // another key: the caller asks for the backup's password
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
    // Only where the user chose Hello for this vault: the OS PIN mustn't
    // stand in for a master password they never agreed to replace (N7).
    if (!hello || !this.helloSupported || !this.helloEnabled) return false;
    await hello.verifyUser();
    return true;
  }

  /**
   * Restore accounts and/or credentials from decrypted cloud backups (see
   * `restoreParts`). Each part that is present is restored with `mode`:
   *  - "merge":   records that aren't here yet are added after the existing
   *               ones; a record that is here takes the backup's copy when
   *               that is newer (D-3); deletions recorded on either side are
   *               honoured (F-09);
   *  - "replace": that part becomes exactly the backup (rollback).
   * A part that is null is left exactly as it is, in either mode.
   *
   * Pins and order come back as they were. When no encryption password is
   * set yet (fresh install), `password` — the one the backup was made with —
   * becomes the vault password, so the device ends up as the original was.
   *
   * Everything is built in memory first and persisted in ONE transaction:
   * an interrupted restore changes nothing. A local snapshot is taken first.
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
    const epoch = await this.beginWrite();
    await this.#requireCollections();
    await this.#credentials?.ready();
    if (this.encrypted) await this.#snapshot("restore");
    const now = Date.now();
    const touchEntries = parts.entries !== null;
    // Records that couldn't be decrypted stay, unless the accounts are
    // being replaced by the backup's exactly (D-2, NEW-5).
    const damaged = touchEntries && mode === "replace" ? [] : this.#damaged;

    const plan = await planEntryRestore({
      mode,
      entries: $state.snapshot(this.entries) as StoredEntry[],
      secrets: this.#secrets,
      incoming: parts.entries,
      tombstones: { local: this.#tombstones.entries, remote: parts.entryTombstones },
      now,
    });
    const { all, secrets } = plan;
    const created = all.filter((entry) => !entry.secret.enc && !entry.secret.plain);
    const entryTombstones = plan.tombstones;

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
    if (this.encrypted) {
      const key = this.#key;
      const vault = this.vault;
      if (!key || !vault) throw new Error("Unlock first");
      for (const entry of created) {
        entry.secret = { enc: await sealEntrySecret(key, entry.id, secrets.get(entry.id) ?? "") };
      }
      credentialResult = await restoreCredentials(cryptoFor(key));
      const tombstones: TombstoneSet = {
        entries: entryTombstones,
        credentials: credentialTombstonesAfter(credentialResult),
      };
      const stored = await Promise.all(all.map((e) => sealEntry(e, key)));
      const sealedTombstones = await sealTombstones(tombstones, key);
      this.assertCurrent(epoch);
      await saveVaultAndEntries($state.snapshot(vault) as VaultConfig, [...stored, ...damaged], {
        credentials: credentialResult?.stored,
        meta: { tombstones: sealedTombstones },
      });
      all.forEach((entry, i) => (entry.meta = stored[i].meta));
      this.entries = all;
      this.#secrets = secrets;
      this.#tombstones = tombstones;
    } else {
      const sealed = await sealVault(password ?? "", all, secrets);
      credentialResult = await restoreCredentials(cryptoFor(sealed.key));
      const tombstones: TombstoneSet = {
        entries: entryTombstones,
        credentials: credentialTombstonesAfter(credentialResult),
      };
      const meta = {
        tombstones: await sealTombstones(tombstones, sealed.key),
        settings: await this.#storedSettings(this.settings, sealed.key),
      };
      this.assertCurrent(epoch);
      await saveVaultAndEntries(sealed.vault, [...sealed.stored, ...damaged], {
        credentials: credentialResult?.stored,
        meta,
      });
      this.#key = sealed.key;
      this.vault = sealed.vault;
      this.entries = sealed.view;
      this.#secrets = secrets;
      this.#tombstones = tombstones;
      this.weakPassword = !assessPassword(password ?? "").ok;
      this.#emit("password");
    }
    this.#damaged = damaged;
    this.unreadableEntries = damaged.length;
    if (credentialResult) this.#credentials?.adopt(credentialResult);

    this.touch();
    this.#requestPersistence();
    if (touchEntries) this.#emit("change");
    if (credentialResult) this.#emit("credentials");
    return {
      restoredAccounts: touchEntries,
      added: plan.added,
      updated: plan.updated,
      skipped: plan.skipped,
      removed: plan.removed,
      restoredCredentials: parts.credentials !== null,
      credentialsAdded: credentialResult?.added ?? 0,
      credentialsUpdated: credentialResult?.updated ?? 0,
      credentialsSkipped: credentialResult?.skipped ?? 0,
      credentialsRemoved: credentialResult?.removed ?? 0,
    };
  }

  /** Danger zone: delete everything, including the vault config and snapshots. */
  async wipe(): Promise<void> {
    const hadHello = this.helloEnabled;
    await wipeAll();
    this.#epoch++; // whatever was in progress was prepared from the vault just deleted
    this.#credentials?.clear();
    this.entries = [];
    this.#damaged = [];
    this.unreadableEntries = 0;
    this.#secrets.clear();
    this.#tombstones = { ...EMPTY_TOMBSTONES };
    this.#key = null;
    this.#trustedUntil = 0;
    this.vault = null;
    this.locked = false;
    this.weakPassword = false;
    this.settings = { ...DEFAULT_SETTINGS };
    if (hadHello) await this.#deleteHelloKey();
    this.#emit("wipe");
  }
}

export const authStore = new AuthStore();
