/**
 * The page's side of the writing checker: hands text to the worker
 * (checker.worker.ts) and returns its issues. Only the newest check counts —
 * an older one still running resolves to null.
 */

import type { DialectId } from "../core/writing/dialects";
import type { Issue } from "../core/writing/issues";
import type { CheckRequest, CheckResponse } from "./protocol";

interface Pending {
  resolve: (issues: Issue[] | null) => void;
  reject: (error: Error) => void;
}

export class WritingChecker {
  #worker: Worker | null = null;
  #next = 1;
  #pending = new Map<number, Pending>();

  #start(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL("./checker.worker.ts", import.meta.url), {
      type: "module",
      name: "writing-checker",
    });
    worker.onmessage = (event: MessageEvent<CheckResponse>) => {
      const response = event.data;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if ("issues" in response) pending.resolve(response.issues);
      else if ("skipped" in response) pending.resolve(null);
      else pending.reject(new Error(response.error));
    };
    // The script or the engine couldn't load: fail what's waiting, and start
    // afresh on the next check.
    worker.onerror = (event) => {
      event.preventDefault();
      this.#fail(new Error(event.message || "The checker couldn't start."));
    };
    this.#worker = worker;
    return worker;
  }

  #fail(error: Error): void {
    this.#worker?.terminate();
    this.#worker = null;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  /** Issues in `text`; null when a newer check replaced this one. */
  check(text: string, dialect: DialectId, words: readonly string[]): Promise<Issue[] | null> {
    const id = this.#next++;
    // Older checks still waiting are moot now.
    for (const [older, pending] of this.#pending) {
      pending.resolve(null);
      this.#pending.delete(older);
    }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        const request: CheckRequest = { id, text, dialect, words: [...words] };
        this.#start().postMessage(request);
      } catch (e) {
        this.#pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  dispose(): void {
    this.#fail(new Error("closed"));
  }
}
