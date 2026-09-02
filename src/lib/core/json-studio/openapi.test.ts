import { describe, it, expect } from "vitest";
import { detectOpenApi, validateOpenApi } from "./openapi";
import type { JsonValue } from "./types";

const VALID_30: JsonValue = {
  openapi: "3.0.3",
  info: { title: "Pets", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        responses: { "200": { description: "ok" } },
      },
    },
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
        },
      },
    },
  },
  components: { schemas: { Pet: { type: "object" } } },
};

describe("detectOpenApi", () => {
  it("recognizes openapi, swagger, and neither", () => {
    expect(detectOpenApi(VALID_30)).toEqual({ kind: "openapi", version: "3.0.3" });
    expect(detectOpenApi({ swagger: "2.0" })).toEqual({ kind: "swagger", version: "2.0" });
    expect(detectOpenApi({ a: 1 })).toEqual({ kind: "none" });
  });
});

describe("validateOpenApi", () => {
  it("passes a well-formed 3.0 document", () => {
    const { messages } = validateOpenApi(VALID_30);
    expect(messages).toEqual([]);
  });

  it("requires info and paths", () => {
    const { messages } = validateOpenApi({ openapi: "3.0.0" });
    const paths = messages.map((m) => m.path);
    expect(paths).toContain("/info");
    expect(paths).toContain("/paths");
  });

  it("3.1 accepts components-only documents", () => {
    const { messages } = validateOpenApi({
      openapi: "3.1.0",
      info: { title: "x", version: "1" },
      components: { schemas: {} },
    });
    expect(messages).toEqual([]);
  });

  it("flags duplicate operationIds and missing responses", () => {
    const { messages } = validateOpenApi({
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: {
        "/a": { get: { operationId: "dup", responses: { "200": { description: "ok" } } } },
        "/b": { get: { operationId: "dup" } },
      },
    });
    expect(messages.some((m) => m.keyword === "unique")).toBe(true);
    expect(messages.some((m) => m.path === "/paths/~1b/get/responses")).toBe(true);
  });

  it("cross-checks path template parameters", () => {
    const { messages } = validateOpenApi({
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: {
        "/items/{id}": {
          get: {
            parameters: [{ name: "other", in: "path", required: true }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(messages.some((m) => m.message.includes('"{id}" is never declared'))).toBe(true);
    expect(messages.some((m) => m.message.includes('"other" does not appear'))).toBe(true);
  });

  it("flags non-required path params, bad path keys, and duplicate templates", () => {
    const { messages } = validateOpenApi({
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: {
        "no-slash": {},
        "/u/{a}": { get: { parameters: [{ name: "a", in: "path" }], responses: {} } },
        "/u/{b}": {},
      },
    });
    expect(messages.some((m) => m.message.includes('must start with "/"'))).toBe(true);
    expect(messages.some((m) => m.message.includes("required: true"))).toBe(true);
    expect(messages.some((m) => m.message.includes("duplicates the template"))).toBe(true);
  });

  it("flags unresolvable local $refs but ignores external ones", () => {
    const { messages } = validateOpenApi({
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: {},
      components: {
        schemas: {
          A: { $ref: "#/components/schemas/Missing" },
          B: { $ref: "./other.yaml#/X" },
        },
      },
    });
    const refErrors = messages.filter((m) => m.keyword === "$ref");
    expect(refErrors).toHaveLength(1);
    expect(refErrors[0].message).toContain("#/components/schemas/Missing");
  });

  it("rejects non-OpenAPI documents", () => {
    const { messages } = validateOpenApi({ hello: "world" });
    expect(messages[0].keyword).toBe("version");
  });
});
