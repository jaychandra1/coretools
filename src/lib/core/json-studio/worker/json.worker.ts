/**
 * Web Worker for large-document operations: parsing, formatting, minifying,
 * stats and schema inference run off the main thread so a 50 MB paste never
 * freezes the UI. Bundled by Vite as a same-origin module worker — no blob:
 * URLs, no CSP exceptions.
 *
 * Protocol: `{ id, op, payload }` in, `{ id, ok, value | error }` out.
 * Only structured-cloneable data crosses the boundary.
 */

import { parseJson, formatJson, minifyJson, sortKeysDeep } from "../parse";
import { computeStats } from "../stats";
import { inferSchema } from "../schema-infer";
import type { JsonValue } from "../types";

export type WorkerOp =
  | { op: "parse"; text: string }
  | { op: "format"; text: string; indent: number | "\t" }
  | { op: "minify"; text: string }
  | { op: "sortKeys"; text: string; indent: number | "\t" }
  | { op: "stats"; text: string }
  | { op: "inferSchema"; text: string };

export interface WorkerRequest {
  id: number;
  request: WorkerOp;
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Pure dispatch — exported so the main-thread fallback runs identical code. */
export function runOp(request: WorkerOp): unknown {
  switch (request.op) {
    case "parse": {
      const result = parseJson(request.text);
      // The parsed value itself stays in the worker; the caller only needs
      // validity + error coordinates. Cloning a 50 MB tree helps nobody.
      return result.ok
        ? { ok: true }
        : { ok: false, error: result.error };
    }
    case "format":
      return formatJson(request.text, request.indent);
    case "minify":
      return minifyJson(request.text);
    case "sortKeys": {
      const parsed = parseJson(request.text);
      if (!parsed.ok) throw new Error(parsed.error.message);
      return JSON.stringify(sortKeysDeep(parsed.value), null, request.indent);
    }
    case "stats": {
      const parsed = parseJson(request.text);
      if (!parsed.ok) throw new Error(parsed.error.message);
      return computeStats(parsed.value);
    }
    case "inferSchema": {
      const parsed = parseJson(request.text);
      if (!parsed.ok) throw new Error(parsed.error.message);
      return JSON.stringify(inferSchema(parsed.value as JsonValue), null, 2);
    }
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const { id, request } = event.data;
  try {
    const value = runOp(request);
    self.postMessage({ id, ok: true, value } satisfies WorkerResponse);
  } catch (e) {
    self.postMessage({
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    } satisfies WorkerResponse);
  }
});
