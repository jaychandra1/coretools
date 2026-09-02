import { describe, it, expect } from "vitest";
import { inferSchema } from "./schema-infer";
import { compileSchema } from "./validate";
import type { JsonValue } from "./types";

describe("inferSchema", () => {
  it("infers scalars, formats and integer vs number", () => {
    const schema = inferSchema({
      name: "alice",
      email: "a@example.com",
      joined: "2024-01-15T10:30:00Z",
      age: 30,
      score: 1.5,
      active: true,
      note: null,
    }) as never as Record<string, never>;

    const properties = schema["properties"] as Record<string, { type?: string; format?: string }>;
    expect(properties.name).toEqual({ type: "string" });
    expect(properties.email.format).toBe("email");
    expect(properties.joined.format).toBe("date-time");
    expect(properties.age.type).toBe("integer");
    expect(properties.score.type).toBe("number");
    expect(properties.active.type).toBe("boolean");
    expect(properties.note.type).toBe("null");
  });

  it("merges array items: shared keys required, extras optional", () => {
    const schema = inferSchema([
      { id: 1, name: "a", extra: true },
      { id: 2, name: "b" },
    ]) as never as { items: { required: string[]; properties: Record<string, unknown> } };
    expect(schema.items.required.sort()).toEqual(["id", "name"]);
    expect(Object.keys(schema.items.properties).sort()).toEqual(["extra", "id", "name"]);
  });

  it("unions differing item types via anyOf and widens int+float", () => {
    const mixed = inferSchema([1, "x"]) as never as { items: { anyOf: unknown[] } };
    expect(mixed.items.anyOf).toHaveLength(2);

    const widened = inferSchema([1, 1.5]) as never as { items: { type: string } };
    expect(widened.items.type).toBe("number");
  });

  it("produces a schema the validator accepts for the source document", () => {
    const doc: JsonValue = {
      users: [
        { id: 1, name: "a", roles: ["x"] },
        { id: 2, name: "b", roles: [] },
      ],
      total: 2,
    };
    const compiled = compileSchema(JSON.stringify(inferSchema(doc)));
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.value.validate(doc)).toEqual([]);
      // and it actually constrains: wrong type must fail
      expect(compiled.value.validate({ users: "nope", total: 2 }).length).toBeGreaterThan(0);
    }
  });
});
