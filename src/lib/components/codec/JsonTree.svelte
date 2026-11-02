<script lang="ts">
  import JsonTree from "./JsonTree.svelte";
  import type { JsonNode } from "../../core/codec/inspect";

  let { node, name = null, depth = 0 }: { node: JsonNode; name?: string | null; depth?: number } = $props();

  /** Children drawn per container; the rest are counted, not rendered. */
  const LIMIT = 500;

  const children = $derived<[string, JsonNode][]>(
    node.kind === "object"
      ? node.entries
      : node.kind === "array"
        ? node.items.map((item, index): [string, JsonNode] => [String(index), item])
        : [],
  );
  const count = $derived(children.length);
</script>

{#if node.kind === "object" || node.kind === "array"}
  <details open={depth < 2}>
    <summary>
      {#if name !== null}<span class="key">{name}</span><span class="punct">: </span>{/if}
      <span class="punct">{node.kind === "object" ? "{" : "["}</span>
      <span class="meta">{count} {node.kind === "object" ? (count === 1 ? "key" : "keys") : count === 1 ? "item" : "items"}</span>
      <span class="punct">{node.kind === "object" ? "}" : "]"}</span>
    </summary>
    <div class="children">
      {#each children.slice(0, LIMIT) as [key, child], index (index)}
        <JsonTree node={child} name={key} depth={depth + 1} />
      {/each}
      {#if count > LIMIT}<p class="meta more">… {count - LIMIT} more not shown</p>{/if}
    </div>
  </details>
{:else}
  <div class="leaf">
    {#if name !== null}<span class="key">{name}</span><span class="punct">: </span>{/if}
    {#if node.kind === "string"}<span class="string">"{node.value}"</span>
    {:else if node.kind === "number"}<span class="number">{node.raw}</span>
    {:else if node.kind === "boolean"}<span class="boolean">{node.value}</span>
    {:else}<span class="null">null</span>{/if}
  </div>
{/if}

<style>
  details,
  .leaf {
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.7;
  }
  summary {
    cursor: pointer;
    list-style: none;
    border-radius: 4px;
    padding: 0 4px;
    margin-left: -4px;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary::before {
    content: "▸";
    display: inline-block;
    width: 1.1em;
    color: var(--text-muted);
    transition: transform 0.12s ease;
  }
  details[open] > summary::before {
    transform: rotate(90deg);
  }
  summary:hover {
    background: var(--surface-2);
  }
  .children {
    margin-left: 0.55em;
    padding-left: 1em;
    border-left: 1px solid var(--border);
  }
  .leaf {
    padding-left: 1.1em;
    word-break: break-all;
  }
  .key {
    color: var(--accent);
    font-weight: 600;
  }
  .punct,
  .meta {
    color: var(--text-muted);
  }
  .meta {
    font-family: var(--sans);
    font-size: 11.5px;
    margin: 0 4px;
  }
  .more {
    margin: 2px 0;
  }
  .string {
    color: var(--added-fg);
  }
  .number {
    color: #d97706;
  }
  .boolean,
  .null {
    color: var(--removed-fg);
  }
</style>
