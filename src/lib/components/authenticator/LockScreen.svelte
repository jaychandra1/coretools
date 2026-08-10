<script lang="ts">
  import { authStore } from "./store.svelte";

  let password = $state("");
  let error = $state("");
  let busy = $state(false);
  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    input?.focus();
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
      error = e instanceof Error ? e.message : "Unlock failed";
      input?.select();
    } finally {
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
      Your secrets are encrypted at rest. Enter your encryption password to
      unlock this section.
    </p>
    <form onsubmit={unlock}>
      <input
        bind:this={input}
        bind:value={password}
        type="password"
        placeholder="Encryption password"
        autocomplete="current-password"
        aria-label="Encryption password"
        disabled={busy}
      />
      <button class="primary" type="submit" disabled={!password || busy}>
        {busy ? "Unlocking…" : "Unlock"}
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
  .error {
    margin: 12px 0 0;
    color: var(--danger);
    font-size: 13px;
  }
</style>
