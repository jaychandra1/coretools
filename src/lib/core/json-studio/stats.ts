/**
 * Document analytics: one linear walk collecting the numbers the dashboard
 * shows. Pure computation; safe to run in the worker for large documents.
 */

import { jsonTypeOf, type JsonType, type JsonValue } from "./types";

export interface JsonStats {
  /** Total number of nodes (containers + leaves). */
  nodes: number;
  /** Count per JSON type. */
  types: Record<JsonType, number>;
  /** Deepest nesting level (root = 1). */
  maxDepth: number;
  /** Node count per depth level, index 0 = depth 1. */
  depthHistogram: number[];
  /** Object keys seen, with occurrence counts, sorted descending. */
  topKeys: Array<{ key: string; count: number }>;
  /** Total object entries. */
  totalKeys: number;
  /** Number of distinct object keys. */
  distinctKeys: number;
  arrays: { count: number; maxLength: number; totalItems: number };
  strings: { count: number; totalLength: number; maxLength: number };
  numbers: { count: number; min: number | null; max: number | null; integers: number };
}

export function computeStats(root: JsonValue): JsonStats {
  const types: Record<JsonType, number> = {
    object: 0,
    array: 0,
    string: 0,
    number: 0,
    boolean: 0,
    null: 0,
  };
  const keyCounts = new Map<string, number>();
  const depthHistogram: number[] = [];
  let nodes = 0;
  let maxDepth = 0;
  let totalKeys = 0;
  const arrays = { count: 0, maxLength: 0, totalItems: 0 };
  const strings = { count: 0, totalLength: 0, maxLength: 0 };
  const numbers = {
    count: 0,
    min: null as number | null,
    max: null as number | null,
    integers: 0,
  };

  // Explicit stack instead of recursion: a 100k-element flat array must not
  // blow the call stack.
  const stack: Array<{ value: JsonValue; depth: number }> = [{ value: root, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes++;
    maxDepth = Math.max(maxDepth, depth);
    depthHistogram[depth - 1] = (depthHistogram[depth - 1] ?? 0) + 1;

    const type = jsonTypeOf(value);
    types[type]++;

    switch (type) {
      case "array": {
        const arr = value as JsonValue[];
        arrays.count++;
        arrays.maxLength = Math.max(arrays.maxLength, arr.length);
        arrays.totalItems += arr.length;
        for (const item of arr) stack.push({ value: item, depth: depth + 1 });
        break;
      }
      case "object": {
        const obj = value as { [k: string]: JsonValue };
        for (const [key, child] of Object.entries(obj)) {
          totalKeys++;
          keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
          stack.push({ value: child, depth: depth + 1 });
        }
        break;
      }
      case "string": {
        const s = value as string;
        strings.count++;
        strings.totalLength += s.length;
        strings.maxLength = Math.max(strings.maxLength, s.length);
        break;
      }
      case "number": {
        const n = value as number;
        numbers.count++;
        numbers.min = numbers.min === null ? n : Math.min(numbers.min, n);
        numbers.max = numbers.max === null ? n : Math.max(numbers.max, n);
        if (Number.isInteger(n)) numbers.integers++;
        break;
      }
      default:
        break;
    }
  }

  const topKeys = [...keyCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 12);

  return {
    nodes,
    types,
    maxDepth,
    depthHistogram,
    topKeys,
    totalKeys,
    distinctKeys: keyCounts.size,
    arrays,
    strings,
    numbers,
  };
}
