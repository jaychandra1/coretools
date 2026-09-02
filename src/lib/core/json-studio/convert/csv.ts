/**
 * CSV ⇄ JSON.
 *
 * Export flattens nested structures with dot/bracket paths
 * (`user.address.city`, `tags[0]`) so arbitrary JSON survives the trip to a
 * spreadsheet. Import is a hand-rolled RFC 4180 parser: quoted fields,
 * escaped quotes, embedded delimiters and newlines, CRLF — no dependency.
 */

import type { JsonValue, Result } from "./../types";

export interface CsvOptions {
  delimiter?: "," | ";" | "\t";
  /** Import: convert "42"/"true"/"null"/"" to typed values. Default true. */
  coerceTypes?: boolean;
}

// ---------------------------------------------------------------- flatten --

function flattenInto(
  value: JsonValue,
  prefix: string,
  row: Map<string, JsonValue>,
): void {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      if (value.length === 0) row.set(prefix, "[]");
      value.forEach((item, i) => flattenInto(item, `${prefix}[${i}]`, row));
    } else {
      const keys = Object.keys(value);
      if (keys.length === 0) row.set(prefix, "{}");
      for (const key of keys) {
        flattenInto(value[key], prefix ? `${prefix}.${key}` : key, row);
      }
    }
  } else {
    row.set(prefix, value);
  }
}

/** Normalize any JSON value to an array of flat rows. */
export function toRows(value: JsonValue): Array<Map<string, JsonValue>> {
  const records: JsonValue[] = Array.isArray(value) ? value : [value];
  return records.map((record) => {
    const row = new Map<string, JsonValue>();
    if (record !== null && typeof record === "object" && !Array.isArray(record)) {
      flattenInto(record, "", row);
    } else {
      flattenInto(record, "value", row);
    }
    return row;
  });
}

function escapeField(raw: string, delimiter: string): string {
  if (raw.includes('"') || raw.includes(delimiter) || /[\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function cellText(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** JSON → CSV. Arrays of objects become one row per element. */
export function jsonToCsv(value: JsonValue, options: CsvOptions = {}): Result<string> {
  const delimiter = options.delimiter ?? ",";
  const rows = toRows(value);
  if (rows.length === 0) return { ok: false, error: "Nothing to export: the array is empty" };

  // Union of all columns, in first-seen order.
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

  const lines: string[] = [];
  lines.push(columns.map((c) => escapeField(c, delimiter)).join(delimiter));
  for (const row of rows) {
    lines.push(
      columns
        .map((column) => escapeField(cellText(row.get(column)), delimiter))
        .join(delimiter),
    );
  }
  return { ok: true, value: lines.join("\r\n") };
}

// ------------------------------------------------------------------ parse --

/** RFC 4180 tokenizer → rows of raw string fields. */
export function parseCsvRows(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      pushField();
      i++;
    } else if (ch === "\r" && text[i + 1] === "\n") {
      pushRow();
      i += 2;
    } else if (ch === "\n" || ch === "\r") {
      pushRow();
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  // Flush the trailing field/row (unless the file ended exactly at a newline).
  if (field !== "" || row.length > 0) pushRow();

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function coerce(raw: string): JsonValue {
  if (raw === "") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && String(n).length >= raw.replace(/^0+(?=\d)/, "").length - 1) {
      // Guard huge integers that would lose precision (e.g. long IDs).
      if (!Number.isInteger(n) || Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n;
    }
    return raw;
  }
  return raw;
}

/** CSV → array of objects, first row as headers. */
export function csvToJson(text: string, options: CsvOptions = {}): Result<JsonValue> {
  const delimiter = options.delimiter ?? ",";
  const coerceTypes = options.coerceTypes ?? true;
  const rows = parseCsvRows(text, delimiter);
  if (rows.length === 0) return { ok: false, error: "No rows found in the CSV input" };

  const [header, ...body] = rows;
  if (header.some((h) => h.trim() === "")) {
    return { ok: false, error: "Header row contains an empty column name" };
  }
  const records = body.map((fields) => {
    const record: { [k: string]: JsonValue } = {};
    header.forEach((column, i) => {
      const raw = fields[i] ?? "";
      record[column] = coerceTypes ? coerce(raw) : raw;
    });
    return record;
  });
  return { ok: true, value: records };
}
