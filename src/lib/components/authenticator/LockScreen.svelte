<script lang="ts">
  import { authStore } from "./store.svelte";

  let password = $state("");
  let error = $state("");
  let busy = $state(false);
  /** True while the OS Windows Hello dialog is open. */
  let helloWaiting = $state(false);
  let input: HTMLInputElement | undefined = $state();

  // Tauri invoke rejects with plain strings (our Rust error tokens);
  // normalize both shapes before matching on them.
  function errorText(e: unknown): string {
    if (e instanceof Error) return e.message;
    return typeof e === "string" ? e : "";
  }

  // Hello-first: when Hello unlock is configured, open the OS prompt
  // automatically — but only for the initial app-load lock. After a manual
  // lock or an idle auto-lock the button is primary instead, so a system
  // dialog never pops up unrequested.
  let autoPrompted = false;
  $effect(() => {
    if (
      authStore.canUnlockWithHello &&
      authStore.lockReason === "initial" &&
      !autoPrompted
    ) {
      autoPrompted = true;
      unlockWithHello();
    }
  });

  // Focus the password field only when it is the primary method; while the
  // Hello prompt is up, focus stealing would fight the OS dialog.
  $effect(() => {
    if (!authStore.canUnlockWithHello) input?.focus();
  });

  async function unlock(event: SubmitEvent) {
    event.preventDefault();
    if (!password || busy) return;
    busy = true;
    error = "";
    try {
      await authStore.unlock(password);
      password = "";
    } catch (e) {
      error = errorText(e) || "Unlock failed";
      input?.select();
    } finally {
      busy = false;
    }
  }

  async function unlockWithHello() {
    if (busy) return;
    busy = true;
    helloWaiting = true;
    error = "";
    try {
      // Resolves only after the OS reports a successful verification AND the
      // signature cryptographically unwraps + validates the vault key
      // (see store.unlockWithHello). Cancel/failure lands in catch.
      await authStore.unlockWithHello();
    } catch (e) {
      const message = errorText(e);
      if (message === "hello_canceled") {
        // User dismissed the OS prompt — fall through to the password field.
      } else if (message.includes("hello_not_found")) {
        // Windows invalidated the key (e.g. biometrics re-enrolled).
        await authStore.clearStaleHello();
        error =
          "Windows Hello was reset on this device. Unlock with your password, then re-enable Hello in Settings.";
      } else if (message === "hello_device_locked") {
        error =
          "Windows Hello is temporarily locked by the OS. Use your password instead.";
      } else {
        error = message || "Windows Hello unlock failed";
      }
      input?.focus();
    } finally {
      helloWaiting = false;
      busy = false;
    }
  }
</script>

<div class="lock">
  <div class="panel">
    <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15" r="1.4" fill="var(--accent)" stroke="none" />
    </svg>
    <h2>Authenticator locked</h2>
    <p class="muted">
      {#if authStore.canUnlockWithHello}
        Confirm it's you with Windows Hello, or enter your encryption
        password.
      {:else}
        Your secrets are encrypted at rest. Enter your encryption password to
        unlock this section.
      {/if}
    </p>

    {#if authStore.canUnlockWithHello}
      <button
        type="button"
        class="primary hello"
        onclick={unlockWithHello}
        disabled={busy}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M7 4.6A9 9 0 0 1 21 12c0 2.2-.3 4.3-.9 6.3" />
          <path d="M4.2 8A9 9 0 0 0 3 12c0 2.5.6 4.9 1.6 7" />
          <path d="M12 8a4 4 0 0 1 4 4c0 2.5-.4 4.9-1.2 7.1" />
          <path d="M8 12a4 4 0 0 1 .1-.9M8.4 15.5c-.1 1.3-.4 2.5-.8 3.7" />
          <path d="M12 12v1.8c0 1.9-.2 3.8-.7 5.6" />
        </svg>
        {helloWaiting ? "Waiting for Windows Hello…" : "Unlock with Windows Hello"}
      </button>
      <div class="divider" role="separator">or use your password</div>
    {/if}

    <form onsubmit={unlock}>
      <input
        bind:this={input}
        bind:value={password}
        type="password"
        placeholder="Encryption password"
        autocomplete="current-password"
        aria-label="Encryption password"
        disabled={busy && helloWaiting}
      />
      <button
        class:primary={!authStore.canUnlockWithHello}
        type="submit"
        disabled={!password || busy}
      >
        {busy && !helloWaiting ? "Unlocking…" : "Unlock"}
      </button>
    </form>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  </div>
</div>

<style>
  .lock {
    display: grid;
    place-items: center;
    min-height: 340px;
  }
  .panel {
    text-align: center;
    max-width: 360px;
    width: 100%;
    padding: 32px 28px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  h2 {
    margin: 12px 0 4px;
    font-size: 17px;
  }
  p {
    margin: 0 0 16px;
    font-size: 13px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  input {
    font-family: inherit;
    font-size: 14px;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .hello {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
  }
  .divider {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-muted);
    font-size: 11.5px;
    margin: 14px 0;
  }
  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .error {
    margin: 12px 0 0;
    color: var(--danger);
    font-size: 13px;
  }
</style>
