<script lang="ts">
  import { authStore } from "../authenticator/store.svelte";
  import PasswordStrength from "../authenticator/PasswordStrength.svelte";
  import { assessPassword } from "../../core/authenticator/password-strength";
  import Icon from "./Icon.svelte";

  /** First run: the Credential Manager needs the vault encrypted before anything is saved. */
  let { ondone }: { ondone: (message: string) => void } = $props();

  let newPw = $state("");
  let confirmPw = $state("");
  let error = $state("");
  let busy = $state(false);

  async function createVault(event: SubmitEvent) {
    event.preventDefault();
    if (!assessPassword(newPw).ok || newPw !== confirmPw || busy) return;
    busy = true;
    error = "";
    try {
      await authStore.setPassword(newPw);
      newPw = confirmPw = "";
      ondone("Master password set — your vault is encrypted");
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't set the password";
    } finally {
      busy = false;
    }
  }
</script>

<div class="onboard">
  <span class="hero-icon"><Icon name="lock" /></span>
  <h2>Set a master password</h2>
  <p class="muted">
    The Credential Manager keeps every password encrypted with AES-256-GCM
    under a key derived from your master password. It's the same vault
    password as the Authenticator, so one password (or Windows Hello)
    unlocks both{authStore.entries.length > 0 ? " — and setting it also encrypts your Authenticator accounts" : ""}.
  </p>
  <form onsubmit={createVault}>
    <input type="password" bind:value={newPw} placeholder="Master password (min. 12 characters)" autocomplete="off" aria-label="Master password" />
    <input type="password" bind:value={confirmPw} placeholder="Confirm master password" autocomplete="off" aria-label="Confirm master password" />
    <PasswordStrength password={newPw} />
    {#if newPw && confirmPw && newPw !== confirmPw}
      <span class="field-error">Passwords don't match.</span>
    {/if}
    <button class="primary" type="submit" disabled={!assessPassword(newPw).ok || newPw !== confirmPw || busy}>
      {busy ? "Encrypting…" : "Create encrypted vault"}
    </button>
    {#if error}<span class="field-error" role="alert">{error}</span>{/if}
  </form>
  <p class="muted small">There's no way to recover a forgotten master password — store it somewhere safe.</p>
</div>

<style>
  .onboard {
    max-width: 440px;
    margin: 40px auto;
    padding: 28px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--accent) 8%, transparent), transparent 120px),
      var(--surface);
    text-align: center;
  }
  .onboard h2 {
    margin: 12px 0 6px;
    font-size: 18px;
  }
  .onboard p {
    font-size: 13px;
    line-height: 1.55;
  }
  .onboard .small {
    font-size: 12px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 18px 0 10px;
    text-align: left;
  }
  input {
    font-family: inherit;
    font-size: 13px;
    color: var(--text);
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
  }
  .hero-icon {
    display: inline-grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .hero-icon :global(svg) {
    width: 22px;
    height: 22px;
  }
  .field-error {
    color: var(--danger);
    font-size: 12px;
  }
</style>
