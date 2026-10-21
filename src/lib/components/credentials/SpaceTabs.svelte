<script lang="ts">
  import { Sortable } from "../../sortable.svelte";
  import SpaceDot from "./SpaceDot.svelte";

  /**
   * The space tabs ("" = All): a WAI-ARIA tablist. Arrow keys, Home and End
   * move between tabs; dragging a tab onto another moves it there (All stays
   * first). Manage spaces offers the same moves without a mouse.
   */
  let {
    tabs,
    active,
    count,
    onselect,
    onmove,
  }: {
    tabs: readonly string[];
    active: string;
    /** Logins on a tab. */
    count: (space: string) => number;
    onselect: (space: string) => void;
    /** `dragged` was dropped onto `target`: take its place. */
    onmove: (dragged: string, target: string) => void;
  } = $props();

  const sortable = new Sortable<string>((dragged, target) => onmove(dragged, target));

  function onkeydown(event: KeyboardEvent) {
    const at = tabs.indexOf(active);
    let next = at;
    if (event.key === "ArrowRight") next = (at + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    onselect(tabs[next]);
    const buttons = (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]');
    buttons[next]?.focus();
  }
</script>

<div class="space-tabs" role="tablist" aria-label="Spaces" tabindex="-1" {onkeydown}>
  {#each tabs as s (s)}
    {@const n = count(s)}
    <button
      role="tab"
      class="space-tab"
      class:on={active === s}
      class:dragging={sortable.dragged === s}
      class:drop-target={sortable.over === s}
      aria-selected={active === s}
      aria-label="{s || 'All'}, {n} {n === 1 ? 'login' : 'logins'}"
      tabindex={active === s ? 0 : -1}
      onclick={() => onselect(s)}
      {@attach sortable.item(s, s !== "")}
    >
      {#if s}<SpaceDot name={s} />{/if}
      <span class="space-name" title={s || undefined}>{s || "All"}</span>
      <span class="count" aria-hidden="true">{n}</span>
    </button>
  {/each}
</div>

<style>
  .space-tabs {
    display: flex;
    gap: 2px;
    min-width: 0;
    /* Many spaces scroll sideways; never a vertical scrollbar. */
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
  }
  @media (pointer: coarse) {
    /* Touch screens swipe the strip; a scrollbar would only add a grey bar. */
    .space-tabs {
      scrollbar-width: none;
    }
  }
  .space-tab {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: none;
    padding: 8px 12px;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  }
  .space-tab:hover {
    color: var(--text);
  }
  .space-tab.on {
    color: var(--text);
    font-weight: 600;
    border-bottom-color: var(--accent);
  }
  .space-tab.dragging {
    opacity: 0.45;
  }
  .space-tab.drop-target {
    background: var(--accent-soft);
    border-radius: 8px 8px 0 0;
  }
  .space-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .space-name {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    font-size: 11px;
    font-weight: 600;
    padding: 0 7px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-muted);
  }
  .space-tab.on .count {
    background: var(--accent-soft);
    color: var(--accent);
  }
</style>
