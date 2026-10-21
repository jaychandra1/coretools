import { describe, expect, it } from "vitest";
import { getAtPath, insertChild, renameKey } from "./json-studio/tree-edit";
import { csvToJson } from "./json-studio/convert/csv";
import { sortKeysDeep } from "./json-studio/parse";
import type { JsonValue } from "./json-studio/types";

describe("document keys named like built-ins stay ordinary data", () => {
  it("adds, finds and renames a key called __proto__ or constructor", () => {
    let doc: JsonValue = {};
    doc = insertChild(doc, [], JSON.parse('"x"'), { key: "constructor" });
    doc = insertChild(doc, [], 1, { key: "__proto__" });
    expect(Object.keys(doc as object)).toEqual(["constructor", "__proto__"]);
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype); // not replaced
    expect(getAtPath(doc, ["__proto__"])).toBe(1);
    expect(getAtPath({}, ["toString"])).toBeUndefined(); // inherited isn't "present"
    doc = renameKey(doc, [], "__proto__", "proto");
    expect(doc).toEqual({ constructor: "x", proto: 1 });
  });

  it("keeps a CSV column named __proto__", () => {
    const result = csvToJson("__proto__,name\n1,a");
    expect(result.ok && JSON.stringify(result.value)).toBe('[{"__proto__":1,"name":"a"}]');
  });

  it("keeps __proto__ when sorting keys", () => {
    const sorted = sortKeysDeep(JSON.parse('{"b":1,"__proto__":{"x":1}}'));
    expect(JSON.stringify(sorted)).toBe('{"__proto__":{"x":1},"b":1}');
  });
});
