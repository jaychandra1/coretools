<script lang="ts">
  import type { DiffBlock, Selection } from "../core/diff";

  interface Props {
    blocks: DiffBlock[];
    selection: Selection;
  }

  let { blocks, selection = $bindable() }: Props = $props();

  function choose(id: number, side: "a" | "b") {
    selection = { ...selection, [id]: side };
  }
</script>

<div class="viewer mono">
  {#each blocks as block, i (i)}
    {#if block.type === "equal"}
      {#each block.lines as line}
        <div class="row equal"><span class="gutter"> </span><span class="text">{line || " "}</span></div>
      {/each}
    {:else}
      <div class="change" class:kept-a={selection[block.id] === "a"} class:kept-b={selection[block.id] !== "a"}>
        <div class="change-head">
          <span class="tag">Change #{block.id + 1}</span>
          <div class="toggle" role="group" aria-label="Keep which version">
            <button
              class:active={selection[block.id] === "a"}
              onclick={() => choose(block.id, "a")}
              title="Keep the original (left) version"
            >Keep original</button>
            <button
              class:active={selection[block.id] !== "a"}
              onclick={() => choose(block.id, "b")}
              title="Keep the modified (right) version"
            >Keep modified</button>
          </div>
        </div>
        {#each block.aLines as line}
          <div class="row removed"><span class="gutter">-</span><span class="text">{line || " "}</span></div>
        {/each}
        {#each block.bLines as line}
          <div class="row added"><span class="gutter">+</span><span class="text">{line || " "}</span></div>
        {/each}
      </div>
    {/if}
  {/each}
</div>

<style>
  .viewer {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: auto;
    font-size: 12.5px;
    max-height: 52vh;
  }
  .row {
    display: flex;
    white-space: pre;
  }
  .gutter {
    width: 24px;
    flex: none;
    text-align: center;
    color: var(--text-muted);
    user-select: none;
    border-right: 1px solid var(--border);
  }
  .text {
    padding: 0 10px;
    flex: 1;
    min-width: 0;
  }
  .equal {
    color: var(--text-muted);
  }
  .removed {
    background: var(--removed-bg);
    color: var(--removed-fg);
  }
  .added {
    background: var(--added-bg);
    color: var(--added-fg);
  }
  .change {
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .change.kept-a .added {
    opacity: 0.4;
    text-decoration: line-through;
  }
  .change.kept-b .removed {
    opacity: 0.4;
    text-decoration: line-through;
  }
  .change-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 10px;
    background: var(--surface-2);
    font-family: var(--sans);
  }
  .tag {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .toggle {
    display: flex;
    gap: 0;
  }
  .toggle button {
    padding: 3px 10px;
    font-size: 11.5px;
    border-radius: 0;
    border-right: none;
  }
  .toggle button:first-child {
    border-radius: 6px 0 0 6px;
  }
  .toggle button:last-child {
    border-radius: 0 6px 6px 0;
    border-right: 1px solid var(--border);
  }
  .toggle button.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
</style>
