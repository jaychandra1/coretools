/**
 * Monaco bootstrap: bundles the editor + its workers locally (Vite emits
 * same-origin worker files — no CDN, no blob: URLs, CSP stays untouched) and
 * defines light/dark themes that match the app's design tokens.
 */

import * as monaco from "monaco-editor";
// monaco-editor is pinned to 0.53.x: newer releases bundle a dompurify with
// open advisories (breaks the "npm audit --omit=dev: 0 vulnerabilities"
// policy), and 0.53 uses the classic esm/vs/* layout for worker entries.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    return label === "json" ? new JsonWorker() : new EditorWorker();
  },
};

/** One marker (squiggle + problems entry) shown in an editor. */
export interface EditorMarker {
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity?: "error" | "warning" | "info";
}

monaco.editor.defineTheme("coretools-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "string.key.json", foreground: "6d28d9" },
    { token: "string.value.json", foreground: "12703a" },
    { token: "number", foreground: "a15c07" },
    { token: "keyword.json", foreground: "a11414" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#1c2530",
    "editorLineNumber.foreground": "#9aa4b1",
    "editor.lineHighlightBackground": "#f0f2f5",
  },
});

monaco.editor.defineTheme("coretools-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "string.key.json", foreground: "a78bfa" },
    { token: "string.value.json", foreground: "6fe39a" },
    { token: "number", foreground: "f2b96b" },
    { token: "keyword.json", foreground: "ff9d9d" },
  ],
  colors: {
    "editor.background": "#1b2027",
    "editor.foreground": "#e6eaef",
    "editorLineNumber.foreground": "#66707c",
    "editor.lineHighlightBackground": "#232a33",
  },
});

export function currentMonacoTheme(): string {
  const explicit = document.documentElement.dataset.theme;
  const dark =
    explicit === "dark" ||
    (explicit === undefined &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  return dark ? "coretools-dark" : "coretools-light";
}

/** Re-apply the Monaco theme whenever the app theme toggles. Returns cleanup. */
export function watchAppTheme(): () => void {
  const apply = () => monaco.editor.setTheme(currentMonacoTheme());
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

export { monaco };
