import { describe, it, expect } from "vitest";
import { diffJson, summarizeDiff } from "./json-diff";

describe("diffJson", () => {
  it("reports identical documents as empty", () => {
    const value = { a: [1, { b: null }], c: "x" };
    expect(diffJson(value, JSON.parse(JSON.stringify(value)))).toEqual([]);
  });

  it("detects changed scalars with pointer paths", () => {
    const entries = diffJson({ a: { b: 1 } }, { a: { b: 2 } });
    expect(entries).toEqual([{ path: "/a/b", kind: "changed", left: 1, right: 2 }]);
  });

  it("detects added and removed keys", () => {
    const entries = diffJson({ a: 1, gone: true }, { a: 1, fresh: "x" });
    expect(entries).toContainEqual({ path: "/gone", kind: "removed", left: true });
    expect(entries).toContainEqual({ path: "/fresh", kind: "added", right: "x" });
  });

  it("diffs arrays by index, including length changes", () => {
    const entries = diffJson([1, 2, 3], [1, 9]);
    expect(entries).toContainEqual({ path: "/1", kind: "changed", left: 2, right: 9 });
    expect(entries).toContainEqual({ path: "/2", kind: "removed", left: 3 });
  });

  it("treats type changes as a single change at that path", () => {
    const entries = diffJson({ a: { deep: 1 } }, { a: [1] });
    expect(entries).toEqual([
      { path: "/a", kind: "changed", left: { deep: 1 }, right: [1] },
    ]);
  });

  it("escapes special characters in pointers", () => {
    const entries = diffJson({ "a/b": 1 }, { "a/b": 2 });
    expect(entries[0].path).toBe("/a~1b");
  });

  it("distinguishes 0 from false and null from absent", () => {
    expect(diffJson({ a: 0 }, { a: false })).toHaveLength(1);
    expect(diffJson({ a: null }, {})).toEqual([
      { path: "/a", kind: "removed", left: null },
    ]);
  });
});

describe("summarizeDiff", () => {
  it("counts by kind", () => {
    const entries = diffJson({ a: 1, b: 2 }, { a: 9, c: 3 });
    const summary = summarizeDiff(entries);
    expect(summary).toEqual({ added: 1, removed: 1, changed: 1, identical: false });
    expect(summarizeDiff([]).identical).toBe(true);
  });
});
