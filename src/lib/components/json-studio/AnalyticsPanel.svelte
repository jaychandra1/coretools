<script lang="ts">
  import { studioStore } from "./studio-store.svelte";
  import { statsForText } from "../../core/json-studio/worker/client";
  import { utf8Size } from "../../core/json-studio/parse";
  import type { JsonStats } from "../../core/json-studio/stats";

  let stats = $state<JsonStats | null>(null);
  let error = $state("");
  let pending = $state(true);

  // Recompute (debounced) when the document changes; large docs go to the worker.
  $effect(() => {
    const text = studioStore.docText;
    pending = true;
    const timer = setTimeout(async () => {
      try {
        stats = await statsForText(text);
        error = "";
      } catch (e) {
        stats = null;
        error = e instanceof Error ? e.message : String(e);
      } finally {
        pending = false;
      }
    }, 300);
    return () => clearTimeout(timer);
  });

  const byteSize = $derived(utf8Size(studioStore.docText));

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  // Bars: magnitude comparison -> one hue; identity lives in the row labels.
  interface Bar {
    label: string;
    value: number;
  }
  const typeBars = $derived.by((): Bar[] =>
    stats
      ? (Object.entries(stats.types) as Array<[string, number]>)
          .filter(([, count]) => count > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([label, value]) => ({ label, value }))
      : [],
  );
  const depthBars = $derived.by((): Bar[] =>
    stats
      ? stats.depthHistogram.map((count, i) => ({ label: `${i + 1}`, value: count ?? 0 }))
      : [],
  );
  const keyBars = $derived.by((): Bar[] =>
    stats ? stats.topKeys.map((k) => ({ label: k.key, value: k.count })) : [],
  );

  function widthPct(value: number, bars: Bar[]): number {
    const max = Math.max(...bars.map((b) => b.value), 1);
    return Math.max((value / max) * 100, 0.5);
  }
</script>

<div class="analytics-panel">
  {#if error}
    <p class="error" role="alert">The document is not valid JSON: {error}</p>
  {:else if !stats}
    <p class="muted">Analyzing…</p>
  {:else}
    <div class="tiles" class:pending>
      <div class="tile">
        <span class="tile-value">{stats.nodes.toLocaleString()}</span>
        <span class="tile-label muted">nodes</span>
      </div>
      <div class="tile">
        <span class="tile-value">{stats.maxDepth}</span>
        <span class="tile-label muted">max depth</span>
      </div>
      <div class="tile">
        <span class="tile-value">{stats.totalKeys.toLocaleString()}</span>
        <span class="tile-label muted">keys ({stats.distinctKeys.toLocaleString()} distinct)</span>
      </div>
      <div class="tile">
        <span class="tile-value">{formatBytes(byteSize)}</span>
        <span class="tile-label muted">document size</span>
      </div>
    </div>

    <div class="charts" class:pending>
      <figure>
        <figcaption>Nodes by type</figcaption>
        <div class="bars" role="img" aria-label="Node count per JSON type">
          {#each typeBars as bar (bar.label)}
            <div class="bar-row" title="{bar.label}: {bar.value.toLocaleString()} nodes">
              <span class="bar-label">{bar.label}</span>
              <span class="bar-track">
                <span class="bar-fill" style="width: {widthPct(bar.value, typeBars)}%"></span>
              </span>
              <span class="bar-value muted">{bar.value.toLocaleString()}</span>
            </div>
          {/each}
        </div>
      </figure>

      <figure>
        <figcaption>Nodes by depth</figcaption>
        <div class="bars" role="img" aria-label="Node count per nesting depth">
          {#each depthBars.slice(0, 16) as bar (bar.label)}
            <div class="bar-row" title="depth {bar.label}: {bar.value.toLocaleString()} nodes">
              <span class="bar-label">{bar.label}</span>
              <span class="bar-track">
                <span class="bar-fill" style="width: {widthPct(bar.value, depthBars)}%"></span>
              </span>
              <span class="bar-value muted">{bar.value.toLocaleString()}</span>
            </div>
          {/each}
          {#if depthBars.length > 16}
            <p class="muted small">…levels beyond 16 not shown ({depthBars.length} total)</p>
          {/if}
        </div>
      </figure>

      {#if keyBars.length > 0}
        <figure class="wide">
          <figcaption>Most frequent keys</figcaption>
          <div class="bars" role="img" aria-label="Occurrences of the most frequent object keys">
            {#each keyBars as bar (bar.label)}
              <div class="bar-row" title="{bar.label}: ×{bar.value.toLocaleString()}">
                <span class="bar-label key">{bar.label}</span>
                <span class="bar-track">
                  <span class="bar-fill" style="width: {widthPct(bar.value, keyBars)}%"></span>
                </span>
                <span class="bar-value muted">×{bar.value.toLocaleString()}</span>
              </div>
            {/each}
          </div>
        </figure>
      {/if}
    </div>

    <div class="details muted" class:pending>
      <span>
        arrays: {stats.arrays.count.toLocaleString()} (longest {stats.arrays.maxLength.toLocaleString()},
        {stats.arrays.totalItems.toLocaleString()} items total)
      </span>
      <span>
        strings: {stats.strings.count.toLocaleString()} (longest {stats.strings.maxLength.toLocaleString()} chars)
      </span>
      <span>
        numbers: {stats.numbers.count.toLocaleString()}
        {#if stats.numbers.count > 0}
          ({stats.numbers.integers.toLocaleString()} integers, range
          {stats.numbers.min?.toLocaleString()}…{stats.numbers.max?.toLocaleString()})
        {/if}
      </span>
    </div>
  {/if}
</div>

<style>
  .analytics-panel {
    height: 100%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
  }
  .pending {
    opacity: 0.6;
    transition: opacity 0.15s ease;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 10px;
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tile-value {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums;
  }
  .tile-label {
    font-size: 11.5px;
  }
  .charts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 14px;
  }
  figure {
    margin: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
  }
  figure.wide {
    grid-column: 1 / -1;
  }
  figcaption {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 10px;
  }
  .bars {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .bar-row {
    display: grid;
    grid-template-columns: minmax(52px, auto) 1fr minmax(40px, auto);
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
  }
  .bar-row:hover .bar-fill {
    background: var(--accent-hover);
  }
  .bar-label {
    text-align: right;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 140px;
  }
  .bar-label.key {
    font-family: var(--mono);
  }
  .bar-track {
    display: block;
    height: 12px;
  }
  .bar-fill {
    display: block;
    height: 100%;
    min-width: 2px;
    background: var(--accent);
    border-radius: 0 4px 4px 0;
  }
  .bar-value {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .details {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    font-size: 11.5px;
  }
  .small {
    font-size: 11px;
    margin: 2px 0 0;
  }
  .error {
    color: var(--danger);
    font-size: 12.5px;
  }
</style>
