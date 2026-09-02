/**
 * JSON repair: fix the almost-JSON people actually paste — single quotes,
 * trailing commas, unquoted keys, Python literals, comments, truncated
 * documents. Wraps the `jsonrepair` library and reports what changed.
 */

import { jsonrepair } from "jsonrepair";
import type { Result } from "./types";
import { parseJson } from "./parse";

export interface RepairOutcome {
  repaired: string;
  /** True when the input was already valid and came back untouched. */
  alreadyValid: boolean;
}

export function repairJson(text: string): Result<RepairOutcome> {
  if (text.trim() === "") {
    return { ok: false, error: "Nothing to repair — the document is empty" };
  }

  if (parseJson(text).ok) {
    return { ok: true, value: { repaired: text, alreadyValid: true } };
  }

  try {
    const repaired = jsonrepair(text);
    // Trust nothing: the output must round-trip through the real parser.
    const check = parseJson(repaired);
    if (!check.ok) {
      return { ok: false, error: `Repair produced invalid JSON: ${check.error.message}` };
    }
    return { ok: true, value: { repaired, alreadyValid: false } };
  } catch (e) {
    return {
      ok: false,
      error: `Could not repair: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
