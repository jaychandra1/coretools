import { describe, it, expect } from "vitest";
import { moveOnto, moveTo, sortByOrder } from "./order";

const login = (id: string, platform: string) => ({ id, platform });
const logins = [login("g", "GitHub"), login("a", "AWS"), login("c", "Cloudflare"), login("d", "Discord")];
const ids = (items: { id: string }[]) => items.map((c) => c.id);

describe("your own login order", () => {
  it("is A–Z until you set one", () => {
    expect(ids(sortByOrder(logins, []))).toEqual(["a", "c", "d", "g"]);
  });

  it("follows the saved order, then lists the rest A–Z (new or restored logins)", () => {
    expect(ids(sortByOrder(logins, ["d", "g", "gone"]))).toEqual(["d", "g", "a", "c"]);
  });

  it("drops a login onto another: after it moving down, before it moving up", () => {
    const order = ["a", "b", "c", "d"];
    expect(moveOnto(order, "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(moveOnto(order, "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveOnto(order, "b", "b")).toEqual(order);
    expect(moveOnto(order, "b", "missing")).toEqual(order);
  });

  it("reorders inside a space without moving logins of other spaces", () => {
    // Full order a b c d e; the space shows b, d, e. Moving e above d:
    expect(moveOnto(["a", "b", "c", "d", "e"], "e", "d")).toEqual(["a", "b", "c", "e", "d"]);
  });

  it("moves to a position, clamped", () => {
    expect(moveTo(["a", "b", "c"], "c", -5)).toEqual(["c", "a", "b"]);
    expect(moveTo(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
  });
});
