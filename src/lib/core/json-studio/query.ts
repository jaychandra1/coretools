/**
 * JSONPath and JMESPath explorers.
 *
 * JSONPath runs through `jsonpath-plus` with `eval: "safe"` — filter
 * expressions like `$..books[?(@.price < 10)]` are evaluated by its built-in
 * jsep-based interpreter, never by `eval`/`new Function`, keeping the app's
 * CSP intact. JMESPath (`jmespath`) is interpreter-based by design.
 */

import { JSONPath } from "jsonpath-plus";
import { search as jmespathSearch } from "jmespath";
import type { JsonValue, Result } from "./types";

export interface QueryMatch {
  /** Normalized JSONPath of the match (JSONPath mode) or "" (JMESPath). */
  path: string;
  /** JSON Pointer for cross-linking with the tree/editor, when available. */
  pointer: string;
  value: JsonValue;
}

export interface QueryOutcome {
  matches: QueryMatch[];
  /** JMESPath returns a single (possibly composite) result value. */
  single?: JsonValue;
}

export function runJsonPath(
  data: JsonValue,
  expression: string,
): Result<QueryOutcome> {
  const trimmed = expression.trim();
  if (!trimmed) return { ok: false, error: "Enter a JSONPath expression (e.g. $.store.book[*].title)" };
  try {
    const results = JSONPath({
      path: trimmed,
      json: data as never,
      resultType: "all",
      eval: "safe",
      wrap: true,
    }) as Array<{ path: string; pointer: string; value: JsonValue }>;
    return {
      ok: true,
      value: {
        matches: (results ?? []).map((r) => ({
          path: r.path,
          pointer: r.pointer,
          value: r.value,
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function runJmesPath(
  data: JsonValue,
  expression: string,
): Result<QueryOutcome> {
  const trimmed = expression.trim();
  if (!trimmed) return { ok: false, error: "Enter a JMESPath expression (e.g. locations[?state=='WA'].name)" };
  try {
    const result = jmespathSearch(data as never, trimmed) as JsonValue;
    return { ok: true, value: { matches: [], single: result ?? null } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
