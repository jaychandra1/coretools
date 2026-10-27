/**
 * Harper (harper.js, Apache-2.0) as the checker's engine: its dialects, and
 * the conversion of its lints into plain, serializable issues. Shared by the
 * worker (src/lib/writing/checker.worker.ts) and the tests, which run the
 * real engine.
 */

import { Dialect, SuggestionKind, type Lint, type Linter } from "harper.js";
import type { DialectId } from "./dialects";
import { categoryOf, type Fix, type Issue } from "./issues";

const HARPER_DIALECTS: Record<DialectId, Dialect> = {
  american: Dialect.American,
  british: Dialect.British,
  canadian: Dialect.Canadian,
  australian: Dialect.Australian,
  indian: Dialect.Indian,
};

export function harperDialect(id: DialectId): Dialect {
  return HARPER_DIALECTS[id];
}

/** Most suggestions shown per issue (Harper can offer many for a misspelling). */
const MAX_FIXES = 4;

/** Plain-English names for Harper's lint kinds where its own read like code. */
const TITLES: Record<string, string> = {
  BoundaryError: "Word boundary",
  Miscellaneous: "Suggestion",
  Enhancement: "Suggestion",
  WordChoice: "Word choice",
  WordOrder: "Word order",
  Eggcorn: "Word choice",
  Malapropism: "Word choice",
  Nonstandard: "Nonstandard usage",
  Regionalism: "Regional spelling",
};

function titleOf(kind: string, pretty: string): string {
  return TITLES[kind] ?? pretty.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
}

function fixOf(kind: SuggestionKind, text: string): Fix {
  switch (kind) {
    case SuggestionKind.Remove:
      return { kind: "remove", text: "" };
    case SuggestionKind.InsertAfter:
      return { kind: "insert-after", text };
    default:
      return { kind: "replace", text };
  }
}

/**
 * Plain issues from Harper's lints. The lints (WebAssembly objects) are
 * released here; the issues hold copies of everything the UI needs.
 */
export function toIssues(lints: readonly Lint[]): Issue[] {
  return lints.map((lint, i) => {
    const span = lint.span();
    const suggestions = lint.suggestions();
    const fixes: Fix[] = [];
    for (const suggestion of suggestions) {
      const fix = fixOf(suggestion.kind(), suggestion.get_replacement_text());
      if (fixes.length < MAX_FIXES && !fixes.some((f) => f.kind === fix.kind && f.text === fix.text)) {
        fixes.push(fix);
      }
      suggestion.free();
    }
    const rule = lint.lint_kind();
    const issue: Issue = {
      id: `h${i}:${span.start}:${span.end}`,
      start: span.start,
      end: span.end,
      category: categoryOf(rule),
      rule,
      title: titleOf(rule, lint.lint_kind_pretty()),
      message: lint.message(),
      problem: lint.get_problem_text(),
      fixes,
    };
    span.free();
    lint.free();
    return issue;
  });
}

/** Check plain text (not Markdown: an asterisk or a hash means what it says). */
export async function lintText(linter: Linter, text: string): Promise<Issue[]> {
  if (!text.trim()) return [];
  return toIssues(await linter.lint(text, { language: "plaintext" }));
}
