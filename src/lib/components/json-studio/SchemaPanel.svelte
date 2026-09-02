<script lang="ts">
  import MonacoEditor from "./MonacoEditor.svelte";
  import { studioStore } from "./studio-store.svelte";
  import { validateAgainstSchema } from "../../core/json-studio/validate";
  import { inferSchemaForText } from "../../core/json-studio/worker/client";
  import type { ValidationMessage } from "../../core/json-studio/types";

  let busy = $state(false);
  let generateError = $state("");

  type Verdict =
    | { state: "empty" }
    | { state: "error"; error: string }
    | { state: "done"; valid: boolean; messages: ValidationMessage[] };

  // Debounced re-validation whenever either text changes.
  let verdict = $state<Verdict>({ state: "empty" });
  $effect(() => {
    const schemaText = studioStore.schemaText;
    const docText = studioStore.docText;
    if (schemaText.trim() === "") {
      verdict = { state: "empty" };
      return;
    }
    const timer = setTimeout(() => {
      const result = validateAgainstSchema(schemaText, docText);
      verdict = result.ok
        ? { state: "done", valid: result.value.valid, messages: result.value.messages }
        : { state: "error", error: result.error };
    }, 300);
    return () => clearTimeout(timer);
  });

  async function generateFromDocument() {
    busy = true;
    generateError = "";
    try {
      studioStore.schemaText = await inferSchemaForText(studioStore.docText);
      studioStore.onDocChanged();
    } catch (e) {
      generateError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="schema-panel">
  <div class="bar">
    <span class="muted">
      JSON Schema (drafts 4 / 7 / 2019-09 / 2020-12, auto-detected from $schema)
    </span>
    <span class="spacer"></span>
    <button onclick={generateFromDocument} disabled={busy}>
      {busy ? "Generating…" : "Generate from document"}
    </button>
  </div>

  <div class="editor-wrap">
    <MonacoEditor
      bind:value={
        () => studioStore.schemaText,
        (v) => {
          studioStore.schemaText = v;
          studioStore.onDocChanged();
        }
      }
      ariaLabel="JSON Schema editor"
    />
  </div>

  <div class="verdict">
    {#if generateError}
      <p class="error" role="alert">{generateError}</p>
    {/if}
    {#if verdict.state === "empty"}
      <p class="muted">
        Paste a schema above — or generate one from the current document — and
        the document is validated live as either side changes.
      </p>
    {:else if verdict.state === "error"}
      <p class="error" role="alert">{verdict.error}</p>
    {:else if verdict.valid}
      <p class="ok">✓ Document conforms to the schema</p>
    {:else}
      <p class="fail">
        ✗ {verdict.messages.length}
        {verdict.messages.length === 1 ? "violation" : "violations"}
      </p>
      <ul>
        {#each verdict.messages.slice(0, 100) as message, i (message.path + message.keyword + i)}
          <li>
            <code class="path">{message.path || "(root)"}</code>
            <span>{message.message}</span>
            <span class="keyword muted">{message.keyword}</span>
          </li>
        {/each}
        {#if verdict.messages.length > 100}
          <li class="muted">…and {verdict.messages.length - 100} more</li>
        {/if}
      </ul>
    {/if}
  </div>
</div>

<style>
  .schema-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    flex-wrap: wrap;
  }
  .spacer {
    flex: 1;
  }
  .bar button {
    font-size: 12px;
    padding: 4px 10px;
  }
  .editor-wrap {
    flex: 1;
    min-height: 180px;
  }
  .verdict {
    max-height: 200px;
    overflow-y: auto;
    font-size: 12.5px;
  }
  .verdict p {
    margin: 0 0 6px;
  }
  .ok {
    color: var(--added-fg);
    font-weight: 600;
  }
  .fail {
    color: var(--removed-fg);
    font-weight: 600;
  }
  .error {
    color: var(--danger);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--removed-bg);
    font-size: 11.5px;
  }
  .path {
    font-family: var(--mono);
    font-weight: 600;
    color: var(--removed-fg);
    flex: none;
  }
  .keyword {
    margin-left: auto;
    font-size: 10.5px;
    text-transform: uppercase;
  }
</style>
