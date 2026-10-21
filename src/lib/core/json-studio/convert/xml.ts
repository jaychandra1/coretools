/**
 * XML ⇄ JSON via fast-xml-parser (pure JS, no DOM, no network).
 * Attributes map to "@_"-prefixed keys, text nodes to "#text" — the library's
 * conventional round-trippable representation.
 */

import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import type { JsonValue, Result } from "./../types";

const SHARED = {
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
  textNodeName: "#text",
} as const;

/**
 * Documents that declare their own entities are refused: nested entity
 * definitions can expand a few bytes into gigabytes ("billion laughs").
 * The five standard XML entities (&amp; and friends) still decode.
 */
export const DECLARED_ENTITY = /<!ENTITY/i;

export function xmlToJson(xml: string): Result<JsonValue> {
  if (xml.trim() === "") return { ok: false, error: "XML input is empty" };
  if (DECLARED_ENTITY.test(xml)) {
    return { ok: false, error: "XML with entity declarations (<!ENTITY …>) isn't supported" };
  }
  const check = XMLValidator.validate(xml);
  if (check !== true) {
    return {
      ok: false,
      error: `Invalid XML: ${check.err.msg} (line ${check.err.line})`,
    };
  }
  try {
    const parser = new XMLParser({
      ...SHARED,
      parseTagValue: true,
      parseAttributeValue: true,
      trimValues: true,
      // The <?xml?> declaration and processing instructions are container
      // metadata, not data — keep them out of the JSON.
      ignoreDeclaration: true,
      ignorePiTags: true,
    });
    return { ok: true, value: parser.parse(xml) as JsonValue };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function jsonToXml(value: JsonValue, rootName = "root"): Result<string> {
  try {
    const builder = new XMLBuilder({
      ...SHARED,
      format: true,
      indentBy: "  ",
      suppressEmptyNode: true,
    });
    // A document needs exactly one root element. Objects with a single key
    // already have one; everything else is wrapped in <rootName>.
    let doc: JsonValue = value;
    const isSingleRooted =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      !Array.isArray((value as { [k: string]: JsonValue })[Object.keys(value)[0]]);
    if (!isSingleRooted) doc = { [rootName]: value };

    const xml = builder.build(doc) as string;
    return { ok: true, value: `<?xml version="1.0" encoding="UTF-8"?>\n${xml.trim()}\n` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
