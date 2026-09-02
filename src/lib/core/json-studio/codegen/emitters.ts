/**
 * Code emitters: render the shared CodegenModel as TypeScript, C#, Java,
 * Python or Go source. Each emitter handles its language's identifier rules
 * and keeps the original JSON key via the language's serialization attribute
 * whenever the name had to change.
 */

import { buildModel, pascalCase, type CodegenModel, type TypeRef } from "./model";
import type { JsonValue } from "./../types";

export type CodegenLanguage = "typescript" | "csharp" | "java" | "python" | "go";

export const CODEGEN_LANGUAGES: Array<{ id: CodegenLanguage; label: string }> = [
  { id: "typescript", label: "TypeScript" },
  { id: "csharp", label: "C#" },
  { id: "java", label: "Java" },
  { id: "python", label: "Python" },
  { id: "go", label: "Go" },
];

export function generateCode(
  value: JsonValue,
  language: CodegenLanguage,
  rootName = "Root",
): string {
  const model = buildModel(value, rootName);
  switch (language) {
    case "typescript":
      return emitTypeScript(model, rootName);
    case "csharp":
      return emitCSharp(model, rootName);
    case "java":
      return emitJava(model, rootName);
    case "python":
      return emitPython(model, rootName);
    case "go":
      return emitGo(model, rootName);
  }
}

// ---------------------------------------------------------------- helpers --

function camelCase(raw: string): string {
  const pascal = pascalCase(raw);
  return pascal ? pascal[0].toLowerCase() + pascal.slice(1) : "field";
}

function snakeCase(raw: string): string {
  const cleaned = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return (/^[0-9]/.test(cleaned) ? `f_${cleaned}` : cleaned) || "field";
}

/** Is `key` already a safe, idiomatic identifier (letters/digits/_)? */
function isPlainIdent(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** Root alias line when the document root is not itself an object. */
function rootIsRef(model: CodegenModel): boolean {
  return model.root.kind === "ref";
}

// ------------------------------------------------------------- TypeScript --

function tsType(t: TypeRef): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "integer":
        case "number":
          return "number";
        case "any":
          return "unknown";
        default:
          return t.name;
      }
    case "array": {
      const inner = tsType(t.items);
      return t.items.kind === "union" ? `Array<${inner}>` : `${inner}[]`;
    }
    case "ref":
      return t.name;
    case "union":
      return t.variants.map(tsType).join(" | ");
  }
}

function emitTypeScript(model: CodegenModel, rootName: string): string {
  const blocks = model.defs.map((def) => {
    const fields = def.fields
      .map((field) => {
        const key = isPlainIdent(field.key) ? field.key : JSON.stringify(field.key);
        return `  ${key}${field.optional ? "?" : ""}: ${tsType(field.type)};`;
      })
      .join("\n");
    return `export interface ${def.name} {\n${fields}\n}`;
  });
  if (!rootIsRef(model)) {
    blocks.push(`export type ${pascalCase(rootName)} = ${tsType(model.root)};`);
  }
  return blocks.join("\n\n") + "\n";
}

// -------------------------------------------------------------------- C# --

function csType(t: TypeRef): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "string":
          return "string";
        case "integer":
          return "long";
        case "number":
          return "double";
        case "boolean":
          return "bool";
        default:
          return "object";
      }
    case "array":
      return `List<${csType(t.items)}>`;
    case "ref":
      return t.name;
    case "union":
      return "object";
  }
}

function emitCSharp(model: CodegenModel, rootName: string): string {
  const lines: string[] = [
    "using System.Collections.Generic;",
    "using System.Text.Json.Serialization;",
    "",
    `namespace ${pascalCase(rootName)}Models;`,
    "",
  ];
  for (const def of model.defs) {
    lines.push(`public class ${def.name}`, "{");
    def.fields.forEach((field, i) => {
      const property = pascalCase(field.key);
      const type = csType(field.type);
      const nullable = field.optional || field.type.kind === "union" ? "?" : "";
      lines.push(`    [JsonPropertyName(${JSON.stringify(field.key)})]`);
      lines.push(`    public ${type}${nullable} ${property} { get; set; }`);
      if (i < def.fields.length - 1) lines.push("");
    });
    lines.push("}", "");
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------- Java --

function javaType(t: TypeRef, boxed = false): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "string":
          return "String";
        case "integer":
          return boxed ? "Long" : "long";
        case "number":
          return boxed ? "Double" : "double";
        case "boolean":
          return boxed ? "Boolean" : "boolean";
        default:
          return "Object";
      }
    case "array":
      return `List<${javaType(t.items, true)}>`;
    case "ref":
      return t.name;
    case "union":
      return "Object";
  }
}

function emitJava(model: CodegenModel, _rootName: string): string {
  const lines: string[] = [
    `// Root type: ${rootIsRef(model) ? (model.root as { name: string }).name : javaType(model.root)}`,
    "import java.util.List;",
    "import com.fasterxml.jackson.annotation.JsonProperty;",
    "",
  ];
  model.defs.forEach((def, index) => {
    lines.push(`public${index === 0 ? "" : " static"} class ${def.name} {`);
    for (const field of def.fields) {
      const name = camelCase(field.key);
      // Optional fields use boxed types so "absent" is representable as null.
      const type = javaType(field.type, field.optional);
      lines.push(`    @JsonProperty(${JSON.stringify(field.key)})`);
      lines.push(`    private ${type} ${name};`);
    }
    lines.push("");
    for (const field of def.fields) {
      const name = camelCase(field.key);
      const type = javaType(field.type, field.optional);
      const property = pascalCase(field.key);
      lines.push(`    public ${type} get${property}() { return ${name}; }`);
      lines.push(`    public void set${property}(${type} value) { this.${name} = value; }`);
    }
    lines.push("}", "");
  });
  return lines.join("\n");
}

// ----------------------------------------------------------------- Python --

function pyType(t: TypeRef): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "string":
          return "str";
        case "integer":
          return "int";
        case "number":
          return "float";
        case "boolean":
          return "bool";
        case "null":
          return "None";
        default:
          return "Any";
      }
    case "array":
      return `list[${pyType(t.items)}]`;
    case "ref":
      return `"${t.name}"`;
    case "union":
      return t.variants.map(pyType).join(" | ");
  }
}

function emitPython(model: CodegenModel, rootName: string): string {
  const lines: string[] = [
    "from __future__ import annotations",
    "",
    "from dataclasses import dataclass, field",
    "from typing import Any",
    "",
    "",
  ];
  // Reverse: Python wants definitions before use at decorator time only for
  // defaults, but leaves-first reads naturally top-down here too.
  model.defs.forEach((def, index) => {
    lines.push("@dataclass");
    lines.push(`class ${def.name}:`);
    if (def.fields.length === 0) lines.push("    pass");
    const ordered = [...def.fields].sort(
      (a, b) => Number(a.optional) - Number(b.optional),
    );
    for (const f of ordered) {
      const name = snakeCase(f.key);
      const renamed = name !== f.key ? `  # JSON key: ${JSON.stringify(f.key)}` : "";
      const type = f.optional ? `${pyType(f.type)} | None = None` : pyType(f.type);
      lines.push(`    ${name}: ${type}${renamed}`);
    }
    if (index < model.defs.length - 1) lines.push("", "");
  });
  if (!rootIsRef(model)) {
    lines.push("", "", `${pascalCase(rootName)} = ${pyType(model.root)}`);
  }
  lines.push("");
  return lines.join("\n");
}

// --------------------------------------------------------------------- Go --

function goType(t: TypeRef): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "string":
          return "string";
        case "integer":
          return "int64";
        case "number":
          return "float64";
        case "boolean":
          return "bool";
        default:
          return "any";
      }
    case "array":
      return `[]${goType(t.items)}`;
    case "ref":
      return t.name;
    case "union":
      return "any";
  }
}

function emitGo(model: CodegenModel, rootName: string): string {
  const lines: string[] = [`package ${snakeCase(rootName).replace(/_/g, "")}`, ""];
  for (const def of [...model.defs].reverse()) {
    lines.push(`type ${def.name} struct {`);
    for (const field of def.fields) {
      const name = pascalCase(field.key);
      // Optional fields become pointers so absence survives a round-trip.
      const base = goType(field.type);
      const type = field.optional && !base.startsWith("[]") && base !== "any" ? `*${base}` : base;
      const omit = field.optional ? ",omitempty" : "";
      lines.push(`\t${name} ${type} \`json:"${field.key}${omit}"\``);
    }
    lines.push("}", "");
  }
  if (!rootIsRef(model)) {
    lines.push(`type ${pascalCase(rootName)} = ${goType(model.root)}`, "");
  }
  return lines.join("\n");
}
