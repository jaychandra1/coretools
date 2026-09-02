import { describe, it, expect } from "vitest";
import { runJmesPath, runJsonPath } from "./query";
import type { JsonValue } from "./types";

const STORE: JsonValue = {
  store: {
    book: [
      { category: "fiction", title: "Sayings", price: 8.95 },
      { category: "fiction", title: "Moby Dick", price: 12.99 },
      { category: "reference", title: "Atlas", price: 22.5 },
    ],
    bicycle: { color: "red", price: 19.95 },
  },
};

describe("runJsonPath", () => {
  it("selects with wildcards", () => {
    const result = runJsonPath(STORE, "$.store.book[*].title");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.matches.map((m) => m.value)).toEqual([
        "Sayings",
        "Moby Dick",
        "Atlas",
      ]);
      expect(result.value.matches[0].pointer).toBe("/store/book/0/title");
    }
  });

  it("supports filter expressions through the safe evaluator (no eval)", () => {
    const result = runJsonPath(STORE, "$..book[?(@.price < 10)].title");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.matches.map((m) => m.value)).toEqual(["Sayings"]);
  });

  it("supports recursive descent", () => {
    const result = runJsonPath(STORE, "$..price");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.matches).toHaveLength(4);
  });

  it("returns an empty match list, not an error, for no hits", () => {
    const result = runJsonPath(STORE, "$.missing[*]");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.matches).toEqual([]);
  });

  it("rejects empty expressions", () => {
    expect(runJsonPath(STORE, "  ").ok).toBe(false);
  });
});

describe("runJmesPath", () => {
  it("projects and filters", () => {
    const result = runJmesPath(STORE, "store.book[?price < `10`].title");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.single).toEqual(["Sayings"]);
  });

  it("builds objects", () => {
    const result = runJmesPath(STORE, "{count: length(store.book), color: store.bicycle.color}");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.single).toEqual({ count: 3, color: "red" });
  });

  it("surfaces syntax errors", () => {
    const result = runJmesPath(STORE, "store.[");
    expect(result.ok).toBe(false);
  });
});
