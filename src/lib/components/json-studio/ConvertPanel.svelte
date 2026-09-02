<script lang="ts">
  import { studioStore } from "./studio-store.svelte";
  import { getPlatform } from "../../platform";
  import { csvToJson, jsonToCsv } from "../../core/json-studio/convert/csv";
  import { jsonToXml, xmlToJson } from "../../core/json-studio/convert/xml";
  import { jsonToYaml, yamlToJson } from "../../core/json-studio/convert/yaml";
  import { jsonToXlsx, xlsxToJson } from "../../core/json-studio/convert/xlsx";
  import type { JsonValue, Result } from "../../core/json-studio/types";

  const platform = getPlatform();

  type Format = "csv" | "xml" | "yaml" | "xlsx";
  const FORMATS: Array<{ id: Format; label: string; ext: string }> = [
    { id: "csv", label: "CSV", ext: "csv" },
    { id: "xml", label: "XML", ext: "xml" },
    { id: "yaml", label: "YAML", ext: "yaml" },
    { id: "xlsx", label: "Excel (.xlsx)", ext: "xlsx" },
  ];

  let direction = $state<"export" | "import">("export");
  let format = $state<Format>("csv");
  let importText = $state("");
  let message = $state("");
  let messageKind = $state<"ok" | "error">("ok");

  function note(kind: "ok" | "error", text: string) {
    messageKind = kind;
    message = text;
  }

  // ---- export ----------------------------------------------------------

  const exportPreview = $derived.by((): Result<string> => {
    void studioStore.docText;
    if (direction !== "export") return { ok: true, value: "" };
    const value = studioStore.parsedValue();
    if (value === null) return { ok: false, error: "The document is not valid JSON." };
    switch (format) {
      case "csv":
        return jsonToCsv(value);
      case "xml":
        return jsonToXml(value);
      case "yaml":
        return jsonToYaml(value);
      case "xlsx": {
        const bytes = jsonToXlsx(value);
        return bytes.ok
          ? {
              ok: true,
              value: `(binary workbook, ${bytes.value.length.toLocaleString()} bytes — use Download)`,
            }
          : bytes;
      }
    }
  });

  async function download() {
    const value = studioStore.parsedValue();
    if (value === null) return note("error", "The document is not valid JSON.");
    const ext = FORMATS.find((f) => f.id === format)!.ext;
    const name = `data.${ext}`;

    if (format === "xlsx") {
      const bytes = jsonToXlsx(value);
      if (!bytes.ok) return note("error", bytes.error);
      const saved = await platform.saveBinaryFile(name, bytes.value);
      if (saved) note("ok", `Exported ${name}`);
      return;
    }
    const text =
      format === "csv" ? jsonToCsv(value) : format === "xml" ? jsonToXml(value) : jsonToYaml(value);
    if (!text.ok) return note("error", text.error);
    const saved = await platform.saveTextFile(name, text.value);
    if (saved) note("ok", `Exported ${name}`);
  }

  // ---- import ----------------------------------------------------------

  function applyImported(result: Result<JsonValue>, source: string) {
    if (!result.ok) return note("error", result.error);
    studioStore.setDocText(JSON.stringify(result.value, null, studioStore.indent));
    note("ok", `Imported ${source} into the document`);
  }

  function importFromText() {
    if (importText.trim() === "") return note("error", "Paste something to import first.");
    switch (format) {
      case "csv":
        return applyImported(csvToJson(importText), "CSV");
      case "xml":
        return applyImported(xmlToJson(importText), "XML");
      case "yaml":
        return applyImported(yamlToJson(importText), "YAML");
      case "xlsx":
        return note("error", "Excel files are binary — use “Open .xlsx file”.");
    }
  }

  async function importTextFile() {
    const file = await platform.openTextFile();
    if (!file) return;
    importText = file.content;
    importFromText();
  }

  async function importXlsxFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = "";
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    applyImported(xlsxToJson(bytes), file.name);
  }
</script>

<div class="convert-panel">
  <div class="controls">
    <div class="mode" role="radiogroup" aria-label="Direction">
      <button class:active={direction === "export"} onclick={() => (direction = "export")}>
        JSON →
      </button>
      <button class:active={direction === "import"} onclick={() => (direction = "import")}>
        → JSON
      </button>
    </div>
    <div class="formats" role="radiogroup" aria-label="Format">
      {#each FORMATS as f (f.id)}
        <button class:active={format === f.id} onclick={() => (format = f.id)}>{f.label}</button>
      {/each}
    </div>
  </div>

  {#if direction === "export"}
    {#if exportPreview.ok}
      <pre class="preview">{exportPreview.value.length > 20000
          ? exportPreview.value.slice(0, 20000) + "\n…(truncated preview)"
          : exportPreview.value}</pre>
      <div class="actions">
        <button class="primary" onclick={download}>Download .{FORMATS.find((f) => f.id === format)?.ext}</button>
      </div>
    {:else}
      <p class="error" role="alert">{exportPreview.error}</p>
    {/if}
  {:else}
    {#if format === "xlsx"}
      <label class="file-btn">
        Open .xlsx file…
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onchange={importXlsxFile}
        />
      </label>
      <p class="muted hint">The first worksheet becomes an array of objects (header row = keys).</p>
    {:else}
      <textarea
        bind:value={importText}
        rows="12"
        placeholder={format === "csv"
          ? "id,name\n1,Alice"
          : format === "xml"
            ? "<items><item id=\"1\">Alice</item></items>"
            : "items:\n  - id: 1\n    name: Alice"}
        spellcheck="false"
        aria-label="Content to import"
      ></textarea>
      <div class="actions">
        <button onclick={importTextFile}>Open file…</button>
        <button class="primary" onclick={importFromText}>Convert to JSON</button>
      </div>
      <p class="muted hint">
        Converting replaces the working document (undo: Ctrl+Z in the editor).
      </p>
    {/if}
  {/if}

  {#if message}
    <p class={messageKind === "ok" ? "ok" : "error"} role="status">{message}</p>
  {/if}
</div>

<style>
  .convert-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }
  .controls {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .mode,
  .formats {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .mode button,
  .formats button {
    border: none;
    border-radius: 0;
    font-size: 12px;
    padding: 6px 12px;
  }
  .mode button.active,
  .formats button.active {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .preview {
    flex: 1;
    overflow: auto;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    font-size: 11.5px;
    min-height: 160px;
    white-space: pre;
  }
  textarea {
    flex: 1;
    min-height: 160px;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .file-btn {
    align-self: flex-start;
    display: inline-block;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    cursor: pointer;
    font-size: 13px;
  }
  .file-btn:hover {
    background: var(--surface-2);
  }
  .file-btn input {
    display: none;
  }
  .hint {
    font-size: 11.5px;
    margin: 0;
  }
  .ok {
    color: var(--added-fg);
    font-size: 12.5px;
    margin: 0;
  }
  .error {
    color: var(--danger);
    font-size: 12.5px;
    margin: 0;
  }
</style>
