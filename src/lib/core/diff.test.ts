import { describe, it, expect } from "vitest";
import {
  computeDiff,
  defaultSelection,
  mergeSelected,
  diffStats,
  type ChangeBlock,
} from "./diff";

describe("computeDiff", () => {
  it("returns a single equal block for identical inputs", () => {
    const blocks = computeDiff("a\nb\nc\n", "a\nb\nc\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "equal", lines: ["a", "b", "c"] });
  });

  it("detects a modified line as one change block", () => {
    const blocks = computeDiff("a\nb\nc\n", "a\nB\nc\n");
    const changes = blocks.filter((b) => b.type === "change") as ChangeBlock[];
    expect(changes).toHaveLength(1);
    expect(changes[0].aLines).toEqual(["b"]);
    expect(changes[0].bLines).toEqual(["B"]);
  });

  it("represents a pure insertion with empty aLines", () => {
    const blocks = computeDiff("a\nc\n", "a\nb\nc\n");
    const change = blocks.find((b) => b.type === "change") as ChangeBlock;
    expect(change.aLines).toEqual([]);
    expect(change.bLines).toEqual(["b"]);
  });

  it("assigns unique, incrementing ids to change blocks", () => {
    const blocks = computeDiff("a\nb\nc\nd\n", "A\nb\nC\nd\n");
    const ids = (blocks.filter((b) => b.type === "change") as ChangeBlock[]).map(
      (b) => b.id,
    );
    expect(ids).toEqual([0, 1]);
  });
});

describe("mergeSelected", () => {
  const original = "keep\nold\nkeep2\n";
  const modified = "keep\nnew\nkeep2\n";

  it("prefers the modified side by default", () => {
    const blocks = computeDiff(original, modified);
    const merged = mergeSelected(blocks, defaultSelection(blocks));
    expect(merged).toBe("keep\nnew\nkeep2\n");
  });

  it("keeps the original side when selection is 'a'", () => {
    const blocks = computeDiff(original, modified);
    const change = blocks.find((b) => b.type === "change") as ChangeBlock;
    const merged = mergeSelected(blocks, { [change.id]: "a" });
    expect(merged).toBe("keep\nold\nkeep2\n");
  });

  it("merges a mix of accepted and rejected changes", () => {
    const a = "l1\nl2\nl3\nl4\n";
    const b = "L1\nl2\nL3\nl4\n";
    const blocks = computeDiff(a, b);
    const changes = blocks.filter((x) => x.type === "change") as ChangeBlock[];
    // accept the first change (L1), reject the second (keep l3)
    const merged = mergeSelected(blocks, {
      [changes[0].id]: "b",
      [changes[1].id]: "a",
    });
    expect(merged).toBe("L1\nl2\nl3\nl4\n");
  });

  it("returns an empty string for two empty inputs", () => {
    const blocks = computeDiff("", "");
    expect(mergeSelected(blocks, {})).toBe("");
  });
});

describe("diffStats", () => {
  it("counts changes and line deltas", () => {
    const blocks = computeDiff("a\nb\n", "a\nB\nc\n");
    const stats = diffStats(blocks);
    expect(stats.changes).toBe(1);
    expect(stats.added).toBe(2); // B, c
    expect(stats.removed).toBe(1); // b
  });
});
