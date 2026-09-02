import { describe, it, expect } from "vitest";
import { compileSchema, detectDraft, validateAgainstSchema } from "./validate";

const PERSON_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["name", "age"],
  properties: {
    name: { type: "string", minLength: 1 },
    age: { type: "integer", minimum: 0 },
    tags: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
});

describe("compileSchema", () => {
  it("accepts valid documents", () => {
    const result = validateAgainstSchema(
      PERSON_SCHEMA,
      JSON.stringify({ name: "alice", age: 30, tags: ["a"] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.valid).toBe(true);
  });

  it("reports failures with JSON Pointer paths", () => {
    const result = validateAgainstSchema(
      PERSON_SCHEMA,
      JSON.stringify({ name: "", age: -1, tags: [1], bogus: true }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    const paths = result.value.messages.map((m) => m.path);
    expect(paths).toContain("/name");
    expect(paths).toContain("/age");
    expect(paths.some((p) => p.startsWith("/tags/0"))).toBe(true);
  });

  it("reports missing required properties", () => {
    const result = validateAgainstSchema(PERSON_SCHEMA, "{}");
    expect(result.ok && !result.value.valid).toBe(true);
    if (result.ok) {
      expect(result.value.messages.some((m) => /required/i.test(m.keyword))).toBe(true);
    }
  });

  it("rejects schema text that is not JSON or not a schema", () => {
    expect(compileSchema("not json").ok).toBe(false);
    expect(compileSchema("42").ok).toBe(false);
  });

  it("supports draft-07 schemas", () => {
    const draft7 = JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "array",
      items: { type: "number" },
    });
    const good = validateAgainstSchema(draft7, "[1, 2]");
    const bad = validateAgainstSchema(draft7, '["x"]');
    expect(good.ok && good.value.valid).toBe(true);
    expect(bad.ok && !bad.value.valid).toBe(true);
  });

  it("handles $ref within the schema", () => {
    const withRef = JSON.stringify({
      $defs: { positive: { type: "integer", minimum: 1 } },
      type: "object",
      properties: { count: { $ref: "#/$defs/positive" } },
    });
    const bad = validateAgainstSchema(withRef, JSON.stringify({ count: 0 }));
    expect(bad.ok && !bad.value.valid).toBe(true);
  });
});

describe("detectDraft", () => {
  it("maps $schema URIs", () => {
    expect(detectDraft({ $schema: "http://json-schema.org/draft-04/schema#" })).toBe("4");
    expect(detectDraft({ $schema: "http://json-schema.org/draft-07/schema#" })).toBe("7");
    expect(detectDraft({ $schema: "https://json-schema.org/draft/2019-09/schema" })).toBe("2019-09");
    expect(detectDraft({})).toBe("2020-12");
  });
});
