/**
 * Reactive state for JSON Studio (Svelte 5 runes).
 *
 * Owns the working texts (document, schema, diff right side), the debounced
 * syntax status (checked in the worker for large documents), and session
 * recovery. Parsed values are memoized per text so every panel shares one
 * parse.
 */

import { parseJson } from "../../core/json-studio/parse";
import type { JsonValue, ParseError, ParseResult } from "../../core/json-studio/types";
import { checkSyntax } from "../../core/json-studio/worker/client";
import {
  clearSession,
  loadSession,
  saveSession,
  type StudioSession,
} from "../../core/json-studio/db";

export type StudioTool =
  | "editor"
  | "tree"
  | "diff"
  | "query"
  | "schema"
  | "openapi"
  | "convert"
  | "codegen"
  | "analytics";

export const STUDIO_TOOLS: Array<{ id: StudioTool; label: string }> = [
  { id: "editor", label: "Editor" },
  { id: "tree", label: "Tree" },
  { id: "diff", label: "Diff" },
  { id: "query", label: "Query" },
  { id: "schema", label: "Schema" },
  { id: "openapi", label: "OpenAPI" },
  { id: "convert", label: "Convert" },
  { id: "codegen", label: "Codegen" },
  { id: "analytics", label: "Analytics" },
];

const DEFAULT_DOC = `{
  "project": "CoreTools",
  "version": 1,
  "features": ["diff", "yaml", "grammar", "authenticator", "json-studio"],
  "author": { "name": "you", "active": true }
}
`;

export type SyntaxStatus =
  | { state: "pending" }
  | { state: "valid" }
  | { state: "invalid"; error: ParseError };

class StudioStore {
  ready = $state(false);
  tool = $state<StudioTool>("editor");
  docText = $state(DEFAULT_DOC);
  schemaText = $state("");
  rightText = $state("");
  indent = $state<2 | 4 | "\t">(2);
  syntax = $state<SyntaxStatus>({ state: "pending" });
  /** A recoverable previous session, offered once at startup. */
  restoreOffer = $state<StudioSession | null>(null);

  #syntaxTimer: ReturnType<typeof setTimeout> | undefined;
  #syntaxSeq = 0;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #parsedText: string | null = null;
  #parsedResult: ParseResult | null = null;

  async init(): Promise<void> {
    if (this.ready) return;
    const session = await loadSession();
    if (
      session &&
      (session.docText !== DEFAULT_DOC || session.schemaText || session.rightText)
    ) {
      this.restoreOffer = session;
    }
    this.ready = true;
    this.scheduleSyntaxCheck();
  }

  restoreSession(): void {
    const session = this.restoreOffer;
    if (!session) return;
    this.docText = session.docText;
    this.schemaText = session.schemaText;
    this.rightText = session.rightText;
    if (STUDIO_TOOLS.some((t) => t.id === session.tool)) {
      this.tool = session.tool as StudioTool;
    }
    this.restoreOffer = null;
    this.onDocChanged();
  }

  async discardSession(): Promise<void> {
    this.restoreOffer = null;
    await clearSession();
  }

  /** Call whenever any persisted text changes: revalidate + autosave. */
  onDocChanged(): void {
    this.scheduleSyntaxCheck();
    this.scheduleAutosave();
  }

  private scheduleSyntaxCheck(): void {
    clearTimeout(this.#syntaxTimer);
    this.syntax = { state: "pending" };
    const seq = ++this.#syntaxSeq;
    this.#syntaxTimer = setTimeout(async () => {
      const text = this.docText;
      const result = await checkSyntax(text);
      if (seq !== this.#syntaxSeq) return; // superseded by newer input
      this.syntax = result.ok
        ? { state: "valid" }
        : { state: "invalid", error: result.error };
    }, 250);
  }

  private scheduleAutosave(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      void saveSession({
        docText: this.docText,
        schemaText: this.schemaText,
        rightText: this.rightText,
        tool: this.tool,
        updatedAt: Date.now(),
      });
    }, 800);
  }

  /** Parse the current document, memoized on the exact text. */
  parsed(): ParseResult {
    if (this.#parsedText !== this.docText || this.#parsedResult === null) {
      this.#parsedText = this.docText;
      this.#parsedResult = parseJson(this.docText);
    }
    return this.#parsedResult;
  }

  /** Parsed value, or null when the document is invalid. */
  parsedValue(): JsonValue | null {
    const result = this.parsed();
    return result.ok ? result.value : null;
  }

  /** Replace the document from a parsed value (tree edits). */
  setFromValue(value: JsonValue): void {
    this.docText = JSON.stringify(value, null, this.indent);
    this.onDocChanged();
  }

  setDocText(text: string): void {
    this.docText = text;
    this.onDocChanged();
  }
}

export const studioStore = new StudioStore();
