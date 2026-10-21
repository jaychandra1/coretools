/**
 * Immutable path-based edits for the tree editor. Every operation returns a
 * NEW root value (structural sharing along the untouched branches), so the
 * UI can treat documents as immutable snapshots.
 */

import type { JsonPathSegments, JsonValue } from "./types";
import { hasOwn, setOwn } from "../own";

function isContainer(v: JsonValue): v is JsonValue[] | { [k: string]: JsonValue } {
  return v !== null && typeof v === "object";
}

function cloneShallow(v: JsonValue[] | { [k: string]: JsonValue }) {
  return Array.isArray(v) ? [...v] : { ...v };
}

/** Read the value at `path`; undefined when the path doesn't resolve. */
export function getAtPath(
  root: JsonValue,
  path: JsonPathSegments,
): JsonValue | undefined {
  let current: JsonValue = root;
  for (const segment of path) {
    if (!isContainer(current)) return undefined;
    if (Array.isArray(current)) {
      if (typeof segment !== "number" || segment < 0 || segment >= current.length) {
        return undefined;
      }
      current = current[segment];
    } else {
      if (typeof segment !== "string" || !hasOwn(current, segment)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

/** Replace the value at `path`. Replacing the root returns `value` itself. */
export function setAtPath(
  root: JsonValue,
  path: JsonPathSegments,
  value: JsonValue,
): JsonValue {
  if (path.length === 0) return value;
  if (!isContainer(root)) {
    throw new Error("Cannot descend into a primitive value");
  }
  const copy = cloneShallow(root);
  const [head, ...rest] = path;
  if (Array.isArray(copy)) {
    if (typeof head !== "number" || head < 0 || head >= copy.length) {
      throw new Error(`Array index out of range: ${String(head)}`);
    }
    copy[head] = setAtPath(copy[head], rest, value);
  } else {
    if (typeof head !== "string" || !hasOwn(copy, head)) {
      throw new Error(`No such key: ${String(head)}`);
    }
    setOwn(copy, head, setAtPath(copy[head], rest, value));
  }
  return copy;
}

/** Delete the entry at `path` (array element or object key). */
export function deleteAtPath(root: JsonValue, path: JsonPathSegments): JsonValue {
  if (path.length === 0) throw new Error("Cannot delete the root");
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1];
  const parent = getAtPath(root, parentPath);
  if (parent === undefined || !isContainer(parent)) {
    throw new Error("Parent not found");
  }
  const copy = cloneShallow(parent);
  if (Array.isArray(copy)) {
    if (typeof last !== "number" || last < 0 || last >= copy.length) {
      throw new Error(`Array index out of range: ${String(last)}`);
    }
    copy.splice(last, 1);
  } else {
    if (typeof last !== "string" || !hasOwn(copy, last)) {
      throw new Error(`No such key: ${String(last)}`);
    }
    delete copy[last];
  }
  return setAtPath(root, parentPath, copy);
}

/**
 * Rename an object key in place, preserving the key order of the object.
 * Fails when the new key already exists (never silently overwrites).
 */
export function renameKey(
  root: JsonValue,
  parentPath: JsonPathSegments,
  oldKey: string,
  newKey: string,
): JsonValue {
  if (oldKey === newKey) return root;
  const parent = getAtPath(root, parentPath);
  if (parent === undefined || parent === null || typeof parent !== "object" || Array.isArray(parent)) {
    throw new Error("Parent is not an object");
  }
  if (!hasOwn(parent, oldKey)) throw new Error(`No such key: ${oldKey}`);
  if (hasOwn(parent, newKey)) throw new Error(`Key already exists: ${newKey}`);
  const renamed: { [k: string]: JsonValue } = {};
  for (const key of Object.keys(parent)) {
    setOwn(renamed, key === oldKey ? newKey : key, parent[key]);
  }
  return setAtPath(root, parentPath, renamed);
}

/**
 * Insert a new child into the container at `path`. For objects `key` is
 * required and must be free; for arrays the value is appended (or inserted
 * at `index` when given).
 */
export function insertChild(
  root: JsonValue,
  path: JsonPathSegments,
  value: JsonValue,
  options: { key?: string; index?: number } = {},
): JsonValue {
  const container = getAtPath(root, path);
  if (container === undefined || !isContainer(container)) {
    throw new Error("Target is not an object or array");
  }
  const copy = cloneShallow(container);
  if (Array.isArray(copy)) {
    const index = options.index ?? copy.length;
    if (index < 0 || index > copy.length) throw new Error("Index out of range");
    copy.splice(index, 0, value);
  } else {
    const key = options.key;
    if (!key) throw new Error("Object entries need a key");
    if (hasOwn(copy, key)) throw new Error(`Key already exists: ${key}`);
    setOwn(copy, key, value);
  }
  return setAtPath(root, path, copy);
}

/**
 * Parse the text a user typed into a tree-cell into a JSON value: valid JSON
 * is taken as-is ("42", "true", "\"hi\"", "{...}"), anything else becomes a
 * plain string — matching how spreadsheet-style editors behave.
 */
export function coerceScalarInput(text: string): JsonValue {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return text;
  }
}
