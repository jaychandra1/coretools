/**
 * Pure, dependency-light line-diff and two-way merge engine.
 *
 * This module is completely framework- and platform-agnostic. It takes two
 * strings, produces a structured diff, and can rebuild a merged string from a
 * per-change selection. No I/O, no side effects — which makes it trivial to
 * unit-test and safe to run entirely in-memory.
 */

import { diffLines } from "diff";

/** Which side of a change to keep in the merged output. */
export type ChangeSide = "a" | "b";

/** A run of lines that is identical in both inputs. */
export interface EqualBlock {
  type: "equal";
  lines: string[];
}

/**
 * A region that differs between the two inputs. `aLines` come from the original
 * (left) file, `bLines` from the modified (right) file. Either may be empty
 * (a pure insertion or deletion).
 */
export interface ChangeBlock {
  type: "change";
  id: number;
  aLines: string[];
  bLines: string[];
}

export type DiffBlock = EqualBlock | ChangeBlock;

/** Per-change decision map, keyed by `ChangeBlock.id`. */
export type Selection = Record<number, ChangeSide>;

/**
 * Split a diff chunk into individual lines without inventing a trailing empty
 * line for the terminating newline that `diffLines` includes.
 */
function splitLines(value: string): string[] {
  if (value === "") return [];
  const body = value.endsWith("\n") ? value.slice(0, -1) : value;
  return body.split("\n");
}

/**
 * Compute a line-oriented, two-way diff between `a` (original) and `b`
 * (modified). Consecutive removed/added regions are coalesced into a single
 * {@link ChangeBlock} so the UI can present one decision per logical change.
 */
/** Comparing stops after this long: two huge, wholly different files would hang the UI (L7). */
export const DIFF_TIMEOUT_MS = 8000;

export function computeDiff(a: string, b: string): DiffBlock[] {
  const parts = diffLines(a, b, { timeout: DIFF_TIMEOUT_MS });
  if (!parts) {
    throw new Error("These files are too different to compare quickly. Compare smaller sections instead.");
  }
  const blocks: DiffBlock[] = [];
  let changeId = 0;

  let pendingA: string[] = [];
  let pendingB: string[] = [];

  const flushChange = () => {
    if (pendingA.length || pendingB.length) {
      blocks.push({
        type: "change",
        id: changeId++,
        aLines: pendingA,
        bLines: pendingB,
      });
      pendingA = [];
      pendingB = [];
    }
  };

  for (const part of parts) {
    const lines = splitLines(part.value);
    if (part.added) {
      pendingB.push(...lines);
    } else if (part.removed) {
      pendingA.push(...lines);
    } else {
      flushChange();
      if (lines.length) blocks.push({ type: "equal", lines });
    }
  }
  flushChange();

  return blocks;
}

/**
 * Default merge decision: accept every change (prefer the modified file). This
 * is the least-surprising starting point for a "keep my new edits" workflow.
 */
export function defaultSelection(blocks: DiffBlock[]): Selection {
  const selection: Selection = {};
  for (const block of blocks) {
    if (block.type === "change") selection[block.id] = "b";
  }
  return selection;
}

/**
 * Rebuild a single output string from the diff and a per-change selection.
 * Equal blocks are always kept; each change contributes either its original or
 * modified lines depending on the selection (defaulting to the modified side).
 */
export function mergeSelected(blocks: DiffBlock[], selection: Selection): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "equal") {
      out.push(...block.lines);
    } else {
      const side = selection[block.id] ?? "b";
      out.push(...(side === "a" ? block.aLines : block.bLines));
    }
  }
  return out.length ? out.join("\n") + "\n" : "";
}

export interface DiffStats {
  changes: number;
  added: number;
  removed: number;
}

/** Summary counts for display in the UI. */
export function diffStats(blocks: DiffBlock[]): DiffStats {
  let changes = 0;
  let added = 0;
  let removed = 0;
  for (const block of blocks) {
    if (block.type === "change") {
      changes++;
      added += block.bLines.length;
      removed += block.aLines.length;
    }
  }
  return { changes, added, removed };
}
