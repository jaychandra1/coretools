<script lang="ts">
  import { getPlatform } from "../platform";

  interface Props {
    label: string;
    value: string;
    fileName?: string;
    placeholder?: string;
    rows?: number;
  }

  let {
    label,
    value = $bindable(""),
    fileName = $bindable(""),
    placeholder = "Paste text here, or load a file…",
    rows = 12,
  }: Props = $props();

  let busy = $state(false);
  let error = $state("");

  async function load() {
    busy = true;
    error = "";
    try {
      const file = await getPlatform().openTextFile();
      if (file) {
        value = file.content;
        fileName = file.name;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function clear() {
    value = "";
    fileName = "";
    error = "";
  }
</script>

<div class="panel">
  <div class="head">
    <span class="label">{label}</span>
    <div class="actions">
      {#if fileName}<span class="fname mono" title={fileName}>{fileName}</span>{/if}
      <button onclick={load} disabled={busy}>{busy ? "Loading…" : "Load file"}</button>
      <button onclick={clear} disabled={busy || !value}>Clear</button>
    </div>
  </div>
  <textarea bind:value {placeholder} {rows} spellcheck="false"></textarea>
  {#if error}<p class="err">{error}</p>{/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .label {
    font-weight: 600;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .fname {
    font-size: 11.5px;
    color: var(--text-muted);
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err {
    color: var(--danger);
    font-size: 12px;
    margin: 2px 0 0;
  }
</style>
