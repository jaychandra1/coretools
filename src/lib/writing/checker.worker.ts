/// <reference lib="webworker" />
/**
 * Runs Harper off the page's thread, so checking never makes typing stutter.
 *
 * This is the app's own worker script, loaded from its own origin — Harper's
 * built-in WorkerLinter starts its worker from a blob: URL, which the
 * Content-Security-Policy (rightly) refuses. The WebAssembly engine is
 * fetched once from the app's own files; nothing leaves the device.
 */

import { LocalLinter } from "harper.js";
// The "slim" engine: one WebAssembly file (the "full" one loads two).
import { slimBinary } from "harper.js/slimBinary";
import type { DialectId } from "../core/writing/dialects";
import { harperDialect, lintText } from "../core/writing/harper-lints";
import type { CheckRequest, CheckResponse } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

let linter: LocalLinter | null = null;
let dialect: DialectId | null = null;
let words = "[]";
let latest = 0;
let queue: Promise<void> = Promise.resolve();

async function prepared(request: CheckRequest): Promise<LocalLinter> {
  if (!linter) {
    const created = new LocalLinter({ binary: slimBinary, dialect: harperDialect(request.dialect) });
    await created.setup();
    linter = created;
    dialect = request.dialect;
  }
  if (dialect !== request.dialect) {
    await linter.setDialect(harperDialect(request.dialect));
    dialect = request.dialect;
  }
  const requested = JSON.stringify(request.words);
  if (requested !== words) {
    await linter.clearWords();
    if (request.words.length) await linter.importWords(request.words);
    words = requested;
  }
  return linter;
}

async function handle(request: CheckRequest): Promise<void> {
  let response: CheckResponse;
  if (request.id < latest) {
    response = { id: request.id, skipped: true };
  } else {
    try {
      response = { id: request.id, issues: await lintText(await prepared(request), request.text) };
    } catch (e) {
      linter = null; // set up again on the next request
      response = { id: request.id, error: e instanceof Error ? e.message : String(e) };
    }
  }
  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<CheckRequest>) => {
  const request = event.data;
  latest = Math.max(latest, request.id);
  queue = queue.then(() => handle(request));
};
