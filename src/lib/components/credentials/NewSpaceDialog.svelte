<script lang="ts">
  import Modal from "../authenticator/Modal.svelte";
  import { canonicalSpace, spaceNameError, SPACE_NAME_MAX } from "../../core/credentials/spaces";
  import { focusOnMount } from "../../focus";

  let {
    spaces,
    oncreate,
    onclose,
  }: {
    spaces: readonly string[];
    /** The name to open: new, or an existing space typed in another case. */
    oncreate: (name: string) => void;
    onclose: () => void;
  } = $props();

  let name = $state("");
  let error = $state("");

  function submit(event: SubmitEvent) {
    event.preventDefault();
    error = spaceNameError(name) ?? "";
    if (!error) oncreate(canonicalSpace(name, spaces));
  }
</script>

<Modal title="New space" {onclose}>
  <form onsubmit={submit} novalidate>
    <p class="muted">
      Spaces split your logins into tabs, such as Personal, Dev team or
      Organisation. Each login can be in one space; All lists every login.
    </p>
    <input
      bind:value={name}
      oninput={() => (error = "")}
      maxlength={SPACE_NAME_MAX}
      placeholder="Dev team"
      aria-label="Space name"
      autocomplete="off"
      {@attach focusOnMount}
    />
    {#if error}<span class="field-error" role="alert">{error}</span>{/if}
    <div class="modal-actions">
      <button type="button" onclick={onclose}>Cancel</button>
      <button class="primary" type="submit">Create space</button>
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
    font-size: 12px;
  }
  input {
    font-family: inherit;
    font-size: 13px;
    padding: 8px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    min-width: 0;
  }
  .field-error {
    color: var(--danger);
    font-size: 12px;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
</style>
