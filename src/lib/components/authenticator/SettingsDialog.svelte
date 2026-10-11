<script lang="ts">
  import Modal from "./Modal.svelte";
  import { authStore } from "./store.svelte";
  import { cloudBackup } from "./cloud.svelte";

  let {
    onclose,
    ontoast,
    onrestore,
  }: {
    onclose: () => void;
    ontoast: (message: string) => void;
    /** Open the restore dialog, optionally preselecting a version. */
    onrestore: (preselectId?: string) => void;
  } = $props();

  let error = $state("");
  let busy = $state(false);

  // ---- encryption password -------------------------------------------------

  let currentPw = $state("");
  let newPw = $state("");
  let confirmPw = $state("");

  const settingNew = $derived(!authStore.encrypted);
  const pwFormOk = $derived(
    newPw.length >= 8 &&
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

  // ---- cloud backup ------------------------------------------------------------

  const cloudBusy = $derived(cloudBackup.activity !== null);

  function formatWhen(ms: number | null | undefined): string {
    if (!ms) return "Never";
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  const cloudStatus = $derived.by((): { tone: "ok" | "muted" | "warn" | "bad"; text: string } => {
    switch (cloudBackup.status) {
      case "up-to-date":
        return { tone: "ok", text: "Up to date" };
      case "pending":
        return {
          tone: "muted",
          text: authStore.locked
            ? "Changes waiting — backs up after unlock"
            : cloudBackup.config?.autoBackup
              ? "Changes waiting to back up…"
              : "Changes not backed up yet",
        };
      case "working":
        return {
          tone: "muted",
          text:
            cloudBackup.activity === "backing-up"
              ? "Backing up…"
              : cloudBackup.activity === "restoring"
                ? "Restoring…"
                : cloudBackup.activity === "deleting"
                  ? "Deleting backups…"
                  : "Working…",
        };
      case "retrying":
        return {
          tone: "warn",
          text: `Couldn't reach Google Drive — retrying at ${new Date(cloudBackup.retryAt ?? 0).toLocaleTimeString(undefined, { timeStyle: "short" })}`,
        };
      case "error":
        return { tone: "bad", text: cloudBackup.lastError ?? "Backup failed" };
      case "conflict":
        return {
          tone: "warn",
          text: `Newer backup from ${cloudBackup.conflict?.deviceLabel || "another device"} — resolve below`,
        };
      case "needs-password":
        return { tone: "warn", text: "Paused — set an encryption password" };
      case "reconnect":
        return { tone: "bad", text: "Google access lost — reconnect to resume" };
      default:
        return { tone: "muted", text: "" };
    }
  });

  async function connectCloud() {
    await cloudBackup.connect();
  }

  function close() {
    // Don't leave a sign-in waiting on the browser behind a closed dialog.
    if (cloudBackup.activity === "connecting") void cloudBackup.cancelSignIn();
    onclose();
  }

  async function disconnectCloud() {
    if (
      !window.confirm(
        "Disconnect your Google account? Automatic backups stop. Backups already in Google Drive are kept until you delete them.",
      )
    ) {
      return;
    }
    await cloudBackup.disconnect();
  }

  async function deleteCloudBackups() {
    if (
      !window.confirm(
        "Permanently delete ALL CoreTools backups from your Google Drive? You won't be able to restore them on a new device. This cannot be undone.",
      )
    ) {
      return;
    }
    await cloudBackup.deleteAllBackups();
  }

  async function keepThisDevice() {
    const other = cloudBackup.conflict?.deviceLabel || "the other device";
    if (
      !window.confirm(
        `Upload this device's accounts as the newest backup? Accounts added on ${other} that aren't here won't be in it (its backup stays available as an older version).`,
      )
    ) {
      return;
    }
    await cloudBackup.keepThisDevice();
  }

  // ---- danger zone -----------------------------------------------------------

  let wipeConfirm = $state("");
  async function wipe() {
    if (wipeConfirm !== "DELETE" || busy) return;
    busy = true;
    try {
      await authStore.wipe();
      ontoast("All authenticator data deleted");
      onclose();
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="Authenticator settings" onclose={close}>
  <section>
    <h3>Encryption password</h3>
    {#if settingNew}
      <p class="muted">
        Secrets are currently stored <strong>unencrypted</strong>. Set a
        password (min. 8 characters) to encrypt them at rest with
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
        placeholder={settingNew ? "New password (min. 8 chars)" : "New password"}
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
      {#if newPw && confirmPw && newPw !== confirmPw}
        <span class="field-error">Passwords do not match.</span>
      {:else if newPw && newPw.length < 8}
        <span class="field-error">Use at least 8 characters.</span>
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
      <h3>Cloud backup (Google Drive)</h3>
      {#if !cloudBackup.configured}
        <p class="muted">
          Google sign-in isn't configured in this build of CoreTools, so cloud
          backup is unavailable. Use Export for manual backups.
        </p>
      {:else if !cloudBackup.connected}
        <p class="muted">
          Back up every account automatically to your Google Drive —
          <strong>end-to-end encrypted</strong> with your encryption password
          before it leaves this device, so Google can't read it. On a new
          device or after a reinstall, sign in and restore.
        </p>
        {#if cloudBackup.needsReconnect && cloudBackup.config?.email}
          <p class="notice warning">
            Backups to {cloudBackup.config.email} stopped because Google access
            was lost. Reconnect to resume.
          </p>
        {/if}
        {#if !authStore.encrypted}
          <p class="notice warning">
            Set an encryption password above first — it encrypts your backups,
            and you'll need it to restore them.
          </p>
        {/if}
        <div class="row">
          {#if cloudBackup.activity === "connecting"}
            <span class="waiting">Waiting for Google sign-in in your browser…</span>
            <button onclick={() => cloudBackup.cancelSignIn()}>Cancel</button>
          {:else}
            <button
              class="primary"
              onclick={connectCloud}
              disabled={!authStore.encrypted || cloudBusy}
            >
              {cloudBackup.needsReconnect ? "Reconnect Google account" : "Connect Google Account"}
            </button>
            <button onclick={() => onrestore()} disabled={cloudBusy}>
              Restore from Google Drive…
            </button>
          {/if}
        </div>
      {:else}
        <dl class="cloud-status">
          <dt>Account</dt>
          <dd>{cloudBackup.account}</dd>
          <dt>Status</dt>
          <dd class="tone-{cloudStatus.tone}">{cloudStatus.text}</dd>
          <dt>Last backup</dt>
          <dd>{formatWhen(cloudBackup.config?.lastBackupAt)}</dd>
          {#if cloudBackup.config?.lastRestoreAt}
            <dt>Last restore</dt>
            <dd>{formatWhen(cloudBackup.config.lastRestoreAt)}</dd>
          {/if}
        </dl>

        {#if cloudBackup.conflict}
          <p class="notice warning">
            {cloudBackup.conflict.deviceLabel || "Another device"} backed up at
            {new Date(cloudBackup.conflict.createdTime).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}. Automatic backups from this device are paused so its changes
            aren't buried.
          </p>
          <div class="row">
            <button class="primary" onclick={() => onrestore(cloudBackup.conflict?.id)} disabled={cloudBusy}>
              Review &amp; merge…
            </button>
            <button onclick={keepThisDevice} disabled={cloudBusy}>
              Keep this device's data
            </button>
          </div>
        {/if}

        {#if cloudBackup.status === "reconnect"}
          <div class="row">
            <button class="primary" onclick={connectCloud} disabled={cloudBusy}>
              Reconnect Google account
            </button>
          </div>
        {/if}

        <label class="inline">
          <input
            type="checkbox"
            checked={cloudBackup.config?.autoBackup ?? true}
            onchange={(e) => cloudBackup.setAutoBackup(e.currentTarget.checked)}
          />
          Back up automatically after every change
        </label>
        <div class="row">
          <button
            class="primary"
            onclick={() => cloudBackup.backupNow()}
            disabled={cloudBusy || !authStore.encrypted || cloudBackup.needsReconnect}
          >
            {cloudBackup.activity === "backing-up" ? "Backing up…" : "Backup now"}
          </button>
          <button onclick={() => onrestore()} disabled={cloudBusy}>Restore backup…</button>
        </div>
        <div class="row">
          <button onclick={disconnectCloud} disabled={cloudBusy}>Disconnect account</button>
          <button class="danger-btn" onclick={deleteCloudBackups} disabled={cloudBusy}>
            Delete cloud backups
          </button>
        </div>
      {/if}

      {#if cloudBackup.notice}
        <p
          class="notice {cloudBackup.notice.kind}"
          role={cloudBackup.notice.kind === "error" ? "alert" : "status"}
        >
          {cloudBackup.notice.text}
        </p>
      {/if}
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
          Unlock this section with your fingerprint, face or Windows Hello PIN
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
      Clear clipboard 30 seconds after copying a code
    </label>
    <label class="inline">
      <input
        type="checkbox"
        checked={authStore.settings.groupCodes}
        onchange={(e) =>
          authStore.updateSettings({ groupCodes: e.currentTarget.checked })}
      />
      Group code digits ("123 456" instead of "123456")
    </label>
  </section>

  <section class="danger-zone">
    <h3>Danger zone</h3>
    <p class="muted">
      Permanently deletes every account, the encryption settings and all
      preferences from this device, and disconnects cloud backup. This cannot
      be undone — export a backup first. Backups already in Google Drive are
      kept.
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
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .waiting {
    flex: 1;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .cloud-status {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 14px;
    margin: 0 0 8px;
    font-size: 12.5px;
  }
  .cloud-status dt {
    color: var(--text-muted);
  }
  .cloud-status dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .tone-ok {
    color: var(--added-fg);
    font-weight: 600;
  }
  .tone-muted {
    color: var(--text-muted);
  }
  .tone-warn,
  .tone-bad {
    color: var(--danger);
    font-weight: 600;
  }
  .notice {
    margin: 10px 0 0;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 12.5px;
  }
  .notice.success {
    background: var(--added-bg);
    color: var(--added-fg);
  }
  .notice.warning {
    background: var(--accent-soft);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .notice.error {
    background: var(--removed-bg);
    color: var(--removed-fg);
  }
</style>
