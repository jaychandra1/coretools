/**
 * Language-neutral type model inferred from an example document. The five
 * emitters render this model; inference happens once.
 *
 * Arrays of objects merge into ONE named type whose fields become optional
 * when absent from some elements — the shape people expect from tools like
 * quicktype, without shipping quicktype.
 */

import type { JsonValue } from "./../types";

export type TypeRef =
  | { kind: "primitive"; name: "string" | "number" | "integer" | "boolean" | "null" | "any" }
  | { kind: "array"; items: TypeRef }
  | { kind: "ref"; name: string }
  | { kind: "union"; variants: TypeRef[] };

export interface Field {
  /** Original JSON key, exactly as it appears in the document. */
  key: string;
  type: TypeRef;
  optional: boolean;
}

export interface TypeDef {
  name: string;
  fields: Field[];
}

export interface CodegenModel {
  root: TypeRef;
  /** Definitions in dependency order (leaves first, root type last). */
  defs: TypeDef[];
}

const PRIMITIVE = (name: Extract<TypeRef, { kind: "primitive" }>["name"]): TypeRef => ({
  kind: "primitive",
  name,
});

function typeEquals(a: TypeRef, b: TypeRef): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** "user_accounts" / "userAccounts" / "user-accounts" → "UserAccount"-ish. */
export function pascalCase(raw: string): string {
  const words = raw
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/);
  const joined = words
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join("");
  const cleaned = joined.replace(/^[0-9]+/, "");
  if (!cleaned) return "Item";
  // Re-capitalize: stripping leading digits can expose a lowercase letter.
  return cleaned[0].toUpperCase() + cleaned.slice(1);
}

/** Cheap singularization for type names derived from array keys. */
function singular(name: string): string {
  if (/ies$/i.test(name)) return name.replace(/ies$/i, "y");
  if (/(ses|xes|zes|ches|shes)$/i.test(name)) return name.replace(/es$/i, "");
  if (/s$/i.test(name) && !/ss$/i.test(name)) return name.slice(0, -1);
  return name;
}

class ModelBuilder {
  defs: TypeDef[] = [];
  private usedNames = new Set<string>();

  private claimName(hint: string): string {
    const base = pascalCase(singular(hint));
    let name = base;
    let counter = 2;
    while (this.usedNames.has(name)) name = `${base}${counter++}`;
    this.usedNames.add(name);
    return name;
  }

  infer(value: JsonValue, nameHint: string): TypeRef {
    if (value === null) return PRIMITIVE("null");
    if (Array.isArray(value)) {
      if (value.length === 0) return { kind: "array", items: PRIMITIVE("any") };
      let items = this.infer(value[0], nameHint);
      for (let i = 1; i < value.length; i++) {
        items = this.merge(items, this.infer(value[i], nameHint));
      }
      return { kind: "array", items };
    }
    switch (typeof value) {
      case "string":
        return PRIMITIVE("string");
      case "boolean":
        return PRIMITIVE("boolean");
      case "number":
        return PRIMITIVE(Number.isInteger(value) ? "integer" : "number");
      case "object": {
        const name = this.claimName(nameHint);
        const def: TypeDef = { name, fields: [] };
        // Register eagerly so self-similar nesting still terminates.
        this.defs.push(def);
        for (const [key, child] of Object.entries(value)) {
          def.fields.push({ key, type: this.infer(child, key), optional: false });
        }
        return { kind: "ref", name };
      }
    }
  }

  /** Merge two inferred refs into one that accepts both shapes. */
  merge(a: TypeRef, b: TypeRef): TypeRef {
    if (typeEquals(a, b)) return a;

    if (a.kind === "primitive" && b.kind === "primitive") {
      const pair = [a.name, b.name].sort().join("+");
      if (pair === "integer+number") return PRIMITIVE("number");
      if (a.name === "any") return b;
      if (b.name === "any") return a;
    }

    if (a.kind === "array" && b.kind === "array") {
      return { kind: "array", items: this.merge(a.items, b.items) };
    }

    if (a.kind === "ref" && b.kind === "ref") {
      // Merge b's def into a's and retire b.
      const defA = this.defs.find((d) => d.name === a.name)!;
      const defB = this.defs.find((d) => d.name === b.name)!;
      if (defA === defB) return a;
      for (const fieldB of defB.fields) {
        const fieldA = defA.fields.find((f) => f.key === fieldB.key);
        if (!fieldA) {
          defA.fields.push({ ...fieldB, optional: true });
        } else {
          fieldA.type = this.merge(fieldA.type, fieldB.type);
          fieldA.optional = fieldA.optional || fieldB.optional;
        }
      }
      for (const fieldA of defA.fields) {
        if (!defB.fields.some((f) => f.key === fieldA.key)) fieldA.optional = true;
      }
      this.defs = this.defs.filter((d) => d !== defB);
      this.usedNames.delete(defB.name);
      this.rewriteRefs(defB.name, defA.name);
      return a;
    }

    // Fold into a union, flattening nested unions and deduping variants.
    const variants: TypeRef[] = [];
    for (const t of [a, b]) {
      for (const variant of t.kind === "union" ? t.variants : [t]) {
        if (!variants.some((v) => typeEquals(v, variant))) variants.push(variant);
      }
    }
    return variants.length === 1 ? variants[0] : { kind: "union", variants };
  }

  private rewriteRefs(from: string, to: string): void {
    const rewrite = (t: TypeRef): TypeRef => {
      switch (t.kind) {
        case "ref":
          return t.name === from ? { kind: "ref", name: to } : t;
        case "array":
          return { kind: "array", items: rewrite(t.items) };
        case "union":
          return { kind: "union", variants: t.variants.map(rewrite) };
        default:
          return t;
      }
    };
    for (const def of this.defs) {
      for (const field of def.fields) field.type = rewrite(field.type);
    }
  }
}

/** Build the shared model. `rootName` seeds the top-level type name. */
export function buildModel(value: JsonValue, rootName = "Root"): CodegenModel {
  const builder = new ModelBuilder();
  const root = builder.infer(value, rootName);
  return { root, defs: builder.defs };
}
