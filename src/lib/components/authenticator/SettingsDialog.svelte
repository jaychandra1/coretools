<script lang="ts">
  import Modal from "./Modal.svelte";
  import PasswordPrompt from "../credentials/PasswordPrompt.svelte";
  import { authStore, weakensSecurity } from "./store.svelte";
  import { cloudBackup } from "./cloud.svelte";
  import CloudBackupPanel from "./CloudBackupPanel.svelte";
  import PasswordStrength from "./PasswordStrength.svelte";
  import { assessPassword, MIN_PASSWORD_LENGTH } from "../../core/authenticator/password-strength";
  import type { BackupKind } from "../../core/authenticator/cloud-sync";
  import type { AuthSettings, SnapshotSummary } from "../../core/authenticator/db";
  import { CloudBackupError, parseCloudBackup, type CloudBackupFile } from "../../core/authenticator/cloud-backup";
  import { getPlatform } from "../../platform";
  import { noteFailure } from "../../diagnostics";
  import { MAX_AUTO_LOCK_MINUTES } from "../../core/authenticator/security-settings";

  let {
    onclose,
    ontoast,
    onrestore,
    onimportfile,
    scope = "authenticator",
    title = "Authenticator settings",
  }: {
    onclose: () => void;
    ontoast: (message: string) => void;
    /** Open the restore dialog, optionally preselecting a version. */
    onrestore: (preselectId?: string) => void;
    /** Restore from an exported encrypted backup file (F-24). */
    onimportfile: (source: { file: CloudBackupFile; name: string }) => void;
    /**
     * The section that opened the dialog. The vault (password, Windows
     * Hello, auto-lock) is shared; everything else shows for its own section.
     */
    scope?: BackupKind;
    title?: string;
  } = $props();

  const authenticator = $derived(scope === "authenticator");

  let error = $state("");
  let busy = $state(false);

  // ---- "confirm it's you" (S-9) ----------------------------------------------
  // Lowering a protection, rolling back to a snapshot or wiping the vault asks
  // for Windows Hello or the master password first, so someone at an
  // unlocked machine can't switch the protections off.

  let prompt = $state<{ reason: string; resolve: (value: string | null) => void } | null>(null);

  function askPassword(reason: string): () => Promise<string | null> {
    return () =>
      new Promise((resolve) => {
        prompt = {
          reason,
          resolve: (value) => {
            prompt = null;
            resolve(value);
          },
        };
      });
  }

  /** The message for a failure; "" when the user just canceled. */
  function failure(e: unknown, fallback: string): string {
    const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    return message === "canceled" || message === "hello_canceled" ? "" : message || fallback;
  }

  /** Change settings; one that lowers a protection is confirmed first. */
  async function changeSetting(patch: Partial<AuthSettings>, control: HTMLInputElement) {
    error = "";
    try {
      if (weakensSecurity(authStore.settings, patch)) {
        await authStore.confirmUser(askPassword("Enter your master password to lower this protection."));
      }
      await authStore.updateSettings(patch);
    } catch (e) {
      error = failure(e, "Couldn't change the setting");
      // Put the control back to the setting that still applies.
      const key = Object.keys(patch)[0] as keyof AuthSettings;
      if (control.type === "checkbox") control.checked = Boolean(authStore.settings[key]);
      else control.value = String(authStore.settings[key]);
    }
  }

  // ---- encryption password -------------------------------------------------

  let currentPw = $state("");
  let newPw = $state("");
  let confirmPw = $state("");

  const settingNew = $derived(!authStore.encrypted);
  const pwFormOk = $derived(
    assessPassword(newPw).ok &&
      newPw === confirmPw &&
      (settingNew || currentPw.length > 0),
  );

  async function applyPassword(event: SubmitEvent) {
    event.preventDefault();
    if (!pwFormOk || busy) return;
    busy = true;
    error = "";
    try {
      if (!settingNew && !(await authStore.verifyPassword(currentPw))) {
        throw new Error("Current password is wrong");
      }
      const hadHello = authStore.helloEnabled;
      await authStore.setPassword(newPw);
      currentPw = newPw = confirmPw = "";
      snapshots = null;
      ontoast(
        settingNew
          ? "Encryption enabled"
          : hadHello
            ? "Password changed — re-enable Windows Hello below"
            : "Password changed",
      );
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to set password";
    } finally {
      busy = false;
    }
  }

  let removePw = $state("");
  async function removePassword(event: SubmitEvent) {
    event.preventDefault();
    if (!removePw || busy) return;
    if (
      !window.confirm(
        "Remove the encryption password? Secrets will be stored UNENCRYPTED on this device.",
      )
    ) {
      return;
    }
    busy = true;
    error = "";
    try {
      await authStore.removePassword(removePw);
      removePw = "";
      ontoast("Encryption removed — secrets are now stored unencrypted");
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to remove password";
    } finally {
      busy = false;
    }
  }

  // ---- after a password change: older copies still open with the old one (S-13) ----

  let clearingOld = $state(false);
  let clearedNote = $state("");

  async function clearOldCopies() {
    const since = authStore.passwordChangedAt;
    if (!since || clearingOld) return;
    clearingOld = true;
    clearedNote = "";
    try {
      let cloud = 0;
      if (cloudBackup.connected) {
        // A backup under the new password first, so no series is left without one.
        cloud = await cloudBackup.replaceVersionsBefore(since);
      }
      const local = await authStore.deleteSnapshotsBefore(since);
      snapshots = null;
      clearedNote = `Deleted ${cloud} older cloud ${cloud === 1 ? "version" : "versions"} and ${local} local ${local === 1 ? "snapshot" : "snapshots"}.`;
      await authStore.forgetPasswordChange();
    } catch (e) {
      clearedNote = failure(e, "Couldn't delete the older copies");
    } finally {
      clearingOld = false;
    }
  }

  // ---- Windows Hello unlock ---------------------------------------------------

  let helloPw = $state("");

  async function enableHello(event: SubmitEvent) {
    event.preventDefault();
    if (!helloPw || busy) return;
    busy = true;
    error = "";
    try {
      await authStore.enableHello(helloPw);
      helloPw = "";
      ontoast("Windows Hello unlock enabled");
    } catch (e) {
      // Tauri invoke rejects with plain strings (Rust error tokens).
      error = failure(e, "Could not enable Windows Hello");
    } finally {
      busy = false;
    }
  }

  async function disableHello() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await authStore.disableHello();
      ontoast("Windows Hello unlock disabled");
    } finally {
      busy = false;
    }
  }

  // ---- encrypted backup file (F-24) --------------------------------------------
  // The same end-to-end encrypted format as the Drive backups, saved where the
  // user chooses: a recovery path that needs neither Google nor this app's
  // Google Cloud project.

  let fileNote = $state("");

  async function exportBackupFile() {
    fileNote = "";
    busy = true;
    try {
      const { content } = await authStore.sealCloudBackup(
        { id: cloudBackup.config?.deviceId ?? "file-export", label: cloudBackup.deviceLabel },
        scope,
      );
      const stamp = new Date().toISOString().slice(0, 10);
      const name = `coretools-${scope}-backup-${stamp}.json`;
      if (await getPlatform().saveTextFile(name, content)) {
        fileNote = "Saved. It's encrypted with your master password — keep it somewhere safe, away from this computer.";
      }
    } catch (e) {
      fileNote = e instanceof Error ? e.message : "Export failed";
    } finally {
      busy = false;
    }
  }

  async function importBackupFile() {
    fileNote = "";
    try {
      const loaded = await getPlatform().openTextFile();
      if (!loaded) return;
      onimportfile({ file: parseCloudBackup(loaded.content), name: loaded.name });
    } catch (e) {
      fileNote =
        e instanceof CloudBackupError
          ? e.message
          : "That file isn't a CoreTools encrypted backup.";
    }
  }

  // ---- local snapshots (D-8) -------------------------------------------------------

  let snapshots = $state<SnapshotSummary[] | null>(null);
  const REASONS: Record<SnapshotSummary["reason"], string> = {
    "password-change": "before a password change",
    "password-removal": "before the password was removed",
    restore: "before a restore",
    "before-snapshot-restore": "before a snapshot was restored",
  };

  // Listed with or without a password: one taken before the password was
  // removed is how that is undone.
  $effect(() => {
    if (!authStore.locked && snapshots === null) {
      authStore
        .listSnapshots()
        .then((list) => (snapshots = list))
        .catch((e) => {
          noteFailure("vault", "snapshot list failed", e);
          snapshots = [];
          error = "Couldn't list the local snapshots.";
        });
    }
  });

  async function restoreSnapshot(snapshot: SnapshotSummary) {
    if (busy) return;
    const when = new Date(snapshot.at).toLocaleString();
    if (
      !window.confirm(
        `Put the vault back as it was on ${when}? The current state is kept as a snapshot too, so this can be undone. If the vault had another password then, you'll be asked for it.`,
      )
    ) {
      return;
    }
    busy = true;
    error = "";
    let oldPassword = false;
    const askOld = askPassword(`Enter the password the vault had on ${when}.`);
    try {
      await authStore.restoreSnapshot(
        snapshot.id,
        askPassword("Enter your master password to roll the vault back."),
        () => {
          oldPassword = true;
          return askOld();
        },
      );
      snapshots = null;
      ontoast(
        oldPassword
          ? "Vault rolled back — its password is now the one it had then"
          : "Vault rolled back",
      );
      onclose();
    } catch (e) {
      error = failure(e, "Couldn't restore the snapshot");
    } finally {
      busy = false;
    }
  }

  // ---- cloud backup (UI lives in CloudBackupPanel) ----------------------------

  function close() {
    // Don't leave a sign-in waiting on the browser behind a closed dialog.
    if (cloudBackup.activity === "connecting") void cloudBackup.cancelSignIn();
    onclose();
  }

  // ---- danger zone -----------------------------------------------------------

  let wipeConfirm = $state("");
  async function wipe() {
    if (wipeConfirm !== "DELETE" || busy) return;
    busy = true;
    error = "";
    try {
      await authStore.confirmUser(askPassword("Enter your master password to delete the vault."));
      await authStore.wipe();
      ontoast("All vault data deleted");
      onclose();
    } catch (e) {
      error = failure(e, "Couldn't delete the vault");
    } finally {
      busy = false;
    }
  }
</script>

<Modal {title} onclose={close}>
  <section>
    <h3>Encryption password</h3>
    {#if settingNew}
      <p class="muted">
        Secrets are currently stored <strong>unencrypted</strong>. Set a
        password (at least {MIN_PASSWORD_LENGTH} characters — a passphrase of a few words works well) to encrypt them at rest with
        AES-256-GCM. This password is independent of any other login.
        <strong>A forgotten password can't be recovered</strong> — keep it
        somewhere safe.
      </p>
    {:else}
      <p class="muted">
        Secrets are encrypted at rest. Changing the password re-encrypts all
        secrets.
      </p>
    {/if}
    <form onsubmit={applyPassword}>
      {#if !settingNew}
        <input
          type="password"
          bind:value={currentPw}
          placeholder="Current password"
          autocomplete="off"
          aria-label="Current password"
        />
      {/if}
      <input
        type="password"
        bind:value={newPw}
        placeholder={settingNew ? `New password (min. ${MIN_PASSWORD_LENGTH} chars)` : "New password"}
        autocomplete="off"
        aria-label="New password"
      />
      <input
        type="password"
        bind:value={confirmPw}
        placeholder="Confirm new password"
        autocomplete="off"
        aria-label="Confirm new password"
      />
      <PasswordStrength password={newPw} />
      {#if newPw && confirmPw && newPw !== confirmPw}
        <span class="field-error">Passwords do not match.</span>
      {/if}
      <button class="primary" type="submit" disabled={!pwFormOk || busy}>
        {settingNew ? "Set password & encrypt" : "Change password"}
      </button>
    </form>

    {#if authStore.passwordChangedAt}
      <div class="old-copies" role="status">
        <p>
          Older {cloudBackup.connected ? "cloud backups and " : ""}local snapshots
          still open with your <strong>old</strong> password. If it may have
          leaked, delete them.
        </p>
        <button onclick={clearOldCopies} disabled={clearingOld}>
          {clearingOld ? "Deleting…" : "Delete older copies"}
        </button>
      </div>
    {/if}
    {#if clearedNote}<p class="muted hint" role="status">{clearedNote}</p>{/if}

    {#if !settingNew && cloudBackup.connected}
      <p class="muted hint">
        Changing the password re-encrypts future cloud backups; older backup
        versions keep the password they were made with. To remove the
        password, disconnect cloud backup first — backups require it.
      </p>
    {:else if !settingNew}
      <form class="remove" onsubmit={removePassword}>
        <input
          type="password"
          bind:value={removePw}
          placeholder="Current password"
          autocomplete="off"
          aria-label="Current password to remove encryption"
        />
        <button type="submit" disabled={!removePw || busy}>
          Remove password (store unencrypted)
        </button>
      </form>
    {/if}
  </section>

  {#if cloudBackup.supported}
    <section>
      <h3>Cloud backup</h3>
      <CloudBackupPanel {scope} {onrestore} />
    </section>
  {/if}

  {#if authenticator || authStore.encrypted}
    <section>
      <h3>Backup file</h3>
      <p class="muted">
        Save an encrypted copy of your {authenticator ? "accounts" : "saved logins"}
        to a file, or restore one. It works without Google Drive and opens
        with your master password on any device.
      </p>
      <div class="file-actions">
        <button
          onclick={exportBackupFile}
          disabled={busy || authStore.locked || !authStore.encrypted}
          title={authStore.encrypted ? "" : "Set an encryption password first — it encrypts the file"}
        >
          Export encrypted file…
        </button>
        <button onclick={importBackupFile} disabled={busy}>Restore from file…</button>
      </div>
      {#if fileNote}<p class="muted hint" role="status">{fileNote}</p>{/if}
      {#if getPlatform().kind === "browser" && authStore.storagePersisted === false}
        <p class="warn hint" role="status">
          This browser may clear its stored data when space runs low or after a
          while without visits, and the browser version has no cloud backup.
          Export an encrypted file regularly.
        </p>
      {/if}
    </section>
  {/if}

  {#if snapshots?.length}
    <section>
      <h3>Local snapshots</h3>
      <p class="muted">
        Before each password change, password removal and restore, CoreTools
        keeps a copy of the vault as it was — the last few, on this device only.
      </p>
      <ul class="snapshots">
        {#each snapshots as snapshot (snapshot.id)}
          <li>
            <span>
              {new Date(snapshot.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              <span class="muted">· {REASONS[snapshot.reason]} · {snapshot.entries} accounts, {snapshot.credentials} logins</span>
            </span>
            <button onclick={() => restoreSnapshot(snapshot)} disabled={busy}>Restore</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if authStore.helloSupported && authStore.encrypted}
    <section>
      <h3>Windows Hello</h3>
      {#if authStore.helloEnabled}
        <p class="muted">
          Windows Hello unlock is <strong>enabled</strong>. Your vault key is
          wrapped by a TPM-backed key that only unlocks after a successful
          fingerprint / face / PIN verification. Your password always works as
          a fallback.
        </p>
        <button onclick={disableHello} disabled={busy}>
          Disable Windows Hello unlock
        </button>
      {:else}
        <p class="muted">
          Unlock with your fingerprint, face or Windows Hello PIN
          instead of typing the password. Enabling requires your current
          password and a Hello verification; the password remains the master
          fallback.
        </p>
        <form onsubmit={enableHello}>
          <input
            type="password"
            bind:value={helloPw}
            placeholder="Current password"
            autocomplete="off"
            aria-label="Current password to enable Windows Hello"
          />
          <button class="primary" type="submit" disabled={!helloPw || busy}>
            {busy ? "Waiting for Windows Hello…" : "Enable Windows Hello unlock"}
          </button>
        </form>
      {/if}
    </section>
  {/if}

  <section>
    <h3>Behavior</h3>
    <label class="inline">
      Auto-lock after
      <input
        type="number"
        min="0"
        max={MAX_AUTO_LOCK_MINUTES}
        value={authStore.settings.autoLockMinutes}
        onchange={(e) =>
          changeSetting(
            { autoLockMinutes: Math.max(0, Number(e.currentTarget.value) || 0) },
            e.currentTarget,
          )}
        disabled={!authStore.encrypted}
      />
      minutes of inactivity
      <span class="muted">(0 = never{authStore.encrypted ? "" : "; requires a password"})</span>
    </label>
    <label class="inline">
      <input
        type="checkbox"
        checked={authStore.settings.clipboardClear}
        onchange={(e) => changeSetting({ clipboardClear: e.currentTarget.checked }, e.currentTarget)}
      />
      Clear clipboard 30 seconds after copying {authenticator ? "a code" : "a password"}
    </label>
    {#if authenticator}
      <label class="inline">
        <input
          type="checkbox"
          checked={authStore.settings.groupCodes}
          onchange={(e) => changeSetting({ groupCodes: e.currentTarget.checked }, e.currentTarget)}
        />
        Group code digits ("123 456" instead of "123456")
      </label>
    {:else}
      <label class="inline">
        <input
          type="checkbox"
          checked={authStore.settings.credentialsRevealAuth}
          onchange={(e) =>
            changeSetting({ credentialsRevealAuth: e.currentTarget.checked }, e.currentTarget)}
        />
        Confirm it's you (Windows Hello or master password) before showing or
        copying a password
      </label>
    {/if}
  </section>

  <section class="danger-zone">
    <h3>Danger zone</h3>
    <p class="muted">
      Permanently deletes the whole vault from this device —
      {authenticator
        ? "every account here and in the Credential Manager, which shares it"
        : "every saved login (with its trash and activity log) and the Authenticator's accounts, which share it"}
      — plus the encryption settings, snapshots and preferences, and
      disconnects cloud backup. This cannot be undone. Backups already in
      Google Drive are kept. Export an encrypted backup file first (above) if
      you might want any of it back.
    </p>
    <div class="wipe-row">
      <input
        bind:value={wipeConfirm}
        placeholder={'Type "DELETE" to confirm'}
        autocomplete="off"
        aria-label="Type DELETE to confirm wipe"
      />
      <button
        class="danger-btn"
        disabled={wipeConfirm !== "DELETE" || busy}
        onclick={wipe}
      >
        Wipe all data
      </button>
    </div>
  </section>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
</Modal>

{#if prompt}
  <PasswordPrompt
    reason={prompt.reason}
    onsubmit={(pw) => prompt?.resolve(pw)}
    oncancel={() => prompt?.resolve(null)}
  />
{/if}

<style>
  .file-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  section {
    padding: 4px 0 16px;
  }
  section + section {
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 13.5px;
  }
  p {
    margin: 0 0 10px;
    font-size: 12.5px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  form.remove {
    margin-top: 14px;
    flex-direction: row;
  }
  form.remove input {
    flex: 1;
  }
  input[type="password"],
  .wipe-row input {
    font-family: inherit;
    font-size: 13px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .field-error {
    color: var(--danger);
    font-size: 11.5px;
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    padding: 5px 0;
    flex-wrap: wrap;
  }
  .inline input[type="number"] {
    width: 64px;
    padding: 5px 8px;
    font-family: inherit;
    font-size: 13px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  .inline input[type="checkbox"] {
    accent-color: var(--accent);
    width: 15px;
    height: 15px;
  }
  .danger-zone h3 {
    color: var(--danger);
  }
  .wipe-row {
    display: flex;
    gap: 8px;
  }
  .wipe-row input {
    flex: 1;
  }
  .danger-btn {
    border-color: var(--danger);
    color: var(--danger);
    font-weight: 600;
  }
  .danger-btn:hover:not(:disabled) {
    background: var(--removed-bg);
  }
  .error {
    color: var(--danger);
    font-size: 13px;
    margin: 10px 0 0;
  }
  .hint {
    margin: 12px 0 0;
    font-size: 12px;
  }
  .warn {
    color: var(--danger);
  }
  .old-copies {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: 8px;
    background: color-mix(in srgb, #f6ad55 12%, transparent);
    border: 1px solid color-mix(in srgb, #f6ad55 35%, transparent);
  }
  .old-copies p {
    flex: 1;
    margin: 0;
  }
  .snapshots {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .snapshots li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12.5px;
  }
</style>
