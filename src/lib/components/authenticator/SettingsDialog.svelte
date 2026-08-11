<script lang="ts">
  import Modal from "./Modal.svelte";
  import { authStore } from "./store.svelte";

  let {
    onclose,
    ontoast,
  }: {
    onclose: () => void;
    ontoast: (message: string) => void;
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
      const message = e instanceof Error ? e.message : "";
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

<Modal title="Authenticator settings" {onclose}>
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

    {#if !settingNew}
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
      preferences. This cannot be undone — export a backup first.
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
</style>
