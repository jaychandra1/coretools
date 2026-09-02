/**
 * YAML ⇄ JSON via the `yaml` package already used by the YML-Validator, in
 * the same locked-down mode: data-only core schema (no custom tags, nothing
 * executable) and an alias-expansion cap against billion-laughs inputs.
 */

import { parse, stringify } from "yaml";
import type { JsonValue, Result } from "./../types";

export function yamlToJson(text: string): Result<JsonValue> {
  if (text.trim() === "") return { ok: false, error: "YAML input is empty" };
  try {
    const value = parse(text, { schema: "core", maxAliasCount: 100 }) as JsonValue;
    // YAML dates etc. can't appear with the core schema; undefined can.
    return { ok: true, value: value === undefined ? null : value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function jsonToYaml(value: JsonValue): Result<string> {
  try {
    return {
      ok: true,
      value: stringify(value, { schema: "core", indent: 2, lineWidth: 100 }),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
