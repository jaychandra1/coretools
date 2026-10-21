/**
 * Excel (.xlsx) ⇄ JSON — hand-rolled on `fflate` (zip) + `fast-xml-parser`.
 *
 * Deliberately NOT SheetJS: the npm `xlsx` build lags the vendor's CDN
 * releases and carries unfixed advisories, which would break this project's
 * "npm audit --omit=dev: 0 vulnerabilities" policy. An .xlsx file is just a
 * zip of small XML parts, and one sheet of typed cells is well within reach:
 *
 *  - Export: array of (flattened) objects → one worksheet, header row +
 *    typed cells (numbers/booleans native, everything else inline strings).
 *  - Import: first worksheet → array of objects keyed by the header row;
 *    supports shared strings, inline strings, booleans and numbers.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type { JsonValue, Result } from "./../types";
import { toRows } from "./csv";
import { setOwn } from "../../own";

// ------------------------------------------------------------------ shared --

function xmlEscape(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 → "A", 25 → "Z", 26 → "AA" ... */
export function columnRef(index: number): string {
  let ref = "";
  let n = index;
  for (;;) {
    ref = String.fromCharCode(65 + (n % 26)) + ref;
    n = Math.floor(n / 26) - 1;
    if (n < 0) return ref;
  }
}

/** Excel's last column is XFD: 16,384 columns. */
const MAX_COLUMNS = 16_384;

/** "AB12" → column index 27; -1 past Excel's last column (a crafted file). */
function refToColumn(cellRef: string): number {
  const letters = /^[A-Z]*/.exec(cellRef)?.[0] || "A";
  if (letters.length > 3) return -1;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n <= MAX_COLUMNS ? n - 1 : -1;
}

// ------------------------------------------------------------------ export --

function cellXml(ref: string, value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

/** JSON → .xlsx bytes (single worksheet named "Data"). */
export function jsonToXlsx(value: JsonValue): Result<Uint8Array> {
  const rows = toRows(value);
  if (rows.length === 0) return { ok: false, error: "Nothing to export: the array is empty" };

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of row.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  const sheetRows: string[] = [];
  const headerCells = columns
    .map((column, c) => cellXml(`${columnRef(c)}1`, column))
    .join("");
  sheetRows.push(`<row r="1">${headerCells}</row>`);
  rows.forEach((row, r) => {
    const cells = columns
      .map((column, c) => cellXml(`${columnRef(c)}${r + 2}`, row.get(column)))
      .join("");
    sheetRows.push(`<row r="${r + 2}">${cells}</row>`);
  });

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows.join("")}</sheetData></worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` +
    `Target="worksheets/sheet1.xml"/></Relationships>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
    `Target="xl/workbook.xml"/></Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;

  try {
    const zipped = zipSync(
      {
        "[Content_Types].xml": strToU8(contentTypes),
        "_rels/.rels": strToU8(rootRels),
        "xl/workbook.xml": strToU8(workbookXml),
        "xl/_rels/workbook.xml.rels": strToU8(workbookRels),
        "xl/worksheets/sheet1.xml": strToU8(sheetXml),
      },
      { level: 6 },
    );
    return { ok: true, value: zipped };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------ import --

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

type XmlNode = { [key: string]: unknown };

/** Concatenate the text runs of a shared-string / inline-string node. */
function textOf(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node !== "object") return String(node);
  const obj = node as XmlNode;
  if ("#text" in obj) return String(obj["#text"]);
  let text = "";
  for (const t of toArray(obj.t)) text += textOf(t);
  for (const r of toArray(obj.r)) text += textOf((r as XmlNode).t);
  return text;
}

/** .xlsx bytes → array of objects from the first worksheet. */
/** A workbook may expand to at most this much: a zip bomb can't exhaust memory (L7). */
const MAX_XLSX_EXPANDED = 64 * 1024 * 1024;

export function xlsxToJson(bytes: Uint8Array): Result<JsonValue> {
  let files: Record<string, Uint8Array>;
  let expanded = 0;
  let tooBig = false;
  try {
    files = unzipSync(bytes, {
      // Only the parts read below are expanded, and only while the total stays bounded.
      filter: (file) => {
        if (!/^xl\/(?:worksheets\/[^/]+\.xml|sharedStrings\.xml)$/i.test(file.name)) return false;
        expanded += file.originalSize;
        if (expanded > MAX_XLSX_EXPANDED) tooBig = true;
        return !tooBig;
      },
    });
  } catch {
    return { ok: false, error: "Not a valid .xlsx file (zip container could not be read)" };
  }
  if (tooBig) return { ok: false, error: "This workbook is too large to convert here (over 64 MB unpacked)" };
  // No legitimate workbook part declares entities; see xml.ts.
  if (Object.values(files).some((part) => /<!ENTITY/i.test(strFromU8(part.subarray(0, 4096))))) {
    return { ok: false, error: "This workbook contains XML entity declarations, which aren't supported" };
  }

  const sheetPath =
    Object.keys(files).find((f) => /^xl\/worksheets\/sheet1\.xml$/i.test(f)) ??
    Object.keys(files)
      .filter((f) => /^xl\/worksheets\/.*\.xml$/i.test(f))
      .sort()[0];
  if (!sheetPath) return { ok: false, error: "No worksheet found in the workbook" };

  const shared: string[] = [];
  if (files["xl/sharedStrings.xml"]) {
    const sst = parser.parse(strFromU8(files["xl/sharedStrings.xml"])) as XmlNode;
    for (const si of toArray((sst.sst as XmlNode | undefined)?.si)) {
      shared.push(textOf(si));
    }
  }

  const sheet = parser.parse(strFromU8(files[sheetPath])) as XmlNode;
  const sheetData = (sheet.worksheet as XmlNode | undefined)?.sheetData as XmlNode | undefined;
  const rows = toArray(sheetData?.row) as XmlNode[];
  if (rows.length === 0) return { ok: false, error: "The worksheet is empty" };

  const grid: Array<Array<JsonValue>> = [];
  for (const row of rows) {
    const cells = toArray(row.c) as XmlNode[];
    const out: JsonValue[] = [];
    for (const cell of cells) {
      const ref = String(cell["@_r"] ?? "");
      const column = ref ? refToColumn(ref) : out.length;
      // A huge column index would make a sparse row billions of cells long.
      if (column < 0 || column >= MAX_COLUMNS) {
        return { ok: false, error: "This workbook has cells beyond Excel's last column (XFD)" };
      }
      const type = String(cell["@_t"] ?? "");
      let value: JsonValue = null;
      if (type === "inlineStr") {
        value = textOf(cell.is);
      } else if (type === "s") {
        value = shared[Number(textOf(cell.v))] ?? "";
      } else if (type === "str") {
        value = textOf(cell.v);
      } else if (type === "b") {
        value = textOf(cell.v) === "1";
      } else {
        const raw = textOf(cell.v);
        if (raw === "") value = null;
        else {
          const n = Number(raw);
          value = Number.isFinite(n) ? n : raw;
        }
      }
      out[column] = value;
    }
    grid.push(out);
  }

  const [headerCells, ...body] = grid;
  const headers = headerCells.map((h, i) =>
    h === null || h === undefined || String(h) === "" ? `column${i + 1}` : String(h),
  );
  const records = body.map((cells) => {
    const record: { [k: string]: JsonValue } = {};
    headers.forEach((header, i) => {
      setOwn(record, header, cells[i] ?? null);
    });
    return record;
  });
  return { ok: true, value: records };
}
