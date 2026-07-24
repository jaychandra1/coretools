<script lang="ts">
  import FilePanel from "./FilePanel.svelte";
  import { getPlatform } from "../platform";
  import { optimizeManifest, type OptimizeResult } from "../core/yaml-optimizer";

  let input = $state("");
  let fileName = $state("");
  let result = $state<OptimizeResult | null>(null);
  let saveMsg = $state("");
  let copied = $state(false);
  let stripAnnotations = $state(false);

  const canOptimize = $derived(input.trim().length > 0);

  function optimize() {
    result = optimizeManifest(input, { stripAnnotations });
    saveMsg = "";
    copied = false;
  }

  function toggleStripAnnotations() {
    // Re-optimize immediately when the option changes and output is visible.
    if (result) optimize();
  }

  async function download() {
    if (!result?.output) return;
    const name = (fileName || "manifest.yaml").replace(/\.(ya?ml)$/i, "") + ".optimized.yaml";
    saveMsg = "";
    try {
      const ok = await getPlatform().saveTextFile(name, result.output);
      saveMsg = ok ? "Optimized manifest saved." : "Save cancelled.";
    } catch (e) {
      saveMsg = e instanceof Error ? e.message : String(e);
    }
  }

  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    if (!result?.output) return;
    try {
      await navigator.clipboard.writeText(result.output);
      markCopied();
    } catch {
      // Fallback for webviews without async-clipboard permission.
      const ta = document.createElement("textarea");
      ta.value = result.output;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        markCopied();
      } finally {
        ta.remove();
      }
    }
  }

  function markCopied() {
    copied = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = false), 2200);
  }
</script>

<section>
  <p class="intro muted">
    Load or paste a Kubernetes manifest (single or multi-document). CoreTools validates it
    against the Kubernetes schema, fills in missing mandatory fields with sensible defaults,
    strips server-managed and redundant fields, and produces a clean, apply-ready result.
  </p>

  <FilePanel
    label="Kubernetes manifest"
    bind:value={input}
    bind:fileName
    placeholder="Paste YAML here, or load a .yaml file…"
    rows={16}
  />

  <div class="bar">
    <button class="primary" onclick={optimize} disabled={!canOptimize}>Optimize</button>
    <label
      class="option"
      title="Annotations are optional in the schema but often functional (observability injection, ingress behavior). Kept by default."
    >
      <input
        type="checkbox"
        bind:checked={stripAnnotations}
        onchange={toggleStripAnnotations}
      />
      Strip annotations
    </label>
    {#if result}
      <span class="muted">
        {result.documents} document{result.documents === 1 ? "" : "s"}
        · {result.changes.length} change{result.changes.length === 1 ? "" : "s"} applied
      </span>
    {/if}
  </div>

  {#if result}
    {#if result.errors.length}
      <div class="errors">
        <strong>Validation issues</strong>
        <ul>
          {#each result.errors as e}<li>{e}</li>{/each}
        </ul>
      </div>
    {/if}

    {#if result.output}
      <div class="results">
        <div class="output">
          <div class="head">
            <span class="label">Optimized manifest</span>
            <div class="actions">
              <button class="copy-btn" class:copied onclick={copy}>
                {copied ? "Copied ✓" : "Copy"}
              </button>
              <button class="primary" onclick={download}>Download…</button>
            </div>
          </div>
          <pre class="mono code">{result.output}</pre>
          {#if saveMsg}<p class="muted save">{saveMsg}</p>{/if}
        </div>

        <div class="changelog">
          <span class="label">Changes applied</span>
          {#if result.changes.length}
            <ul>
              {#each result.changes as c}
                <li>
                  <span class="badge {c.action}">{c.action}</span>
                  <code>{c.path}</code>
                  <span class="reason muted">— {c.reason}</span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="muted">Nothing to change — the manifest was already clean.</p>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .intro {
    margin: 0 0 16px;
    max-width: 74ch;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 14px 0;
    flex-wrap: wrap;
  }
  .option {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }
  .option:hover {
    color: var(--text);
  }
  .option input {
    width: 15px;
    height: 15px;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .errors {
    border: 1px solid var(--danger);
    background: var(--removed-bg);
    color: var(--removed-fg);
    border-radius: var(--radius);
    padding: 10px 14px;
    margin-bottom: 14px;
    font-size: 13px;
  }
  .errors ul {
    margin: 6px 0 0;
    padding-left: 20px;
  }
  .results {
    display: grid;
    /* minmax(0, …) lets long unbreakable content (wide YAML lines) scroll
       inside the column instead of blowing the grid past the viewport. */
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    gap: 16px;
  }
  @media (max-width: 900px) {
    .results {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .output,
  .changelog {
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .label {
    font-weight: 600;
  }
  .code {
    margin: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
    overflow: auto;
    max-height: 52vh;
    font-size: 12.5px;
    white-space: pre;
  }
  .save {
    margin: 6px 0 0;
    font-size: 12px;
  }
  .changelog ul {
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
    max-height: 52vh;
    overflow: auto;
    font-size: 12.5px;
  }
  .changelog li {
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
    word-break: break-all;
  }
  .changelog code {
    font-family: var(--mono);
    color: var(--text);
  }
  .reason {
    font-family: var(--sans);
  }
  .badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    border-radius: 4px;
    padding: 1px 6px;
    margin-right: 6px;
  }
  .badge.removed {
    background: var(--removed-bg);
    color: var(--removed-fg);
  }
  .badge.added {
    background: var(--added-bg);
    color: var(--added-fg);
  }
  .badge.renamed {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .copy-btn {
    font-size: 12px;
    padding: 6px 12px;
  }
  .copy-btn.copied {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
