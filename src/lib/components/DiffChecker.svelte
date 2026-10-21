<script lang="ts">
  import FilePanel from "./FilePanel.svelte";
  import DiffViewer from "./DiffViewer.svelte";
  import { getPlatform } from "../platform";
  import {
    computeDiff,
    defaultSelection,
    mergeSelected,
    diffStats,
    type DiffBlock,
    type Selection,
  } from "../core/diff";

  let leftText = $state("");
  let rightText = $state("");
  let leftName = $state("");
  let rightName = $state("");

  let blocks = $state<DiffBlock[]>([]);
  let selection = $state<Selection>({});
  let compared = $state(false);
  let saveMsg = $state("");

  const stats = $derived(compared ? diffStats(blocks) : null);
  const canCompare = $derived(leftText.length > 0 || rightText.length > 0);

  function compare() {
    saveMsg = "";
    try {
      blocks = computeDiff(leftText, rightText);
    } catch (e) {
      blocks = [];
      compared = false;
      saveMsg = e instanceof Error ? e.message : "Couldn't compare these files";
      return;
    }
    selection = defaultSelection(blocks);
    compared = true;
  }

  function acceptAll(side: "a" | "b") {
    const next: Selection = { ...selection };
    for (const b of blocks) if (b.type === "change") next[b.id] = side;
    selection = next;
  }

  async function saveMerged() {
    const merged = mergeSelected(blocks, selection);
    const name = (rightName || leftName || "merged.txt").replace(/\.[^.]*$/, "") + ".merged.txt";
    saveMsg = "";
    try {
      const ok = await getPlatform().saveTextFile(name, merged);
      saveMsg = ok ? "Merged file saved." : "Save cancelled.";
    } catch (e) {
      saveMsg = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<section>
  <p class="intro muted">
    Load or paste two versions of a file, review each difference, choose which side to keep,
    then export a merged result. All processing happens in memory.
  </p>

  <div class="inputs">
    <FilePanel label="Original (left)" bind:value={leftText} bind:fileName={leftName} />
    <FilePanel label="Modified (right)" bind:value={rightText} bind:fileName={rightName} />
  </div>

  <div class="bar">
    <button class="primary" onclick={compare} disabled={!canCompare}>Compare</button>
    {#if compared && stats}
      <span class="muted">
        {stats.changes} change{stats.changes === 1 ? "" : "s"}
        · <span style="color:var(--added-fg)">+{stats.added}</span>
        · <span style="color:var(--removed-fg)">-{stats.removed}</span>
      </span>
    {/if}
  </div>

  {#if compared}
    {#if stats && stats.changes === 0}
      <p class="empty muted">The two inputs are identical.</p>
    {:else}
      <div class="bulk">
        <span class="muted">Bulk:</span>
        <button onclick={() => acceptAll("b")}>Keep all modified</button>
        <button onclick={() => acceptAll("a")}>Keep all original</button>
      </div>
      <DiffViewer {blocks} bind:selection />
      <div class="bar">
        <button class="primary" onclick={saveMerged}>Save merged file…</button>
        {#if saveMsg}<span class="muted">{saveMsg}</span>{/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .intro {
    margin: 0 0 16px;
    max-width: 70ch;
  }
  .inputs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  @media (max-width: 820px) {
    .inputs {
      grid-template-columns: 1fr;
    }
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 14px 0;
  }
  .bulk {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .empty {
    padding: 16px 0;
  }
</style>
