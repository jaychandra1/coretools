/**
 * JSON Schema (draft 2020-12) inference from an example document.
 *
 * Array item schemas are merged across elements: object properties present in
 * every element stay `required`, differing types union via `anyOf`. Common
 * string formats (date-time, date, email, uuid, uri) are detected. The result
 * is a starting point meant to be edited, not a proof of the data contract.
 */

import type { JsonValue } from "./types";
import { hasOwn, setOwn } from "../own";

export interface InferOptions {
  /** Detect string formats (date-time, email, uuid, uri). Default true. */
  detectFormats?: boolean;
  /** Emit `required` arrays for object schemas. Default true. */
  markRequired?: boolean;
}

type Schema = { [key: string]: JsonValue };

const FORMAT_PATTERNS: Array<[string, RegExp]> = [
  ["date-time", /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/],
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["time", /^\d{2}:\d{2}:\d{2}(\.\d+)?$/],
  ["email", /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/],
  ["uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ["uri", /^[a-z][a-z0-9+.-]*:\/\/\S+$/i],
];

function detectFormat(value: string): string | null {
  for (const [format, pattern] of FORMAT_PATTERNS) {
    if (pattern.test(value)) return format;
  }
  return null;
}

function inferNode(value: JsonValue, options: Required<InferOptions>): Schema {
  if (value === null) return { type: "null" };

  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array", items: {} };
    const merged = value
      .map((item) => inferNode(item, options))
      .reduce((a, b) => mergeSchemas(a, b, options));
    return { type: "array", items: merged };
  }

  switch (typeof value) {
    case "boolean":
      return { type: "boolean" };
    case "number":
      return { type: Number.isInteger(value) ? "integer" : "number" };
    case "string": {
      const schema: Schema = { type: "string" };
      if (options.detectFormats) {
        const format = detectFormat(value);
        if (format) schema.format = format;
      }
      return schema;
    }
    case "object": {
      const properties: Schema = {};
      for (const [key, child] of Object.entries(value)) {
        setOwn(properties, key, inferNode(child, options));
      }
      const schema: Schema = { type: "object", properties };
      if (options.markRequired) schema.required = Object.keys(value);
      return schema;
    }
  }
}

/** Merge two inferred schemas into one that accepts both shapes. */
export function mergeSchemas(
  a: Schema,
  b: Schema,
  options: Required<InferOptions>,
): Schema {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;

  const typeA = a.type as string | undefined;
  const typeB = b.type as string | undefined;

  // integer widens to number
  if (
    (typeA === "integer" && typeB === "number") ||
    (typeA === "number" && typeB === "integer")
  ) {
    return { type: "number" };
  }

  if (typeA === typeB && typeA === "string") {
    // Same type, differing formats: keep the type, drop the format claim.
    return { type: "string" };
  }

  if (typeA === typeB && typeA === "object") {
    const propsA = (a.properties ?? {}) as Schema;
    const propsB = (b.properties ?? {}) as Schema;
    const properties: Schema = {};
    for (const key of new Set([...Object.keys(propsA), ...Object.keys(propsB)])) {
      const inA = hasOwn(propsA, key);
      const inB = hasOwn(propsB, key);
      setOwn(
        properties,
        key,
        inA && inB
          ? mergeSchemas(propsA[key] as Schema, propsB[key] as Schema, options)
          : ((inA ? propsA[key] : propsB[key]) as Schema),
      );
    }
    const schema: Schema = { type: "object", properties };
    if (options.markRequired) {
      const requiredA = new Set((a.required as string[] | undefined) ?? []);
      const required = ((b.required as string[] | undefined) ?? []).filter((k) =>
        requiredA.has(k),
      );
      if (required.length > 0) schema.required = required;
    }
    return schema;
  }

  if (typeA === typeB && typeA === "array") {
    return {
      type: "array",
      items: mergeSchemas(
        (a.items ?? {}) as Schema,
        (b.items ?? {}) as Schema,
        options,
      ),
    };
  }

  // Different types: union. Flatten nested anyOf and dedupe.
  const variants: Schema[] = [];
  for (const schema of [a, b]) {
    const nested = (schema.anyOf as Schema[] | undefined) ?? [schema];
    for (const variant of nested) {
      if (!variants.some((v) => JSON.stringify(v) === JSON.stringify(variant))) {
        variants.push(variant);
      }
    }
  }
  return { anyOf: variants as JsonValue };
}

/** Infer a complete standalone schema document for `value`. */
export function inferSchema(
  value: JsonValue,
  options: InferOptions = {},
): Schema {
  const resolved: Required<InferOptions> = {
    detectFormats: options.detectFormats ?? true,
    markRequired: options.markRequired ?? true,
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...inferNode(value, resolved),
  };
}
