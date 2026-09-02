/**
 * Shared types for JSON Studio.
 *
 * Everything in `src/lib/core/json-studio` is pure TypeScript: no DOM, no
 * Svelte, no I/O (the two exceptions, `db.ts` and `worker/`, are the storage
 * and threading boundaries and say so at the top of their files).
 */

/** A JSON value after parsing. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Discriminated result used across the core modules. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** A parse failure with editor-addressable coordinates. */
export interface ParseError {
  message: string;
  /** 1-based line of the failure, best effort. */
  line: number;
  /** 1-based column of the failure, best effort. */
  column: number;
  /** 0-based character offset, best effort. */
  position: number;
}

export type ParseResult =
  | { ok: true; value: JsonValue }
  | { ok: false; error: ParseError };

/** One message from schema/OpenAPI validation. */
export interface ValidationMessage {
  /** JSON Pointer-ish path ("/users/0/name"), "" for the root. */
  path: string;
  message: string;
  /** Rule or keyword that produced the message. */
  keyword: string;
}

/** One entry of the semantic (structural) diff. */
export interface DiffEntry {
  /** JSON Pointer of the affected location. */
  path: string;
  kind: "added" | "removed" | "changed";
  left?: JsonValue;
  right?: JsonValue;
}

/** Node type labels used by the tree view and stats. */
export type JsonType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null";

export function jsonTypeOf(value: JsonValue): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as "object" | "string" | "number" | "boolean";
}

/** Path into a JSON document: object keys and array indices. */
export type JsonPathSegments = Array<string | number>;

/** Render segments as a JSON Pointer (RFC 6901). */
export function toPointer(segments: JsonPathSegments): string {
  if (segments.length === 0) return "";
  return (
    "/" +
    segments
      .map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1"))
      .join("/")
  );
}
