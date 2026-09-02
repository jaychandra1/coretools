/**
 * Semantic JSON diff: compares two parsed documents structurally and reports
 * added / removed / changed leaves with JSON Pointer paths. Text-level
 * side-by-side rendering is handled by Monaco's diff editor in the UI; this
 * module answers "what actually changed" independent of formatting.
 */

import { toPointer, type DiffEntry, type JsonPathSegments, type JsonValue } from "./types";

function isPlainObject(v: JsonValue): v is { [k: string]: JsonValue } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function scalarEqual(a: JsonValue, b: JsonValue): boolean {
  return a === b || (Number.isNaN(a as number) && Number.isNaN(b as number));
}

function walk(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  path: JsonPathSegments,
  out: DiffEntry[],
): void {
  if (left === undefined && right === undefined) return;

  if (left === undefined) {
    out.push({ path: toPointer(path), kind: "added", right });
    return;
  }
  if (right === undefined) {
    out.push({ path: toPointer(path), kind: "removed", left });
    return;
  }

  const bothObjects = isPlainObject(left) && isPlainObject(right);
  const bothArrays = Array.isArray(left) && Array.isArray(right);

  if (!bothObjects && !bothArrays) {
    if (!scalarEqual(left, right) || typeof left !== typeof right) {
      // Containers of different kinds, or differing scalars, are one change.
      if (
        typeof left !== "object" &&
        typeof right !== "object" &&
        scalarEqual(left, right)
      ) {
        return;
      }
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        out.push({ path: toPointer(path), kind: "changed", left, right });
      }
    }
    return;
  }

  if (bothObjects) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      walk(
        key in left ? left[key] : undefined,
        key in right ? right[key] : undefined,
        [...path, key],
        out,
      );
    }
    return;
  }

  // Arrays: index-aligned comparison. (LCS alignment reads better for long
  // reordered lists but reports moves as churn either way; index alignment
  // is predictable and matches how Monaco's text diff presents it.)
  const leftArr = left as JsonValue[];
  const rightArr = right as JsonValue[];
  const max = Math.max(leftArr.length, rightArr.length);
  for (let i = 0; i < max; i++) {
    walk(
      i < leftArr.length ? leftArr[i] : undefined,
      i < rightArr.length ? rightArr[i] : undefined,
      [...path, i],
      out,
    );
  }
}

/** Structural diff between two parsed documents. */
export function diffJson(left: JsonValue, right: JsonValue): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(left, right, [], out);
  return out;
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  identical: boolean;
}

export function summarizeDiff(entries: DiffEntry[]): DiffSummary {
  const summary: DiffSummary = { added: 0, removed: 0, changed: 0, identical: entries.length === 0 };
  for (const entry of entries) summary[entry.kind]++;
  return summary;
}
