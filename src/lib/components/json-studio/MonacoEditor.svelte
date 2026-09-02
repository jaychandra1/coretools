<script lang="ts">
  import { untrack } from "svelte";
  import { monaco, currentMonacoTheme, type EditorMarker } from "./monaco-setup";

  let {
    value = $bindable(""),
    language = "json",
    readOnly = false,
    markers = [],
    ariaLabel = "Code editor",
  }: {
    value?: string;
    language?: string;
    readOnly?: boolean;
    markers?: EditorMarker[];
    ariaLabel?: string;
  } = $props();

  let container: HTMLDivElement | undefined = $state();
  // $state so the value/readOnly/markers sync effects below re-run when the
  // editor instance appears (or is ever recreated), not only on prop changes.
  let editor = $state<monaco.editor.IStandaloneCodeEditor | null>(null);
  let applyingExternal = false;

  // Creation depends ONLY on the container. Every prop is read through
  // untrack(): reading `value` (which the change handler below writes) as a
  // tracked dependency would invalidate this effect on each keystroke,
  // disposing and recreating the editor — destroying cursor, scroll, find
  // state and the undo stack. Prop changes flow through the sync effects
  // further down instead.
  $effect(() => {
    if (!container) return;
    // Work with a LOCAL instance throughout this effect: reading the $state
    // `editor` back after writing it would make the effect self-dependent and
    // loop forever, re-creating editors.
    const instance = untrack(() =>
      monaco.editor.create(container!, {
        value,
        language,
        theme: currentMonacoTheme(),
        readOnly,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 12.5,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        scrollBeyondLastLine: false,
        tabSize: 2,
        wordWrap: "off",
        renderWhitespace: "none",
        fixedOverflowWidgets: true,
        ariaLabel,
      }),
    );

    const subscription = instance.onDidChangeModelContent(() => {
      if (applyingExternal) return;
      value = instance.getValue();
    });

    editor = instance;

    return () => {
      subscription.dispose();
      instance.dispose();
      editor = null;
    };
  });

  // External value changes (format, repair, restore, …) flow into the model;
  // user typing flows out through onDidChangeModelContent. The guard flag
  // stops the two directions from echoing each other.
  $effect(() => {
    const next = value;
    if (editor && editor.getValue() !== next) {
      applyingExternal = true;
      editor.setValue(next);
      applyingExternal = false;
    }
  });

  $effect(() => {
    editor?.updateOptions({ readOnly });
  });

  $effect(() => {
    const model = editor?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      "json-studio",
      markers.map((m) => ({
        message: m.message,
        startLineNumber: m.line,
        startColumn: m.column,
        endLineNumber: m.endLine ?? m.line,
        endColumn: m.endColumn ?? m.column + 1,
        severity:
          m.severity === "warning"
            ? monaco.MarkerSeverity.Warning
            : m.severity === "info"
              ? monaco.MarkerSeverity.Info
              : monaco.MarkerSeverity.Error,
      })),
    );
  });

  /** Move the cursor and reveal a position (used by "jump to error"). */
  export function revealPosition(line: number, column: number): void {
    if (!editor) return;
    editor.setPosition({ lineNumber: line, column });
    editor.revealPositionInCenter({ lineNumber: line, column });
    editor.focus();
  }
</script>

<div class="editor" bind:this={container}></div>

<style>
  .editor {
    width: 100%;
    height: 100%;
    min-height: 200px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
</style>
