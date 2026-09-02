/**
 * OpenAPI / Swagger structural validation — fully offline.
 *
 * This is a rule-based linter for OpenAPI 3.0.x / 3.1.x and Swagger 2.0
 * documents, not a run of the official meta-schemas (those depend on remote
 * $refs and draft-04 quirks; this app never touches the network). The rules
 * cover the mistakes that actually break tooling:
 *
 *  - version field present and recognized
 *  - required top-level objects (`info` with title+version; `paths` for 3.0/2.0,
 *    one of paths/components/webhooks for 3.1)
 *  - path keys start with "/", no duplicate templated paths
 *  - operations use valid HTTP methods, `responses` present (3.0/2.0)
 *  - `operationId` uniqueness across the document
 *  - path template parameters declared, and declared path params required
 *  - every local `$ref` ("#/...") resolves
 *  - parameter objects carry name+in, requestBody has content (3.x)
 */

import type { JsonValue, ValidationMessage } from "./types";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

type Obj = { [key: string]: JsonValue };

function isObj(v: JsonValue | undefined): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export type OpenApiFlavor =
  | { kind: "openapi"; version: string }
  | { kind: "swagger"; version: string }
  | { kind: "none" };

/** Detect whether a JSON value looks like an OpenAPI/Swagger document. */
export function detectOpenApi(doc: JsonValue): OpenApiFlavor {
  if (!isObj(doc)) return { kind: "none" };
  if (typeof doc.openapi === "string") return { kind: "openapi", version: doc.openapi };
  if (typeof doc.swagger === "string") return { kind: "swagger", version: doc.swagger };
  return { kind: "none" };
}

function push(
  messages: ValidationMessage[],
  path: string,
  message: string,
  keyword: string,
) {
  messages.push({ path, message, keyword });
}

/** Resolve one local JSON Pointer ("#/components/schemas/Pet"). */
function resolvePointer(doc: JsonValue, pointer: string): JsonValue | undefined {
  if (!pointer.startsWith("#")) return undefined;
  let current: JsonValue = doc;
  const parts = pointer
    .slice(1)
    .split("/")
    .filter((p) => p !== "")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isObj(current)) {
      if (!(part in current)) return undefined;
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Walk the whole document collecting `$ref` strings with their locations. */
function collectRefs(value: JsonValue, path: string, out: Array<{ path: string; ref: string }>) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectRefs(item, `${path}/${i}`, out));
  } else if (isObj(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (key === "$ref" && typeof child === "string") {
        out.push({ path: childPath, ref: child });
      } else {
        collectRefs(child, childPath, out);
      }
    }
  }
}

function templateParams(pathKey: string): string[] {
  return [...pathKey.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/** Gather parameter objects (resolving local refs) for an operation. */
function effectiveParams(
  doc: JsonValue,
  pathItem: Obj,
  operation: Obj,
): Array<{ obj: Obj; from: string }> {
  const out: Array<{ obj: Obj; from: string }> = [];
  for (const [source, list] of [
    ["path item", pathItem.parameters],
    ["operation", operation.parameters],
  ] as const) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      let resolved: JsonValue | undefined = entry;
      if (isObj(entry) && typeof entry.$ref === "string") {
        resolved = resolvePointer(doc, entry.$ref);
      }
      if (isObj(resolved)) out.push({ obj: resolved, from: source });
    }
  }
  return out;
}

/** Validate a parsed document. Empty result = no findings. */
export function validateOpenApi(doc: JsonValue): {
  flavor: OpenApiFlavor;
  messages: ValidationMessage[];
} {
  const messages: ValidationMessage[] = [];
  const flavor = detectOpenApi(doc);

  if (flavor.kind === "none" || !isObj(doc)) {
    push(messages, "", 'Not an OpenAPI document: missing "openapi" or "swagger" version field', "version");
    return { flavor, messages };
  }

  const is31 = flavor.kind === "openapi" && flavor.version.startsWith("3.1");
  const is30 = flavor.kind === "openapi" && flavor.version.startsWith("3.0");
  if (flavor.kind === "openapi" && !is30 && !is31) {
    push(messages, "/openapi", `Unrecognized OpenAPI version "${flavor.version}" (expected 3.0.x or 3.1.x)`, "version");
  }
  if (flavor.kind === "swagger" && flavor.version !== "2.0") {
    push(messages, "/swagger", `Unrecognized Swagger version "${flavor.version}" (expected 2.0)`, "version");
  }

  // info
  if (!isObj(doc.info)) {
    push(messages, "/info", "Missing required object: info", "required");
  } else {
    if (typeof doc.info.title !== "string" || doc.info.title === "") {
      push(messages, "/info/title", "info.title is required", "required");
    }
    if (typeof doc.info.version !== "string" || doc.info.version === "") {
      push(messages, "/info/version", "info.version is required", "required");
    }
  }

  // top-level shape
  const hasPaths = isObj(doc.paths);
  if (is31) {
    if (!hasPaths && !isObj(doc.components) && !isObj(doc.webhooks)) {
      push(messages, "", "OpenAPI 3.1 requires at least one of: paths, components, webhooks", "required");
    }
  } else if (!hasPaths) {
    push(messages, "/paths", "Missing required object: paths", "required");
  }

  // paths + operations
  const operationIds = new Map<string, string>();
  if (hasPaths) {
    const paths = doc.paths as Obj;
    const normalizedTemplates = new Map<string, string>();

    for (const [pathKey, pathValue] of Object.entries(paths)) {
      const pathPointer = `/paths/${pathKey.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (!pathKey.startsWith("/")) {
        push(messages, pathPointer, `Path "${pathKey}" must start with "/"`, "paths");
      }

      // /users/{id} and /users/{userId} are the same route
      const normalized = pathKey.replace(/\{[^}]+\}/g, "{}");
      const existing = normalizedTemplates.get(normalized);
      if (existing && existing !== pathKey) {
        push(messages, pathPointer, `Path "${pathKey}" duplicates the template of "${existing}"`, "paths");
      } else {
        normalizedTemplates.set(normalized, pathKey);
      }

      if (!isObj(pathValue)) {
        push(messages, pathPointer, "Path item must be an object", "type");
        continue;
      }

      const declared = templateParams(pathKey);

      for (const [method, operation] of Object.entries(pathValue)) {
        if (!HTTP_METHODS.includes(method)) continue;
        const opPointer = `${pathPointer}/${method}`;
        if (!isObj(operation)) {
          push(messages, opPointer, "Operation must be an object", "type");
          continue;
        }

        if (!is31 && !isObj(operation.responses)) {
          push(messages, `${opPointer}/responses`, "Operation is missing responses", "required");
        }

        if (typeof operation.operationId === "string") {
          const previous = operationIds.get(operation.operationId);
          if (previous) {
            push(
              messages,
              `${opPointer}/operationId`,
              `Duplicate operationId "${operation.operationId}" (also used at ${previous})`,
              "unique",
            );
          } else {
            operationIds.set(operation.operationId, opPointer);
          }
        }

        // parameters
        const params = effectiveParams(doc, pathValue, operation);
        const pathParamNames = new Set<string>();
        for (const { obj } of params) {
          if (typeof obj.name !== "string" || typeof obj.in !== "string") {
            push(messages, `${opPointer}/parameters`, "Parameter objects need both name and in", "required");
            continue;
          }
          if (obj.in === "path") {
            pathParamNames.add(obj.name);
            if (obj.required !== true) {
              push(
                messages,
                `${opPointer}/parameters`,
                `Path parameter "${obj.name}" must set required: true`,
                "required",
              );
            }
            if (!declared.includes(obj.name)) {
              push(
                messages,
                `${opPointer}/parameters`,
                `Path parameter "${obj.name}" does not appear in the path template`,
                "params",
              );
            }
          }
        }
        for (const name of declared) {
          if (!pathParamNames.has(name)) {
            push(
              messages,
              opPointer,
              `Path template parameter "{${name}}" is never declared as an in: path parameter`,
              "params",
            );
          }
        }

        // requestBody (3.x)
        if (flavor.kind === "openapi" && isObj(operation.requestBody)) {
          const body = operation.requestBody;
          if (typeof body.$ref !== "string" && !isObj(body.content)) {
            push(messages, `${opPointer}/requestBody/content`, "requestBody requires a content map", "required");
          }
        }
      }
    }
  }

  // local $refs
  const refs: Array<{ path: string; ref: string }> = [];
  collectRefs(doc, "", refs);
  for (const { path, ref } of refs) {
    if (!ref.startsWith("#")) continue; // external refs can't be checked offline
    if (resolvePointer(doc, ref) === undefined) {
      push(messages, path, `Unresolvable local reference: ${ref}`, "$ref");
    }
  }

  return { flavor, messages };
}
