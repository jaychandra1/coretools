<script lang="ts">
  import TreeNode from "./TreeNode.svelte";
  import { jsonTypeOf, type JsonPathSegments, type JsonValue } from "../../core/json-studio/types";
  import { coerceScalarInput } from "../../core/json-studio/tree-edit";

  let {
    label,
    value,
    path,
    depth,
    inArray,
    onedit,
    ondelete,
    onrename,
    onaddchild,
  }: {
    /** Key name (objects) or index (arrays); null for the root. */
    label: string | number | null;
    value: JsonValue;
    path: JsonPathSegments;
    depth: number;
    inArray: boolean;
    onedit: (path: JsonPathSegments, value: JsonValue) => void;
    ondelete: (path: JsonPathSegments) => void;
    onrename: (parentPath: JsonPathSegments, oldKey: string, newKey: string) => void;
    onaddchild: (path: JsonPathSegments, key: string | null, value: JsonValue) => void;
  } = $props();

  const type = $derived(jsonTypeOf(value));
  const isContainer = $derived(type === "object" || type === "array");
  const entries = $derived.by((): Array<[string | number, JsonValue]> => {
    if (type === "array") return (value as JsonValue[]).map((v, i) => [i, v]);
    if (type === "object") return Object.entries(value as { [k: string]: JsonValue });
    return [];
  });

  // svelte-ignore state_referenced_locally -- depth intentionally seeds only
  // the initial expansion; nodes don't re-collapse when the tree re-renders.
  let expanded = $state(depth < 2);
  let editingValue = $state(false);
  let editingKey = $state(false);
  let adding = $state(false);
  let draft = $state("");
  let draftKey = $state("");
  let addKey = $state("");
  let addValue = $state("");
  let error = $state("");

  const preview = $derived.by(() => {
    switch (type) {
      case "object": {
        const count = entries.length;
        return `{ ${count} ${count === 1 ? "key" : "keys"} }`;
      }
      case "array":
        return `[ ${entries.length} ${entries.length === 1 ? "item" : "items"} ]`;
      case "string":
        return JSON.stringify(value);
      default:
        return String(value);
    }
  });

  function startValueEdit() {
    if (isContainer) return;
    draft = type === "string" ? (value as string) : JSON.stringify(value);
    editingValue = true;
    error = "";
  }

  function commitValueEdit() {
    onedit(path, coerceScalarInput(draft));
    editingValue = false;
  }

  function startKeyEdit() {
    if (label === null || inArray) return;
    draftKey = String(label);
    editingKey = true;
    error = "";
  }

  function commitKeyEdit() {
    if (label === null || draftKey === String(label)) {
      editingKey = false;
      return;
    }
    try {
      onrename(path.slice(0, -1), String(label), draftKey);
      editingKey = false;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function commitAdd() {
    try {
      onaddchild(
        path,
        type === "object" ? addKey : null,
        coerceScalarInput(addValue),
      );
      adding = false;
      addKey = "";
      addValue = "";
      error = "";
      expanded = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function editKeydown(event: KeyboardEvent, commit: () => void, cancel: () => void) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      cancel();
    }
  }
</script>

<div class="node">
  <div
    class="row"
    role="treeitem"
    aria-selected="false"
    aria-expanded={isContainer ? expanded : undefined}
  >
    {#if isContainer}
      <button
        class="twisty"
        onclick={() => (expanded = !expanded)}
        aria-label={expanded ? "Collapse" : "Expand"}
      >
        {expanded ? "▾" : "▸"}
      </button>
    {:else}
      <span class="twisty leaf" aria-hidden="true">·</span>
    {/if}

    {#if label !== null}
      {#if editingKey}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="edit key-edit"
          bind:value={draftKey}
          autofocus
          onblur={commitKeyEdit}
          onkeydown={(e) => editKeydown(e, commitKeyEdit, () => (editingKey = false))}
          aria-label="Key name"
        />
      {:else}
        <button
          class="key"
          class:index={inArray}
          title={inArray ? undefined : "Double-click to rename"}
          ondblclick={startKeyEdit}
        >
          {label}
        </button>
      {/if}
      <span class="colon muted">:</span>
    {/if}

    {#if editingValue}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="edit"
        bind:value={draft}
        autofocus
        onblur={commitValueEdit}
        onkeydown={(e) => editKeydown(e, commitValueEdit, () => (editingValue = false))}
        aria-label="Value (JSON or plain text)"
      />
    {:else}
      <button
        class="value type-{type}"
        title={isContainer ? undefined : "Double-click to edit"}
        ondblclick={startValueEdit}
        onclick={() => isContainer && (expanded = !expanded)}
      >
        {preview}
      </button>
    {/if}

    <span class="badge muted">{type}</span>

    <span class="actions">
      {#if isContainer}
        <button
          class="mini"
          title="Add child"
          aria-label="Add child"
          onclick={() => {
            adding = !adding;
            error = "";
          }}
        >
          +
        </button>
      {/if}
      {#if label !== null}
        <button class="mini danger" title="Delete" aria-label="Delete" onclick={() => ondelete(path)}>
          ✕
        </button>
      {/if}
    </span>
  </div>

  {#if adding}
    <div class="add-row">
      {#if type === "object"}
        <input class="edit" placeholder="key" bind:value={addKey} aria-label="New key" />
      {/if}
      <input
        class="edit"
        placeholder={'value — JSON ("text", 42, true, {…}) or plain text'}
        bind:value={addValue}
        aria-label="New value"
        onkeydown={(e) => editKeydown(e, commitAdd, () => (adding = false))}
      />
      <button class="mini" onclick={commitAdd}>Add</button>
      <button class="mini" onclick={() => (adding = false)}>Cancel</button>
    </div>
  {/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if isContainer && expanded}
    <div class="children" role="group">
      {#each entries as [childKey, childValue] (String(childKey))}
        <TreeNode
          label={childKey}
          value={childValue}
          path={[...path, childKey]}
          depth={depth + 1}
          inArray={type === "array"}
          {onedit}
          {ondelete}
          {onrename}
          {onaddchild}
        />
      {/each}
      {#if entries.length === 0}
        <p class="muted empty">empty {type}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .node {
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 1px 4px;
    border-radius: 4px;
  }
  .row:hover {
    background: var(--surface-2);
  }
  .row:hover .actions {
    visibility: visible;
  }
  .twisty {
    border: none;
    background: transparent;
    padding: 0;
    width: 16px;
    color: var(--text-muted);
    font-size: 11px;
    flex: none;
  }
  .twisty.leaf {
    text-align: center;
    opacity: 0.4;
  }
  .key,
  .value {
    border: none;
    background: transparent;
    padding: 0 2px;
    font: inherit;
    border-radius: 3px;
    text-align: left;
  }
  .key {
    color: var(--accent);
    font-weight: 600;
  }
  .key.index {
    color: var(--text-muted);
    font-weight: 400;
  }
  .value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 48ch;
  }
  .type-string {
    color: var(--added-fg);
  }
  .type-number {
    color: #b45309;
  }
  :global([data-theme="dark"]) .type-number {
    color: #f2b96b;
  }
  .type-boolean,
  .type-null {
    color: var(--removed-fg);
  }
  .type-object,
  .type-array {
    color: var(--text-muted);
  }
  .badge {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .actions {
    visibility: hidden;
    display: inline-flex;
    gap: 2px;
  }
  .mini {
    padding: 0 6px;
    font-size: 11px;
    line-height: 18px;
    border-radius: 4px;
  }
  .mini.danger:hover:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger);
  }
  .edit {
    font: inherit;
    padding: 1px 6px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text);
    min-width: 40px;
  }
  .key-edit {
    max-width: 24ch;
  }
  .add-row {
    display: flex;
    gap: 6px;
    padding: 3px 4px 3px 24px;
  }
  .add-row .edit {
    flex: 1;
    max-width: 320px;
  }
  .children {
    margin-left: 11px;
    border-left: 1px solid var(--border);
    padding-left: 6px;
  }
  .empty {
    margin: 0;
    padding: 2px 12px;
    font-size: 11.5px;
  }
  .error {
    color: var(--danger);
    margin: 2px 4px 2px 24px;
    font-size: 11.5px;
  }
</style>
