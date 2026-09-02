import { describe, it, expect } from "vitest";
import { repairJson } from "./repair";
import { parseJson } from "./parse";

describe("repairJson", () => {
  it("passes valid JSON through untouched", () => {
    const result = repairJson('{"a": 1}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.alreadyValid).toBe(true);
      expect(result.value.repaired).toBe('{"a": 1}');
    }
  });

  const broken: Array<[string, string]> = [
    ["single quotes", "{'name': 'alice'}"],
    ["unquoted keys", "{name: \"alice\"}"],
    ["trailing commas", '{"a": [1, 2,],}'],
    ["python literals", '{"ok": True, "missing": None}'],
    ["comments", '{\n  // count\n  "a": 1\n}'],
    ["missing closing brace", '{"a": {"b": 1}'],
  ];

  for (const [label, input] of broken) {
    it(`repairs ${label}`, () => {
      const result = repairJson(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.alreadyValid).toBe(false);
        expect(parseJson(result.value.repaired).ok).toBe(true);
      }
    });
  }

  it("repaired output preserves the data", () => {
    const result = repairJson("{name: 'alice', age: 30,}");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.value.repaired)).toEqual({ name: "alice", age: 30 });
    }
  });

  it("rejects empty input", () => {
    expect(repairJson("   ").ok).toBe(false);
  });
});
