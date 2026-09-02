import { describe, it, expect } from "vitest";
import {
  coerceScalarInput,
  deleteAtPath,
  getAtPath,
  insertChild,
  renameKey,
  setAtPath,
} from "./tree-edit";
import type { JsonValue } from "./types";

const doc: JsonValue = {
  user: { name: "alice", tags: ["a", "b"] },
  count: 2,
};

describe("getAtPath", () => {
  it("resolves nested paths", () => {
    expect(getAtPath(doc, ["user", "name"])).toBe("alice");
    expect(getAtPath(doc, ["user", "tags", 1])).toBe("b");
    expect(getAtPath(doc, [])).toBe(doc);
  });

  it("returns undefined for missing paths", () => {
    expect(getAtPath(doc, ["nope"])).toBeUndefined();
    expect(getAtPath(doc, ["user", "tags", 9])).toBeUndefined();
    expect(getAtPath(doc, ["count", "x"])).toBeUndefined();
  });
});

describe("setAtPath", () => {
  it("replaces without mutating the original", () => {
    const next = setAtPath(doc, ["user", "name"], "bob");
    expect(getAtPath(next, ["user", "name"])).toBe("bob");
    expect(getAtPath(doc, ["user", "name"])).toBe("alice");
    // untouched branches share structure
    expect(getAtPath(next, ["user", "tags"])).toBe(getAtPath(doc, ["user", "tags"]));
  });

  it("replaces the root when the path is empty", () => {
    expect(setAtPath(doc, [], null)).toBeNull();
  });

  it("rejects bad paths", () => {
    expect(() => setAtPath(doc, ["missing", "x"], 1)).toThrow(/No such key/);
    expect(() => setAtPath(doc, ["user", "tags", 5], 1)).toThrow(/out of range/);
  });
});

describe("deleteAtPath", () => {
  it("removes object keys and array items", () => {
    expect(deleteAtPath(doc, ["count"])).toEqual({ user: { name: "alice", tags: ["a", "b"] } });
    expect(getAtPath(deleteAtPath(doc, ["user", "tags", 0]), ["user", "tags"])).toEqual(["b"]);
  });

  it("refuses to delete the root", () => {
    expect(() => deleteAtPath(doc, [])).toThrow(/root/);
  });
});

describe("renameKey", () => {
  it("renames preserving key order", () => {
    const next = renameKey(doc, [], "user", "account") as { [k: string]: JsonValue };
    expect(Object.keys(next)).toEqual(["account", "count"]);
  });

  it("never overwrites an existing key", () => {
    expect(() => renameKey(doc, [], "user", "count")).toThrow(/already exists/);
  });
});

describe("insertChild", () => {
  it("adds object entries and array items", () => {
    const withKey = insertChild(doc, ["user"], true, { key: "active" });
    expect(getAtPath(withKey, ["user", "active"])).toBe(true);

    const appended = insertChild(doc, ["user", "tags"], "c");
    expect(getAtPath(appended, ["user", "tags"])).toEqual(["a", "b", "c"]);

    const inserted = insertChild(doc, ["user", "tags"], "x", { index: 0 });
    expect(getAtPath(inserted, ["user", "tags"])).toEqual(["x", "a", "b"]);
  });

  it("requires a free key for objects", () => {
    expect(() => insertChild(doc, ["user"], 1, { key: "name" })).toThrow(/exists/);
    expect(() => insertChild(doc, ["user"], 1, {})).toThrow(/key/);
  });
});

describe("coerceScalarInput", () => {
  it("takes valid JSON as typed values, plain text as strings", () => {
    expect(coerceScalarInput("42")).toBe(42);
    expect(coerceScalarInput("true")).toBe(true);
    expect(coerceScalarInput("null")).toBeNull();
    expect(coerceScalarInput('"quoted"')).toBe("quoted");
    expect(coerceScalarInput("[1,2]")).toEqual([1, 2]);
    expect(coerceScalarInput("hello world")).toBe("hello world");
    expect(coerceScalarInput("")).toBe("");
  });
});
