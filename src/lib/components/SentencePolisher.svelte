<script lang="ts">
  import { polish, type PolishMode } from "../core/polisher";
  import { checkGrammar, type GrammarIssue } from "../core/grammar";

  const MODES: { id: PolishMode; label: string; hint: string }[] = [
    { id: "professional", label: "Professional", hint: "Formal, polished business English" },
    { id: "genz", label: "Gen Z", hint: "Casual, trendy phrasing" },
    { id: "complete", label: "Complete", hint: "Balanced, clear, fully fleshed out" },
  ];

  let input = $state("");
  let mode = $state<PolishMode>("professional");
  let output = $state("");
  let issues = $state<GrammarIssue[]>([]);
  let checked = $state(false);
  let copied = $state(false);

  const canPolish = $derived(input.trim().length > 0);
  const activeHint = $derived(MODES.find((m) => m.id === mode)?.hint ?? "");

  function run() {
    // 1. Validate grammar first; 2. rewrite the corrected sentence.
    const grammar = checkGrammar(input);
    issues = grammar.issues;
    output = polish(grammar.corrected, mode);
    checked = Boolean(output);
    copied = false;
  }

  function setMode(next: PolishMode) {
    mode = next;
    // Re-polish immediately when the style changes and output is visible.
    if (checked) run();
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
    Check grammar and rewrite any sentence in the style you need. Everything
    runs locally — nothing you type ever leaves this app.
  </p>

  <label class="label" for="polish-input">Your sentence</label>
  <textarea
    id="polish-input"
    bind:value={input}
    rows={4}
    maxlength={600}
    placeholder="e.g. hey, i dont think the report is gonna be late becuase its really good stuff"
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
    <button class="primary" onclick={run} disabled={!canPolish}>Check &amp; Polish</button>
  </div>
  <p class="hint muted">{activeHint} · Ctrl+Enter to run</p>

  {#if checked}
    <div class="results">
      <div class="output">
        <div class="output-head">
          <span class="label out-label">Polished</span>
          <button class="copy" class:copied onclick={copy}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <p class="output-text">{output}</p>
      </div>

      <div class="grammar">
        <span class="label">
          Grammar check
          {#if issues.length}
            <span class="count">{issues.length} fix{issues.length === 1 ? "" : "es"}</span>
          {/if}
        </span>
        {#if issues.length}
          <ul class="issue-list">
            {#each issues as issue}
              <li>
                <code class="from">{issue.from}</code>
                <span class="arrow" aria-hidden="true">→</span>
                <code class="to">{issue.to}</code>
                <span class="reason muted">{issue.reason}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="clean">✓ No grammar issues detected.</p>
        {/if}
      </div>
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
  .results {
    display: grid;
    /* minmax(0, …) keeps long unbreakable content from widening the grid
       past the viewport. */
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
    gap: 16px;
    margin-top: 18px;
    animation: rise 0.3s ease;
  }
  @media (max-width: 820px) {
    .results {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .output,
  .grammar {
    min-width: 0;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .results {
      animation: none;
    }
  }
  .output {
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
    overflow-wrap: anywhere;
  }
  .grammar {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .count {
    display: inline-block;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 999px;
    padding: 1px 9px;
    margin-left: 6px;
    font-size: 11px;
    text-transform: none;
    letter-spacing: 0;
  }
  .issue-list {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: grid;
    gap: 8px;
    max-height: 260px;
    overflow: auto;
  }
  .issue-list li {
    font-size: 13px;
    line-height: 1.5;
  }
  .issue-list code {
    font-family: var(--mono);
    font-size: 12px;
    padding: 1px 6px;
    border-radius: 5px;
  }
  .from {
    background: var(--removed-bg);
    color: var(--removed-fg);
    text-decoration: line-through;
  }
  .to {
    background: var(--added-bg);
    color: var(--added-fg);
  }
  .arrow {
    color: var(--text-muted);
    margin: 0 2px;
  }
  .reason {
    font-size: 12px;
    margin-left: 6px;
  }
  .clean {
    margin: 10px 0 0;
    font-size: 13.5px;
    color: var(--added-fg);
  }
</style>
