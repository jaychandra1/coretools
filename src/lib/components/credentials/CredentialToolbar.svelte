<script lang="ts">
  import { CREATED_RANGES, type CredentialFilter } from "../../core/credentials/search";
  import Icon from "./Icon.svelte";

  /** Search (press / to focus), filters, the trash toggle and Add. */
  let {
    filter = $bindable(),
    trash = $bindable(),
    categories,
    owners,
    trashCount,
    onadd,
  }: {
    filter: CredentialFilter;
    /** Showing the trash instead of the logins. */
    trash: boolean;
    categories: readonly string[];
    owners: readonly string[];
    trashCount: number;
    onadd: () => void;
  } = $props();

  let searchInput: HTMLInputElement | undefined = $state();

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
    event.preventDefault();
    searchInput?.focus();
  }
</script>

<svelte:window {onkeydown} />

<div class="toolbar">
  <div class="search">
    <Icon name="search" />
    <input
      bind:this={searchInput}
      bind:value={filter.query}
      placeholder="Search platform, URL, username or #tag  (press /)"
      aria-label="Search credentials"
    />
    {#if filter.query}
      <button class="clear" onclick={() => (filter.query = "")} aria-label="Clear search">✕</button>
    {/if}
  </div>
  <select bind:value={filter.category} aria-label="Filter by category">
    <option value="">All categories</option>
    {#each categories as c (c)}<option value={c}>{c}</option>{/each}
  </select>
  <select bind:value={filter.owner} aria-label="Filter by owner">
    <option value="">All owners</option>
    {#each owners as o (o)}<option value={o}>{o}</option>{/each}
  </select>
  <select bind:value={filter.created} aria-label="Filter by creation date">
    {#each CREATED_RANGES as r (r.value)}<option value={r.value}>{r.label}</option>{/each}
  </select>
  <button class="ghost" class:active={trash} onclick={() => (trash = !trash)}>
    <Icon name="trash" /> Trash{trashCount ? ` (${trashCount})` : ""}
  </button>
  {#if !trash}
    <button class="primary" onclick={onadd}>+ Add credential</button>
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .search {
    flex: 1 1 260px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text-muted);
  }
  .search:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .search input,
  select {
    font-family: inherit;
    font-size: 13px;
    color: var(--text);
  }
  .search input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    padding: 8px 0;
    min-width: 0;
  }
  .search .clear {
    border: none;
    background: transparent;
    padding: 2px 4px;
    color: var(--text-muted);
    font-size: 12px;
  }
  select {
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    max-width: 180px;
  }
  .toolbar button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 8px;
  }
  .ghost {
    background: transparent;
  }
  .ghost.active {
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
</style>
