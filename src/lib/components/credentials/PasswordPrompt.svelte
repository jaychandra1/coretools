<script lang="ts">
  import Modal from "../authenticator/Modal.svelte";
  import { focusOnMount } from "../../focus";

  let {
    onsubmit,
    oncancel,
    reason = "Enter your master password to show or copy saved passwords.",
  }: {
    onsubmit: (password: string) => void;
    oncancel: () => void;
    /** What the password unlocks, shown above the field. */
    reason?: string;
  } = $props();

  let password = $state("");

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (password) onsubmit(password);
  }
</script>

<Modal title="Confirm it's you" onclose={oncancel}>
  <form onsubmit={submit}>
    <p class="muted">{reason} You won't be asked again for a minute.</p>
    <!-- autocomplete off: browsers shouldn't save, or fill in, the master password (L8). -->
    <input
      type="password"
      bind:value={password}
      placeholder="Master password"
      autocomplete="off"
      aria-label="Master password"
      {@attach focusOnMount}
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
