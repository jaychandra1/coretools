<script lang="ts">
  import { untrack } from "svelte";
  import { monaco, currentMonacoTheme } from "./monaco-setup";
  import { studioStore } from "./studio-store.svelte";
  import { diffJson, summarizeDiff } from "../../core/json-studio/json-diff";
  import { parseJson, formatJson } from "../../core/json-studio/parse";
  import type { DiffEntry } from "../../core/json-studio/types";

  let container: HTMLDivElement | undefined = $state();
  // $state so the two model-sync effects re-run once the editor exists.
  let diffEditor = $state<monaco.editor.IStandaloneDiffEditor | null>(null);
  let applyingExternal = false;

  // Left side: the working document (read-only mirror, pretty-printed when
  // valid so formatting noise never shows as a difference). Right side: the
  // comparison document, editable in place.
  const leftText = $derived.by(() => {
    const text = studioStore.docText;
    const parsed = parseJson(text);
    return parsed.ok ? JSON.stringify(parsed.value, null, 2) : text;
  });

  // Creation depends ONLY on the container. Both text sources are read
  // through untrack(): tracking them here would tear down and rebuild the
  // whole diff editor (both models, cursor, scroll, right-pane undo) on every
  // keystroke — and the seeding write below would make the effect invalidate
  // itself on mount. Text changes flow through the two sync effects below.
  $effect(() => {
    if (!container) return;

    const { original, modified } = untrack(() => {
      if (!studioStore.rightText) {
        // Seed the right side once so there's something to edit against.
        studioStore.rightText = leftText;
      }
      return {
        original: monaco.editor.createModel(leftText, "json"),
        modified: monaco.editor.createModel(studioStore.rightText, "json"),
      };
    });

    // LOCAL instance: reading the $state `diffEditor` back inside this effect
    // would make it self-dependent and loop, re-creating diff editors forever.
    const instance = monaco.editor.createDiffEditor(container, {
      theme: currentMonacoTheme(),
      automaticLayout: true,
      renderSideBySide: true,
      originalEditable: false,
      minimap: { enabled: false },
      fontSize: 12,
      scrollBeyondLastLine: false,
    });
    instance.setModel({ original, modified });

    const subscription = modified.onDidChangeContent(() => {
      if (applyingExternal) return;
      studioStore.rightText = modified.getValue();
      studioStore.onDocChanged();
    });

    diffEditor = instance;

    return () => {
      subscription.dispose();
      instance.dispose();
      original.dispose();
      modified.dispose();
      diffEditor = null;
    };
  });

  $effect(() => {
    const model = diffEditor?.getModel();
    if (model && model.original.getValue() !== leftText) {
      model.original.setValue(leftText);
    }
  });

  $effect(() => {
    const model = diffEditor?.getModel();
    const next = studioStore.rightText;
    if (model && model.modified.getValue() !== next) {
      applyingExternal = true;
      model.modified.setValue(next);
      applyingExternal = false;
    }
  });

  // Semantic diff of the two parsed documents.
  const semantic = $derived.by(():
    | { ok: true; entries: DiffEntry[] }
    | { ok: false; error: string } => {
    const left = parseJson(studioStore.docText);
    if (!left.ok) return { ok: false, error: `Left document: ${left.error.message}` };
    const right = parseJson(studioStore.rightText);
    if (!right.ok) return { ok: false, error: `Right document: ${right.error.message}` };
    return { ok: true, entries: diffJson(left.value, right.value) };
  });

  const summary = $derived(semantic.ok ? summarizeDiff(semantic.entries) : null);

  function short(value: unknown): string {
    const text = JSON.stringify(value);
    return text === undefined ? "" : text.length > 60 ? text.slice(0, 57) + "…" : text;
  }

  function formatRight() {
    try {
      studioStore.rightText = formatJson(studioStore.rightText, studioStore.indent);
      studioStore.onDocChanged();
    } catch {
      /* invalid right side; the message below already says so */
    }
  }

  function swapSides() {
    const left = studioStore.docText;
    studioStore.setDocText(studioStore.rightText);
    studioStore.rightText = left;
  }
</script>

<div class="diff-panel">
  <div class="bar">
    <span class="muted">
      Left: current document (read-only) · Right: paste or edit the version to compare
    </span>
    <span class="spacer"></span>
    <button onclick={formatRight}>Format right</button>
    <button onclick={swapSides} title="Make the right side the working document">⇄ Swap</button>
  </div>

  <div class="editors" bind:this={container}></div>

  <div class="semantic">
    {#if !semantic.ok}
      <p class="error" role="alert">{semantic.error}</p>
    {:else if summary?.identical}
      <p class="ok">✓ Structurally identical (formatting differences ignored)</p>
    {:else if summary}
      <p class="summary">
        <strong class="added">+{summary.added} added</strong> ·
        <strong class="removed">−{summary.removed} removed</strong> ·
        <strong class="changed">{summary.changed} changed</strong>
      </p>
      <ul>
        {#each semantic.entries.slice(0, 200) as entry (entry.path + entry.kind)}
          <li class={entry.kind}>
            <code class="path">{entry.path || "(root)"}</code>
            {#if entry.kind === "added"}
              <span class="muted">added:</span> <code>{short(entry.right)}</code>
            {:else if entry.kind === "removed"}
              <span class="muted">removed:</span> <code>{short(entry.left)}</code>
            {:else}
              <code>{short(entry.left)}</code> <span class="muted">→</span>
              <code>{short(entry.right)}</code>
            {/if}
          </li>
        {/each}
        {#if semantic.entries.length > 200}
          <li class="muted">…and {semantic.entries.length - 200} more</li>
        {/if}
      </ul>
    {/if}
  </div>
</div>

<style>
  .diff-panel {
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
  .editors {
    flex: 1;
    min-height: 220px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .semantic {
    max-height: 180px;
    overflow-y: auto;
    font-size: 12px;
  }
  .semantic ul {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .semantic li {
    padding: 3px 8px;
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .semantic li.added {
    background: var(--added-bg);
  }
  .semantic li.removed {
    background: var(--removed-bg);
  }
  .semantic li.changed {
    background: var(--accent-soft);
  }
  .path {
    font-weight: 600;
    margin-right: 6px;
  }
  .summary {
    margin: 0;
  }
  .added {
    color: var(--added-fg);
  }
  .removed {
    color: var(--removed-fg);
  }
  .changed {
    color: var(--accent);
  }
  .ok {
    color: var(--added-fg);
    margin: 0;
  }
  .error {
    color: var(--danger);
    margin: 0;
  }
</style>
