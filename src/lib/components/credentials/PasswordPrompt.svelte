<script lang="ts">
  import Modal from "../authenticator/Modal.svelte";

  let {
    onsubmit,
    oncancel,
  }: {
    onsubmit: (password: string) => void;
    oncancel: () => void;
  } = $props();

  let password = $state("");

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (password) onsubmit(password);
  }
</script>

<Modal title="Confirm it's you" onclose={oncancel}>
  <form onsubmit={submit}>
    <p class="muted">
      Enter your master password to show or copy saved passwords. You won't be
      asked again for a minute.
    </p>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      type="password"
      bind:value={password}
      placeholder="Master password"
      autocomplete="current-password"
      aria-label="Master password"
      autofocus
    />
    <div class="actions">
      <button type="button" onclick={oncancel}>Cancel</button>
      <button class="primary" type="submit" disabled={!password}>Confirm</button>
    </div>
  </form>
</Modal>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  p {
    margin: 0;
    font-size: 12.5px;
  }
  input {
    font-family: inherit;
    font-size: 13px;
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
  }
  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
