import { describe, it, expect } from "vitest";
import { computeStats } from "./stats";

describe("computeStats", () => {
  it("counts nodes, types, keys and depth", () => {
    const stats = computeStats({
      name: "a",
      nested: { flag: true, list: [1, 2.5, null] },
    });
    // root + name + nested + flag + list + 3 items = 8
    expect(stats.nodes).toBe(8);
    expect(stats.types.object).toBe(2);
    expect(stats.types.array).toBe(1);
    expect(stats.types.string).toBe(1);
    expect(stats.types.number).toBe(2);
    expect(stats.types.boolean).toBe(1);
    expect(stats.types.null).toBe(1);
    expect(stats.maxDepth).toBe(4); // root > nested > list > item
    expect(stats.totalKeys).toBe(4);
    expect(stats.distinctKeys).toBe(4);
  });

  it("tracks arrays, strings and numbers", () => {
    const stats = computeStats({
      words: ["hi", "world!"],
      values: [1, 2, 3, 4],
      pi: 3.14,
    });
    expect(stats.arrays).toEqual({ count: 2, maxLength: 4, totalItems: 6 });
    expect(stats.strings.count).toBe(2);
    expect(stats.strings.maxLength).toBe(6);
    expect(stats.numbers.min).toBe(1);
    expect(stats.numbers.max).toBe(4);
    expect(stats.numbers.integers).toBe(4);
    expect(stats.numbers.count).toBe(5);
  });

  it("ranks repeated keys", () => {
    const stats = computeStats([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3 },
    ]);
    expect(stats.topKeys[0]).toEqual({ key: "id", count: 3 });
    expect(stats.topKeys[1]).toEqual({ key: "name", count: 2 });
    expect(stats.distinctKeys).toBe(2);
    expect(stats.totalKeys).toBe(5);
  });

  it("survives very deep and very wide documents", () => {
    // 20k-element flat array: must not overflow the stack.
    const wide = computeStats(Array.from({ length: 20_000 }, (_, i) => i));
    expect(wide.nodes).toBe(20_001);

    let deep: unknown = 1;
    for (let i = 0; i < 5_000; i++) deep = { d: deep };
    const stats = computeStats(deep as never);
    expect(stats.maxDepth).toBe(5_001);
  });

  it("handles scalar roots", () => {
    const stats = computeStats("just a string");
    expect(stats.nodes).toBe(1);
    expect(stats.types.string).toBe(1);
    expect(stats.maxDepth).toBe(1);
  });
});
