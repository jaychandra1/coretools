<script lang="ts">
  import { polish, type PolishMode } from "../core/polisher";

  const MODES: { id: PolishMode; label: string; hint: string }[] = [
    { id: "professional", label: "Professional", hint: "Formal, polished business English" },
    { id: "genz", label: "Gen Z", hint: "Casual, trendy phrasing" },
    { id: "complete", label: "Complete", hint: "Balanced, clear, fully fleshed out" },
  ];

  let input = $state("");
  let mode = $state<PolishMode>("professional");
  let output = $state("");
  let copied = $state(false);

  const canPolish = $derived(input.trim().length > 0);
  const activeHint = $derived(MODES.find((m) => m.id === mode)?.hint ?? "");

  function run() {
    output = polish(input, mode);
    copied = false;
  }

  function setMode(next: PolishMode) {
    mode = next;
    // Re-polish immediately when the style changes and output is visible.
    if (output) run();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    }
  }

  async function copy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      markCopied();
    } catch {
      // Fallback for webviews without async-clipboard permission.
      const ta = document.createElement("textarea");
      ta.value = output;
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

  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  function markCopied() {
    copied = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = false), 2200);
  }
</script>

<section>
  <p class="intro muted">
    Rewrite any sentence in the style you need. Everything runs locally —
    nothing you type ever leaves this app.
  </p>

  <label class="label" for="polish-input">Your sentence</label>
  <textarea
    id="polish-input"
    bind:value={input}
    rows={4}
    maxlength={600}
    placeholder="e.g. hey, i think the report is gonna be late but its really good stuff"
    spellcheck="false"
    onkeydown={onKeydown}
  ></textarea>

  <div class="controls">
    <div class="modes" role="radiogroup" aria-label="Rewrite style">
      {#each MODES as m (m.id)}
        <button
          type="button"
          role="radio"
          aria-checked={mode === m.id}
          class:active={mode === m.id}
          title={m.hint}
          onclick={() => setMode(m.id)}
        >
          {m.label}
        </button>
      {/each}
    </div>
    <button class="primary" onclick={run} disabled={!canPolish}>Polish</button>
  </div>
  <p class="hint muted">{activeHint} · Ctrl+Enter to polish</p>

  {#if output}
    <div class="output">
      <div class="output-head">
        <span class="label out-label">Polished</span>
        <button class="copy" class:copied onclick={copy}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <p class="output-text">{output}</p>
    </div>
  {/if}
</section>

<style>
  .intro {
    margin: 0 0 16px;
    max-width: 70ch;
  }
  .label {
    display: block;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  textarea {
    font-family: var(--sans);
    font-size: 14px;
  }
  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
    flex-wrap: wrap;
  }
  .modes {
    display: inline-flex;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px;
    gap: 2px;
  }
  .modes button {
    border: none;
    background: transparent;
    border-radius: 999px;
    padding: 6px 16px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .modes button:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .modes button.active {
    background: var(--accent);
    color: #fff;
  }
  .hint {
    font-size: 12px;
    margin: 8px 0 0;
  }
  .output {
    margin-top: 18px;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    padding: 14px 16px;
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .output-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .out-label {
    margin-bottom: 0;
    color: var(--accent);
  }
  .copy {
    font-size: 12px;
    padding: 5px 12px;
  }
  .copy.copied {
    border-color: var(--accent);
    color: var(--accent);
  }
  .output-text {
    margin: 10px 0 2px;
    font-size: 15px;
    line-height: 1.6;
  }
</style>
