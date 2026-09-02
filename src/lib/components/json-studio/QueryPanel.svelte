<script lang="ts">
  import { studioStore } from "./studio-store.svelte";
  import { runJmesPath, runJsonPath, type QueryOutcome } from "../../core/json-studio/query";
  import type { Result } from "../../core/json-studio/types";

  type Mode = "jsonpath" | "jmespath";
  let mode = $state<Mode>("jsonpath");
  let expression = $state("$..*");
  let copied = $state(false);

  const EXAMPLES: Record<Mode, Array<{ label: string; expr: string }>> = {
    jsonpath: [
      { label: "everything", expr: "$..*" },
      { label: "all keys of root", expr: "$.*" },
      { label: "filter", expr: "$..[?(@.price < 10)]" },
      { label: "slice", expr: "$..[0:2]" },
    ],
    jmespath: [
      { label: "keys of root", expr: "keys(@)" },
      { label: "projection", expr: "[]" },
      { label: "filter", expr: "[?price < `10`]" },
      { label: "shape", expr: "{count: length(@)}" },
    ],
  };

  const result = $derived.by((): Result<QueryOutcome> | { ok: false; error: string } => {
    void studioStore.docText;
    const value = studioStore.parsedValue();
    if (value === null) {
      return { ok: false, error: "The document is not valid JSON." };
    }
    return mode === "jsonpath"
      ? runJsonPath(value, expression)
      : runJmesPath(value, expression);
  });

  async function copyResults() {
    if (!result.ok) return;
    const payload =
      mode === "jsonpath"
        ? result.value.matches.map((m) => m.value)
        : result.value.single;
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).catch(() => {});
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  function preview(value: unknown): string {
    const text = JSON.stringify(value);
    return text === undefined ? "undefined" : text.length > 120 ? text.slice(0, 117) + "…" : text;
  }
</script>

<div class="query-panel">
  <div class="controls">
    <div class="mode" role="radiogroup" aria-label="Query language">
      <button class:active={mode === "jsonpath"} onclick={() => (mode = "jsonpath")}>
        JSONPath
      </button>
      <button class:active={mode === "jmespath"} onclick={() => (mode = "jmespath")}>
        JMESPath
      </button>
    </div>
    <input
      class="expr"
      bind:value={expression}
      placeholder={mode === "jsonpath" ? "$.store.book[?(@.price < 10)].title" : "store.book[?price < `10`].title"}
      spellcheck="false"
      aria-label="Query expression"
    />
  </div>

  <div class="examples muted">
    Try:
    {#each EXAMPLES[mode] as example (example.expr)}
      <button class="chip" onclick={() => (expression = example.expr)}>{example.label}</button>
    {/each}
  </div>

  {#if !result.ok}
    <p class="error" role="alert">{result.error}</p>
  {:else if mode === "jsonpath"}
    <div class="results-bar">
      <span class="muted">
        {result.value.matches.length}
        {result.value.matches.length === 1 ? "match" : "matches"}
      </span>
      <button onclick={copyResults} disabled={result.value.matches.length === 0}>
        {copied ? "Copied!" : "Copy values"}
      </button>
    </div>
    <ul class="results">
      {#each result.value.matches.slice(0, 500) as match, i (match.pointer + i)}
        <li>
          <code class="pointer">{match.pointer || "(root)"}</code>
          <code class="value">{preview(match.value)}</code>
        </li>
      {/each}
      {#if result.value.matches.length > 500}
        <li class="muted">…and {result.value.matches.length - 500} more</li>
      {/if}
    </ul>
  {:else}
    <div class="results-bar">
      <span class="muted">result</span>
      <button onclick={copyResults}>{copied ? "Copied!" : "Copy result"}</button>
    </div>
    <pre class="single">{JSON.stringify(result.value.single, null, 2)}</pre>
  {/if}
</div>

<style>
  .query-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
  .controls {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .mode {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .mode button {
    border: none;
    border-radius: 0;
    font-size: 12px;
    padding: 6px 12px;
  }
  .mode button.active {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .expr {
    flex: 1;
    min-width: 220px;
    font-family: var(--mono);
    font-size: 12.5px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  .expr:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .examples {
    font-size: 11.5px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .chip {
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 10px;
  }
  .results-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .results-bar button {
    font-size: 12px;
    padding: 4px 10px;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-height: 0;
  }
  .results li {
    display: flex;
    gap: 10px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    font-size: 11.5px;
    background: var(--surface);
  }
  .pointer {
    color: var(--accent);
    font-weight: 600;
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .single {
    flex: 1;
    overflow: auto;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    font-size: 12px;
    min-height: 0;
  }
  .error {
    color: var(--danger);
    font-size: 12.5px;
    margin: 0;
  }
</style>
