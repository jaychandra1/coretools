/**
 * Main-thread client for the JSON worker.
 *
 * Documents above LARGE_DOC_CHARS are processed in the worker; smaller ones
 * run inline (message-passing overhead beats them). When Workers are
 * unavailable (unit tests, exotic webviews) everything transparently falls
 * back to the same code on the main thread — behaviour is identical, only
 * responsiveness differs.
 */

import { runOp, type WorkerOp, type WorkerResponse } from "./json.worker";

/** Above this many characters, work moves off the main thread. */
export const LARGE_DOC_CHARS = 1_000_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./json.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data.value);
      else entry.reject(new Error(event.data.error ?? "Worker operation failed"));
    });
    worker.addEventListener("error", () => {
      // Fail every in-flight call and stop using the worker; callers retry
      // inline via runInline. Better slow than dead.
      workerBroken = true;
      for (const entry of pending.values()) {
        entry.reject(new Error("Worker crashed"));
      }
      pending.clear();
      worker?.terminate();
      worker = null;
    });
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

function runInWorker(request: WorkerOp): Promise<unknown> {
  const w = getWorker();
  if (!w) return Promise.resolve(runOp(request));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, request });
  });
}

async function run(request: WorkerOp, textLength: number): Promise<unknown> {
  if (textLength >= LARGE_DOC_CHARS) {
    try {
      return await runInWorker(request);
    } catch (e) {
      if (e instanceof Error && e.message === "Worker crashed") {
        return runOp(request); // one inline retry after a worker loss
      }
      throw e;
    }
  }
  return runOp(request);
}

// Typed façade -------------------------------------------------------------

import type { ParseError } from "../types";
import type { JsonStats } from "../stats";

export function checkSyntax(
  text: string,
): Promise<{ ok: true } | { ok: false; error: ParseError }> {
  return run({ op: "parse", text }, text.length) as never;
}

export function formatText(text: string, indent: number | "\t"): Promise<string> {
  return run({ op: "format", text, indent }, text.length) as Promise<string>;
}

export function minifyText(text: string): Promise<string> {
  return run({ op: "minify", text }, text.length) as Promise<string>;
}

export function sortKeysText(text: string, indent: number | "\t"): Promise<string> {
  return run({ op: "sortKeys", text, indent }, text.length) as Promise<string>;
}

export function statsForText(text: string): Promise<JsonStats> {
  return run({ op: "stats", text }, text.length) as Promise<JsonStats>;
}

export function inferSchemaForText(text: string): Promise<string> {
  return run({ op: "inferSchema", text }, text.length) as Promise<string>;
}
