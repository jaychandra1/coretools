<script lang="ts">
  import MonacoEditor from "./MonacoEditor.svelte";
  import TreePanel from "./TreePanel.svelte";
  import DiffPanel from "./DiffPanel.svelte";
  import QueryPanel from "./QueryPanel.svelte";
  import SchemaPanel from "./SchemaPanel.svelte";
  import OpenApiPanel from "./OpenApiPanel.svelte";
  import ConvertPanel from "./ConvertPanel.svelte";
  import CodegenPanel from "./CodegenPanel.svelte";
  import AnalyticsPanel from "./AnalyticsPanel.svelte";
  import { watchAppTheme, type EditorMarker } from "./monaco-setup";
  import { studioStore, STUDIO_TOOLS } from "./studio-store.svelte";
  import { formatText, minifyText, sortKeysText } from "../../core/json-studio/worker/client";
  import { repairJson } from "../../core/json-studio/repair";
  import { utf8Size } from "../../core/json-studio/parse";
  import { getPlatform } from "../../platform";

  const platform = getPlatform();

  let toast = $state("");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let editorRef: MonacoEditor | undefined = $state();
  let shortcutsOpen = $state(false);

  function showToast(message: string) {
    toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 2200);
  }

  $effect(() => {
    studioStore.init();
    return watchAppTheme();
  });

  // ---- editor actions -------------------------------------------------------

  async function doFormat() {
    try {
      studioStore.setDocText(await formatText(studioStore.docText, studioStore.indent));
      showToast("Formatted");
    } catch (e) {
      showToast(`Cannot format: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function doMinify() {
    try {
      studioStore.setDocText(await minifyText(studioStore.docText));
      showToast("Minified");
    } catch (e) {
      showToast(`Cannot minify: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function doSortKeys() {
    try {
      studioStore.setDocText(await sortKeysText(studioStore.docText, studioStore.indent));
      showToast("Keys sorted");
    } catch (e) {
      showToast(`Cannot sort: ${e instanceof Error ? e.message : e}`);
    }
  }

  function doRepair() {
    const result = repairJson(studioStore.docText);
    if (!result.ok) {
      showToast(result.error);
    } else if (result.value.alreadyValid) {
      showToast("Already valid — nothing to repair");
    } else {
      studioStore.setDocText(result.value.repaired);
      showToast("Repaired ✓");
    }
  }

  async function openFile() {
    const file = await platform.openTextFile();
    if (!file) return;
    studioStore.setDocText(file.content);
    showToast(`Loaded ${file.name}`);
  }

  async function saveFile() {
    const saved = await platform.saveTextFile("document.json", studioStore.docText);
    if (saved) showToast("Saved");
  }

  // ---- keyboard shortcuts ---------------------------------------------------

  const SHORTCUTS: Array<{ keys: string; action: string }> = [
    { keys: "Ctrl+Shift+F", action: "Format document" },
    { keys: "Ctrl+Shift+M", action: "Minify document" },
    { keys: "Ctrl+Shift+R", action: "Repair JSON" },
    { keys: "Ctrl+Shift+S", action: "Sort keys" },
    { keys: "Alt+1 … Alt+9", action: "Switch tool tab" },
    { keys: "Ctrl+F (in editor)", action: "Find / replace (Monaco)" },
    { keys: "Ctrl+Z / Ctrl+Y (in editor)", action: "Undo / redo" },
  ];

  function onKeydown(event: KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === "f") {
        event.preventDefault();
        doFormat();
      } else if (key === "m") {
        event.preventDefault();
        doMinify();
      } else if (key === "r") {
        event.preventDefault();
        doRepair();
      } else if (key === "s") {
        event.preventDefault();
        doSortKeys();
      }
      return;
    }
    if (event.altKey && !mod) {
      const index = Number(event.key) - 1;
      if (index >= 0 && index < STUDIO_TOOLS.length) {
        event.preventDefault();
        studioStore.tool = STUDIO_TOOLS[index].id;
      }
    }
  }

  // ---- syntax status → editor markers ---------------------------------------

  const markers = $derived.by((): EditorMarker[] => {
    const syntax = studioStore.syntax;
    if (syntax.state !== "invalid") return [];
    return [
      {
        message: syntax.error.message,
        line: syntax.error.line,
        column: Math.max(1, syntax.error.column),
        severity: "error",
      },
    ];
  });

  const sizeLabel = $derived.by(() => {
    const bytes = utf8Size(studioStore.docText);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  });

  /** Tools that render beside the main editor (vs. replacing it). */
  const sideBySide = $derived(
    studioStore.tool !== "editor" &&
      studioStore.tool !== "tree" &&
      studioStore.tool !== "diff" &&
      studioStore.tool !== "analytics",
  );
</script>

<svelte:window onkeydown={onKeydown} />

<div class="studio">
  {#if studioStore.restoreOffer}
    <div class="banner" role="status">
      <span>
        A previous session from
        {new Date(studioStore.restoreOffer.updatedAt).toLocaleString()} can be
        restored.
      </span>
      <button class="primary" onclick={() => studioStore.restoreSession()}>Restore</button>
      <button onclick={() => studioStore.discardSession()}>Discard</button>
    </div>
  {/if}

  <div class="toolbar">
    <nav class="tools" aria-label="Studio tools">
      {#each STUDIO_TOOLS as toolDef, i (toolDef.id)}
        <button
          class:active={studioStore.tool === toolDef.id}
          title="Alt+{i + 1}"
          onclick={() => {
            studioStore.tool = toolDef.id;
            studioStore.onDocChanged();
          }}
        >
          {toolDef.label}
        </button>
      {/each}
    </nav>
    <span class="spacer"></span>
    <div class="actions">
      <button onclick={doFormat} title="Ctrl+Shift+F">Format</button>
      <button onclick={doMinify} title="Ctrl+Shift+M">Minify</button>
      <button onclick={doSortKeys} title="Ctrl+Shift+S">Sort keys</button>
      <button onclick={doRepair} title="Ctrl+Shift+R">Repair</button>
      <select
        aria-label="Indentation"
        value={String(studioStore.indent)}
        onchange={(e) => {
          const v = e.currentTarget.value;
          studioStore.indent = v === "\t" ? "\t" : (Number(v) as 2 | 4);
        }}
      >
        <option value="2">2 spaces</option>
        <option value="4">4 spaces</option>
        <option value={"\t"}>tabs</option>
      </select>
      <button onclick={openFile}>Open…</button>
      <button onclick={saveFile}>Save…</button>
      <button
        class="help"
        title="Keyboard shortcuts"
        aria-label="Keyboard shortcuts"
        onclick={() => (shortcutsOpen = !shortcutsOpen)}
      >
        ?
      </button>
    </div>
  </div>

  {#if shortcutsOpen}
    <div class="shortcuts" role="dialog" aria-label="Keyboard shortcuts">
      <table>
        <tbody>
          {#each SHORTCUTS as shortcut (shortcut.keys)}
            <tr>
              <td><kbd>{shortcut.keys}</kbd></td>
              <td class="muted">{shortcut.action}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="workspace" class:split={sideBySide}>
    {#if studioStore.tool === "tree"}
      <TreePanel />
    {:else if studioStore.tool === "diff"}
      <DiffPanel />
    {:else if studioStore.tool === "analytics"}
      <AnalyticsPanel />
    {:else}
      <div class="editor-pane">
        <MonacoEditor
          bind:this={editorRef}
          bind:value={
            () => studioStore.docText,
            (v) => studioStore.setDocText(v)
          }
          {markers}
          ariaLabel="JSON document editor"
        />
      </div>
      {#if sideBySide}
        <div class="side-pane">
          {#if studioStore.tool === "query"}
            <QueryPanel />
          {:else if studioStore.tool === "schema"}
            <SchemaPanel />
          {:else if studioStore.tool === "openapi"}
            <OpenApiPanel />
          {:else if studioStore.tool === "convert"}
            <ConvertPanel />
          {:else if studioStore.tool === "codegen"}
            <CodegenPanel />
          {/if}
        </div>
      {/if}
    {/if}
  </div>

  <div class="status-bar">
    {#if studioStore.syntax.state === "valid"}
      <span class="status ok">✓ valid JSON</span>
    {:else if studioStore.syntax.state === "invalid"}
      <button
        class="status bad"
        title="Jump to error"
        onclick={() => {
          const s = studioStore.syntax;
          if (s.state === "invalid") {
            studioStore.tool = studioStore.tool === "tree" || studioStore.tool === "diff" || studioStore.tool === "analytics" ? "editor" : studioStore.tool;
            editorRef?.revealPosition(s.error.line, Math.max(1, s.error.column));
          }
        }}
      >
        ✗ line {studioStore.syntax.error.line}: {studioStore.syntax.error.message.slice(0, 80)}
      </button>
    {:else}
      <span class="status muted">checking…</span>
    {/if}
    <span class="spacer"></span>
    <span class="muted">{sizeLabel}</span>
    <span class="muted">local only · autosaved for recovery</span>
  </div>

  {#if toast}
    <div class="toast" role="status">{toast}</div>
  {/if}
</div>

<style>
  .studio {
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: calc(100vh - 150px);
    min-height: 420px;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 14px;
    border-radius: 8px;
    background: var(--accent-soft);
    border: 1px solid var(--border);
    font-size: 12.5px;
  }
  .banner span {
    flex: 1;
  }
  .banner button {
    font-size: 12px;
    padding: 4px 10px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .tools {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    flex-wrap: wrap;
  }
  .tools button {
    border: none;
    border-radius: 0;
    font-size: 12px;
    padding: 6px 10px;
    color: var(--text-muted);
  }
  .tools button.active {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .actions button,
  .actions select {
    font-size: 12px;
    padding: 5px 10px;
  }
  .actions select {
    font-family: inherit;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  .help {
    width: 28px;
    padding: 5px 0 !important;
    border-radius: 50% !important;
    font-weight: 700;
  }
  .shortcuts {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    padding: 8px 14px;
    font-size: 12px;
    align-self: flex-end;
  }
  .shortcuts table {
    border-collapse: collapse;
  }
  .shortcuts td {
    padding: 2px 12px 2px 0;
  }
  kbd {
    font-family: var(--mono);
    font-size: 11px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
  }
  .workspace {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .workspace.split {
    grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
  }
  .editor-pane,
  .side-pane {
    min-height: 0;
    min-width: 0;
  }
  .side-pane {
    overflow: hidden;
  }
  .status-bar {
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: 11.5px;
    padding: 2px 2px 0;
  }
  .status {
    font-weight: 600;
  }
  .status.ok {
    color: var(--added-fg);
  }
  .status.bad {
    color: var(--removed-fg);
    border: none;
    background: transparent;
    padding: 0;
    font-size: 11.5px;
    font-weight: 600;
    text-align: left;
  }
  .toast {
    position: fixed;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--text);
    color: var(--bg);
    padding: 8px 18px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    z-index: 60;
  }
  @media (max-width: 900px) {
    .workspace.split {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(220px, 1fr) minmax(260px, 1fr);
    }
    .studio {
      height: auto;
    }
    .editor-pane {
      min-height: 260px;
    }
  }
</style>
