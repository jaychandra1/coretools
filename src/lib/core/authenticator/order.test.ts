import { describe, it, expect } from "vitest";
import { displayOrder, moveInDisplayOrder, type Orderable } from "./order";

function e(id: string, index: number, pinned = false): Orderable {
  return { id, index, pinned };
}

/** Apply a move and return the resulting display order as ids. */
function moved(entries: Orderable[], from: string, to: string): string[] {
  const next = moveInDisplayOrder(entries, from, to);
  const applied = entries.map((x) => ({ ...x, index: next?.get(x.id) ?? x.index }));
  return displayOrder(applied).map((x) => x.id);
}

describe("displayOrder", () => {
  it("puts pinned entries first, then sorts by index", () => {
    const list = [e("a", 0), e("b", 1, true), e("c", 2), e("d", 3, true)];
    expect(displayOrder(list).map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("moveInDisplayOrder", () => {
  const plain = [e("a", 0), e("b", 1), e("c", 2), e("d", 3)];

  it("moves down: lands after the target", () => {
    expect(moved(plain, "a", "c")).toEqual(["b", "c", "a", "d"]);
  });

  it("moves up: lands before the target", () => {
    expect(moved(plain, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("works on what's displayed when something is pinned", () => {
    // Displayed: c(pinned), a, b. Dropping b onto a must put b first among
    // the unpinned — the old array-position logic sent it elsewhere.
    const list = [e("a", 0), e("b", 1), e("c", 2, true)];
    expect(moved(list, "b", "a")).toEqual(["c", "b", "a"]);
  });

  it("reorders within the pinned group", () => {
    const list = [e("a", 0, true), e("b", 1, true), e("c", 2)];
    expect(moved(list, "b", "a")).toEqual(["b", "a", "c"]);
  });

  it("keeps pin state across the boundary (settles at the group edge)", () => {
    const list = [e("p", 0, true), e("a", 1), e("b", 2)];
    expect(moved(list, "b", "p")).toEqual(["p", "b", "a"]);
  });

  it("returns null for no-ops", () => {
    expect(moveInDisplayOrder(plain, "a", "a")).toBeNull();
    expect(moveInDisplayOrder(plain, "a", "missing")).toBeNull();
    // Dropping the only unpinned card onto a pinned one changes nothing.
    expect(moveInDisplayOrder([e("p", 0, true), e("a", 1)], "a", "p")).toBeNull();
  });

  it("assigns dense indexes", () => {
    const next = moveInDisplayOrder([e("a", 5), e("b", 9), e("c", 20)], "c", "a");
    expect([...(next?.values() ?? [])].sort()).toEqual([0, 1, 2]);
  });
});
