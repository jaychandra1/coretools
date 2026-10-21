<script lang="ts">
  import Modal from "../authenticator/Modal.svelte";
  import { credentialStore } from "./credentials.svelte";
  import {
    canonicalSpace,
    renameInOrder,
    spaceNameError,
    SPACE_NAME_MAX,
  } from "../../core/credentials/spaces";
  import { focusOnMount } from "../../focus";
  import IconButton from "./IconButton.svelte";
  import SpaceDot from "./SpaceDot.svelte";

  /** Rename, merge, remove and reorder spaces. Removing a space never deletes logins. */
  let {
    spaces,
    totals,
    active,
    onselect,
    onmove,
    ontoast,
    onfail,
    onclose,
  }: {
    spaces: readonly string[];
    /** Logins per space. */
    totals: ReadonlyMap<string, number>;
    /** The space tab on screen. */
    active: string;
    onselect: (space: string) => void;
    /** Move a space one place up (-1) or down (+1). */
    onmove: (space: string, delta: number) => void;
    ontoast: (text: string) => void;
    onfail: (error: unknown, fallback: string) => void;
    onclose: () => void;
  } = $props();

  /** The space being renamed, or confirmed for removal. */
  let renaming = $state<string | null>(null);
  let renameText = $state("");
  let removing = $state<string | null>(null);
  let busy = $state(false);
  let error = $state("");

  const renameTarget = $derived(
    renaming ? canonicalSpace(renameText, spaces.filter((s) => s !== renaming)) : "",
  );
  const renameMerges = $derived(
    !!renaming && renameTarget !== "" && spaces.some((s) => s !== renaming && s === renameTarget),
  );

  function startRename(name: string) {
    removing = null;
    renaming = name;
    renameText = name;
    error = "";
  }

  /** Keep a saved tab order in step with a rename, merge or removal (`to` = null). */
  async function reorderAfter(from: string, to: string | null) {
    if (credentialStore.spaceOrder.length === 0) return;
    await credentialStore.setSpaceOrder(renameInOrder(credentialStore.spaceOrder, from, to));
  }

  /** A space created this session that still has no logins follows a rename. */
  function swapPending(from: string, to: string | null) {
    const rest = credentialStore.pendingSpaces.filter((s) => s !== from);
    credentialStore.pendingSpaces = to && !rest.includes(to) ? [...rest, to] : rest;
  }

  async function commitRename(event: SubmitEvent) {
    event.preventDefault();
    const from = renaming;
    if (!from || busy) return;
    error = spaceNameError(renameText) ?? "";
    if (error) return;
    // Read before the move: afterwards `to` is a space either way.
    const to = renameTarget;
    const merging = renameMerges;
    busy = true;
    try {
      if (to !== from) {
        await credentialStore.moveToSpace(credentialStore.idsInSpace(from), to);
        await reorderAfter(from, to);
        swapPending(from, credentialStore.idsInSpace(to).length ? null : to);
        if (active === from) onselect(to);
        ontoast(merging ? `Moved “${from}” into “${to}”` : `Renamed to “${to}”`);
      }
      renaming = null;
    } catch (e) {
      onfail(e, "Couldn't rename the space");
    } finally {
      busy = false;
    }
  }

  async function remove(name: string) {
    if (busy) return;
    busy = true;
    try {
      const moved = await credentialStore.moveToSpace(credentialStore.idsInSpace(name), "");
      await reorderAfter(name, null);
      swapPending(name, null);
      if (active === name) onselect("");
      removing = null;
      ontoast(
        moved
          ? `Removed “${name}” — its ${moved === 1 ? "login is" : `${moved} logins are`} still under All`
          : `Removed “${name}”`,
      );
      if (spaces.length === 0) onclose(); // nothing left to manage
    } catch (e) {
      onfail(e, "Couldn't remove the space");
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="Manage spaces" {onclose}>
  <ul>
    {#each spaces as s, i (s)}
      {@const total = totals.get(s) ?? 0}
      <li>
        {#if renaming === s}
          <form class="row" onsubmit={commitRename} novalidate>
            <SpaceDot name={s} />
            <input
              bind:value={renameText}
              oninput={() => (error = "")}
              maxlength={SPACE_NAME_MAX}
              aria-label="New name for {s}"
              autocomplete="off"
              {@attach focusOnMount}
            />
            <button class="primary" type="submit" disabled={busy}>Save</button>
            <button type="button" onclick={() => (renaming = null)}>Cancel</button>
          </form>
          {#if error}
            <span class="field-error" role="alert">{error}</span>
          {:else if renameMerges}
            <span class="note">“{renameTarget}” already exists — its logins and these will be one space.</span>
          {/if}
        {:else if removing === s}
          <div class="row">
            <span class="confirm">
              Remove “{s}”?
              {total
                ? `${total === 1 ? "Its login stays" : `Its ${total} logins stay`} saved and show under All only.`
                : "It has no logins."}
            </span>
            <button class="danger-solid" onclick={() => remove(s)} disabled={busy}>Remove</button>
            <button onclick={() => (removing = null)}>Cancel</button>
          </div>
        {:else}
          <div class="row">
            <SpaceDot name={s} />
            <span class="label">{s}</span>
            <span class="muted count">{total} {total === 1 ? "login" : "logins"}</span>
            <IconButton icon="up" tip="Move {s} up" onclick={() => onmove(s, -1)} disabled={i === 0} />
            <IconButton icon="down" tip="Move {s} down" onclick={() => onmove(s, 1)} disabled={i === spaces.length - 1} />
            <button class="ghost" onclick={() => startRename(s)}>Rename</button>
            <button class="ghost danger" onclick={() => { renaming = null; removing = s; }}>Remove</button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="muted">
    Drag the tabs, or use the arrows here, to change their order. Removing
    a space never deletes logins. Spaces travel with your encrypted backups.
  </p>
</Modal>

<style>
  ul {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  li {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
  }
  li:first-child {
    border-top: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
  }
  .row input {
    flex: 1;
    font-family: inherit;
    font-size: 13px;
    padding: 8px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    min-width: 0;
  }
  .row button {
    font-size: 12px;
    padding: 5px 10px;
    border-radius: 7px;
  }
  .label {
    flex: 1;
    font-weight: 600;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count,
  p {
    font-size: 12px;
  }
  .confirm {
    flex: 1;
    font-size: 12.5px;
  }
  .note {
    font-size: 12px;
    color: var(--text-muted);
  }
  .field-error {
    color: var(--danger);
    font-size: 12px;
  }
  .ghost {
    background: transparent;
  }
  .ghost.danger {
    color: var(--danger);
  }
  .danger-solid {
    background: var(--danger);
    border-color: var(--danger);
    color: #fff;
    font-weight: 600;
  }
</style>
