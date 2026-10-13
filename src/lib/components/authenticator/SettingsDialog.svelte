<script lang="ts">
  import Modal from "./Modal.svelte";
  import { authStore } from "./store.svelte";
  import { cloudBackup } from "./cloud.svelte";
  import CloudBackupPanel from "./CloudBackupPanel.svelte";
  import PasswordStrength from "./PasswordStrength.svelte";
  import { assessPassword, MIN_PASSWORD_LENGTH } from "../../core/authenticator/password-strength";
  import type { BackupKind } from "../../core/authenticator/cloud-sync";
  import { CloudBackupError, parseCloudBackup, type CloudBackupFile } from "../../core/authenticator/cloud-backup";
  import { getPlatform } from "../../platform";

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
      const message =
        e instanceof Error ? e.message : typeof e === "string" ? e : "";
      error =
        message === "hello_canceled"
          ? ""
          : message || "Could not enable Windows Hello";
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
      const text = await authStore.sealCloudBackup(
        { id: cloudBackup.config?.deviceId ?? "file-export", label: cloudBackup.deviceLabel },
        scope,
      );
      const stamp = new Date().toISOString().slice(0, 10);
      const name = `coretools-${scope}-backup-${stamp}.json`;
      if (await getPlatform().saveTextFile(name, text)) {
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
    try {
      await authStore.wipe();
      ontoast("All vault data deleted");
      onclose();
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
          autocomplete="current-password"
          aria-label="Current password"
        />
      {/if}
      <input
        type="password"
        bind:value={newPw}
        placeholder={settingNew ? `New password (min. ${MIN_PASSWORD_LENGTH} chars)` : "New password"}
        autocomplete="new-password"
        aria-label="New password"
      />
      <input
        type="password"
        bind:value={confirmPw}
        placeholder="Confirm new password"
        autocomplete="new-password"
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
          autocomplete="current-password"
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
            autocomplete="current-password"
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
        max="240"
        value={authStore.settings.autoLockMinutes}
        onchange={(e) =>
          authStore.updateSettings({
            autoLockMinutes: Math.max(0, Number(e.currentTarget.value) || 0),
          })}
        disabled={!authStore.encrypted}
      />
      minutes of inactivity
      <span class="muted">(0 = never{authStore.encrypted ? "" : "; requires a password"})</span>
    </label>
    <label class="inline">
      <input
        type="checkbox"
        checked={authStore.settings.clipboardClear}
        onchange={(e) =>
          authStore.updateSettings({ clipboardClear: e.currentTarget.checked })}
      />
      Clear clipboard 30 seconds after copying {authenticator ? "a code" : "a password"}
    </label>
    {#if authenticator}
      <label class="inline">
        <input
          type="checkbox"
          checked={authStore.settings.groupCodes}
          onchange={(e) =>
            authStore.updateSettings({ groupCodes: e.currentTarget.checked })}
        />
        Group code digits ("123 456" instead of "123456")
      </label>
    {:else}
      <label class="inline">
        <input
          type="checkbox"
          checked={authStore.settings.credentialsRevealAuth}
          onchange={(e) =>
            authStore.updateSettings({ credentialsRevealAuth: e.currentTarget.checked })}
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
      — plus the encryption settings and preferences, and disconnects cloud
      backup. This cannot be undone. Backups already in Google Drive are kept.
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
</style>
