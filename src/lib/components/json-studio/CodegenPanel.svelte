<script lang="ts">
  import { studioStore } from "./studio-store.svelte";
  import {
    CODEGEN_LANGUAGES,
    generateCode,
    type CodegenLanguage,
  } from "../../core/json-studio/codegen/emitters";
  import { getPlatform } from "../../platform";

  const platform = getPlatform();

  let language = $state<CodegenLanguage>("typescript");
  let rootName = $state("Root");
  let copied = $state(false);

  const EXTENSIONS: Record<CodegenLanguage, string> = {
    typescript: "ts",
    csharp: "cs",
    java: "java",
    python: "py",
    go: "go",
  };

  const output = $derived.by((): { ok: true; code: string } | { ok: false; error: string } => {
    void studioStore.docText;
    const value = studioStore.parsedValue();
    if (value === null) return { ok: false, error: "The document is not valid JSON." };
    try {
      return {
        ok: true,
        code: generateCode(value, language, rootName.trim() || "Root"),
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  async function copy() {
    if (!output.ok) return;
    await navigator.clipboard.writeText(output.code).catch(() => {});
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  async function save() {
    if (!output.ok) return;
    await platform.saveTextFile(
      `${(rootName.trim() || "Root").toLowerCase()}.${EXTENSIONS[language]}`,
      output.code,
    );
  }
</script>

<div class="codegen-panel">
  <div class="controls">
    <div class="langs" role="radiogroup" aria-label="Target language">
      {#each CODEGEN_LANGUAGES as lang (lang.id)}
        <button class:active={language === lang.id} onclick={() => (language = lang.id)}>
          {lang.label}
        </button>
      {/each}
    </div>
    <label class="root-name">
      Root type
      <input bind:value={rootName} placeholder="Root" spellcheck="false" aria-label="Root type name" />
    </label>
  </div>

  {#if output.ok}
    <pre class="code">{output.code}</pre>
    <div class="actions">
      <button onclick={copy}>{copied ? "Copied!" : "Copy"}</button>
      <button class="primary" onclick={save}>Save file…</button>
    </div>
  {:else}
    <p class="error" role="alert">{output.error}</p>
  {/if}

  <p class="hint muted">
    Types are inferred from this one example: array elements are merged (keys
    missing from some elements become optional), mixed types become unions,
    and original JSON keys are preserved via each language's serialization
    attributes.
  </p>
</div>

<style>
  .codegen-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }
  .controls {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .langs {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .langs button {
    border: none;
    border-radius: 0;
    font-size: 12px;
    padding: 6px 12px;
  }
  .langs button.active {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .root-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .root-name input {
    width: 130px;
    font-family: var(--mono);
    font-size: 12px;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  .code {
    flex: 1;
    overflow: auto;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    font-size: 11.5px;
    min-height: 160px;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .hint {
    font-size: 11.5px;
    margin: 0;
  }
  .error {
    color: var(--danger);
    font-size: 12.5px;
  }
</style>
