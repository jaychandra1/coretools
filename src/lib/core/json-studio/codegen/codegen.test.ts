import { describe, it, expect } from "vitest";
import { buildModel, pascalCase } from "./model";
import { generateCode } from "./emitters";
import type { JsonValue } from "./../types";

const SAMPLE: JsonValue = {
  id: 12,
  full_name: "Alice",
  score: 1.5,
  active: true,
  address: { city: "Oslo", zip: "0150" },
  orders: [
    { sku: "a-1", qty: 2, gift: true },
    { sku: "b-2", qty: 1 },
  ],
};

describe("buildModel", () => {
  it("names nested types from their keys and merges array elements", () => {
    const model = buildModel(SAMPLE, "Customer");
    const names = model.defs.map((d) => d.name);
    expect(names).toContain("Customer");
    expect(names).toContain("Address");
    expect(names).toContain("Order"); // singularized from "orders"

    const order = model.defs.find((d) => d.name === "Order")!;
    const gift = order.fields.find((f) => f.key === "gift")!;
    expect(gift.optional).toBe(true); // absent from the 2nd element
    const sku = order.fields.find((f) => f.key === "sku")!;
    expect(sku.optional).toBe(false);
  });

  it("widens integer + float and unions mixed types", () => {
    const model = buildModel([{ v: 1 }, { v: 2.5 }], "Row");
    const v = model.defs[0].fields[0];
    expect(v.type).toEqual({ kind: "primitive", name: "number" });

    const mixed = buildModel([{ v: 1 }, { v: "x" }], "Row");
    expect(mixed.defs[0].fields[0].type.kind).toBe("union");
  });

  it("pascalCase handles separators, camelCase and leading digits", () => {
    expect(pascalCase("user_accounts")).toBe("UserAccounts");
    expect(pascalCase("user-account")).toBe("UserAccount");
    expect(pascalCase("innerHTML")).toBe("InnerHTML");
    expect(pascalCase("123abc")).toBe("Abc");
  });
});

describe("generateCode", () => {
  it("TypeScript: interfaces with optional markers and quoted odd keys", () => {
    const code = generateCode(SAMPLE, "typescript", "Customer");
    expect(code).toContain("export interface Customer {");
    expect(code).toContain("full_name: string;");
    expect(code).toContain("orders: Order[];");
    expect(code).toContain("gift?: boolean;");

    const odd = generateCode({ "weird key!": 1 }, "typescript", "X");
    expect(odd).toContain('"weird key!": number;');
  });

  it("TypeScript: non-object roots get a type alias", () => {
    const code = generateCode([1, 2], "typescript", "Numbers");
    expect(code).toContain("export type Numbers = number[];");
  });

  it("C#: JsonPropertyName attributes and nullable optionals", () => {
    const code = generateCode(SAMPLE, "csharp", "Customer");
    expect(code).toContain('[JsonPropertyName("full_name")]');
    expect(code).toContain("public string FullName { get; set; }");
    expect(code).toContain("public List<Order> Orders { get; set; }");
    expect(code).toContain("public bool? Gift { get; set; }");
    expect(code).toContain("public long Id { get; set; }");
    expect(code).toContain("public double Score { get; set; }");
  });

  it("Java: Jackson annotations, boxed optionals, getters/setters", () => {
    const code = generateCode(SAMPLE, "java", "Customer");
    expect(code).toContain('@JsonProperty("full_name")');
    expect(code).toContain("private String fullName;");
    expect(code).toContain("private Boolean gift;"); // optional -> boxed
    expect(code).toContain("private long id;"); // required -> primitive
    expect(code).toContain("public String getFullName()");
    expect(code).toContain("public void setFullName(String value)");
  });

  it("Python: dataclasses, snake_case with JSON-key comments, defaults last", () => {
    const code = generateCode(SAMPLE, "python", "Customer");
    expect(code).toContain("@dataclass");
    expect(code).toContain("class Customer:");
    expect(code).toContain("full_name: str");
    expect(code).toContain("gift: bool | None = None");
    // required fields must precede defaulted ones inside Order
    const order = code.slice(code.indexOf("class Order:"));
    expect(order.indexOf("sku: str")).toBeLessThan(order.indexOf("gift:"));

    const renamed = generateCode({ fullName: 1 }, "python", "X");
    expect(renamed).toContain('full_name: int  # JSON key: "fullName"');
  });

  it("Go: structs with json tags, omitempty pointers for optionals", () => {
    const code = generateCode(SAMPLE, "go", "Customer");
    expect(code).toContain("type Customer struct {");
    expect(code).toContain('FullName string `json:"full_name"`');
    expect(code).toContain('Orders []Order `json:"orders"`');
    expect(code).toContain('Gift *bool `json:"gift,omitempty"`');
  });

  it("every language emits for a scalar root without crashing", () => {
    for (const lang of ["typescript", "csharp", "java", "python", "go"] as const) {
      const code = generateCode("hello", lang, "Value");
      expect(code.length).toBeGreaterThan(0);
    }
  });
});
