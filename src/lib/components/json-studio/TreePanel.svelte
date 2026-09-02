<script lang="ts">
  import TreeNode from "./TreeNode.svelte";
  import { studioStore } from "./studio-store.svelte";
  import {
    deleteAtPath,
    insertChild,
    renameKey,
    setAtPath,
  } from "../../core/json-studio/tree-edit";
  import type { JsonPathSegments, JsonValue } from "../../core/json-studio/types";

  let error = $state("");

  // Tree edits rebuild the document text; the memoized parse keeps this cheap.
  const parsed = $derived.by(() => {
    void studioStore.docText;
    return studioStore.parsed();
  });

  function apply(mutate: (root: JsonValue) => JsonValue) {
    error = "";
    const current = studioStore.parsedValue();
    if (current === null) return;
    try {
      studioStore.setFromValue(mutate(current));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function onEdit(path: JsonPathSegments, value: JsonValue) {
    apply((root) => setAtPath(root, path, value));
  }
  function onDelete(path: JsonPathSegments) {
    apply((root) => deleteAtPath(root, path));
  }
  function onRename(parentPath: JsonPathSegments, oldKey: string, newKey: string) {
    // renameKey throws synchronously for duplicate keys; let TreeNode show it.
    const current = studioStore.parsedValue();
    if (current === null) return;
    studioStore.setFromValue(renameKey(current, parentPath, oldKey, newKey));
  }
  function onAddChild(path: JsonPathSegments, key: string | null, value: JsonValue) {
    const current = studioStore.parsedValue();
    if (current === null) return;
    studioStore.setFromValue(
      insertChild(current, path, value, key === null ? {} : { key }),
    );
  }
</script>

<div class="tree-panel">
  {#if parsed.ok}
    <p class="hint muted">
      Double-click a value or key to edit · hover a row for add/delete ·
      unquoted input becomes a string, valid JSON is taken as typed.
    </p>
    <div class="tree" role="tree">
      <TreeNode
        label={null}
        value={parsed.value}
        path={[]}
        depth={0}
        inArray={false}
        onedit={onEdit}
        ondelete={onDelete}
        onrename={onRename}
        onaddchild={onAddChild}
      />
    </div>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  {:else}
    <p class="error" role="alert">
      The document is not valid JSON (line {parsed.error.line}: {parsed.error.message}).
      Fix it in the editor — or run <strong>Repair</strong> — to use the tree.
    </p>
  {/if}
</div>

<style>
  .tree-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .hint {
    font-size: 11.5px;
    margin: 0 0 8px;
  }
  .tree {
    flex: 1;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px;
    background: var(--surface);
    min-height: 0;
  }
  .error {
    color: var(--danger);
    font-size: 12.5px;
    margin: 10px 0 0;
  }
</style>
