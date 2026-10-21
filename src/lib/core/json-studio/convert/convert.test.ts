import { describe, it, expect } from "vitest";
import { csvToJson, jsonToCsv, parseCsvRows } from "./csv";
import { jsonToXml, xmlToJson } from "./xml";
import { jsonToYaml, yamlToJson } from "./yaml";
import { columnRef, jsonToXlsx, xlsxToJson } from "./xlsx";
import type { JsonValue } from "./../types";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const RECORDS: JsonValue = [
  { id: 1, name: "Alice", active: true, address: { city: "Oslo" } },
  { id: 2, name: 'Bob "The Builder"', active: false, tags: ["a", "b"] },
];

describe("CSV", () => {
  it("exports arrays of objects with flattened nested paths", () => {
    const result = jsonToCsv(RECORDS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [header, row1, row2] = result.value.split("\r\n");
    expect(header).toBe("id,name,active,address.city,tags[0],tags[1]");
    expect(row1).toBe("1,Alice,true,Oslo,,");
    expect(row2).toContain('"Bob ""The Builder"""');
  });

  it("parses RFC 4180: quotes, embedded delimiters and newlines", () => {
    const rows = parseCsvRows('a,b\n"1,5","line1\nline2"\n"quote""d",plain');
    expect(rows).toEqual([
      ["a", "b"],
      ["1,5", "line1\nline2"],
      ['quote"d', "plain"],
    ]);
  });

  it("round-trips flat records with type coercion", () => {
    const csv = jsonToCsv([{ id: 1, name: "x", ok: true, note: null }]);
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    const back = csvToJson(csv.value);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.value).toEqual([{ id: 1, name: "x", ok: true, note: null }]);
    }
  });

  it("keeps unsafe-precision integers as strings", () => {
    const back = csvToJson("id\n9007199254740993");
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual([{ id: "9007199254740993" }]);
  });

  it("supports alternative delimiters", () => {
    const back = csvToJson("a;b\n1;2", { delimiter: ";" });
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual([{ a: 1, b: 2 }]);
  });

  it("rejects empty input and empty headers", () => {
    expect(csvToJson("").ok).toBe(false);
    expect(csvToJson(",b\n1,2").ok).toBe(false);
  });
});

describe("XML", () => {
  it("round-trips structured data", () => {
    const xml = jsonToXml({ user: { name: "alice", age: 30, tags: { tag: ["a", "b"] } } });
    expect(xml.ok).toBe(true);
    if (!xml.ok) return;
    expect(xml.value).toContain("<name>alice</name>");
    const back = xmlToJson(xml.value);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.value).toEqual({
        user: { name: "alice", age: 30, tags: { tag: ["a", "b"] } },
      });
    }
  });

  it("preserves attributes with the @_ prefix", () => {
    const back = xmlToJson('<item id="7">text</item>');
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual({ item: { "#text": "text", "@_id": 7 } });
  });

  it("wraps multi-key roots and reports invalid XML", () => {
    const xml = jsonToXml({ a: 1, b: 2 });
    expect(xml.ok && xml.value.includes("<root>")).toBe(true);
    expect(xmlToJson("<a><b></a>").ok).toBe(false);
    expect(xmlToJson("").ok).toBe(false);
  });
});

describe("YAML", () => {
  it("round-trips", () => {
    const yaml = jsonToYaml({ name: "x", list: [1, 2], nested: { ok: true } });
    expect(yaml.ok).toBe(true);
    if (!yaml.ok) return;
    const back = yamlToJson(yaml.value);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual({ name: "x", list: [1, 2], nested: { ok: true } });
  });

  it("parses YAML idioms into JSON", () => {
    const back = yamlToJson("services:\n  - name: api\n    port: 8080\n  - name: db\n");
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.value).toEqual({
        services: [{ name: "api", port: 8080 }, { name: "db" }],
      });
    }
  });

  it("caps alias expansion (billion laughs)", () => {
    const bomb =
      "a: &a [1,1,1,1,1,1,1,1,1,1]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\n";
    expect(yamlToJson(bomb).ok).toBe(false);
  });
});

describe("XLSX", () => {
  it("column references follow A..Z, AA..", () => {
    expect(columnRef(0)).toBe("A");
    expect(columnRef(25)).toBe("Z");
    expect(columnRef(26)).toBe("AA");
    expect(columnRef(27)).toBe("AB");
    expect(columnRef(701)).toBe("ZZ");
    expect(columnRef(702)).toBe("AAA");
  });

  it("round-trips records through a real zip container", () => {
    const bytes = jsonToXlsx([
      { id: 1, name: "Alice & Co <quoted>", score: 9.5, active: true, note: null },
      { id: 2, name: "Bob", score: 7, active: false, extra: "only here" },
    ]);
    expect(bytes.ok).toBe(true);
    if (!bytes.ok) return;
    // Standard zip magic: PK\x03\x04
    expect([...bytes.value.slice(0, 2)]).toEqual([0x50, 0x4b]);

    const back = xlsxToJson(bytes.value);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.value).toEqual([
        { id: 1, name: "Alice & Co <quoted>", score: 9.5, active: true, note: null, extra: null },
        { id: 2, name: "Bob", score: 7, active: false, note: null, extra: "only here" },
      ]);
    }
  });

  it("flattens nested structures like the CSV exporter", () => {
    const bytes = jsonToXlsx([{ user: { name: "a" }, tags: ["x"] }]);
    expect(bytes.ok).toBe(true);
    if (!bytes.ok) return;
    const back = xlsxToJson(bytes.value);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual([{ "user.name": "a", "tags[0]": "x" }]);
  });

  it("rejects non-zip bytes and empty arrays", () => {
    expect(xlsxToJson(new Uint8Array([1, 2, 3])).ok).toBe(false);
    expect(jsonToXlsx([]).ok).toBe(false);
  });

  it("refuses cell references past Excel's last column instead of building huge rows", () => {
    const bytes = jsonToXlsx([{ id: 1 }]);
    if (!bytes.ok) throw new Error("export failed");
    const files = unzipSync(bytes.value);
    const sheet = Object.keys(files).find((f) => f.startsWith("xl/worksheets/"))!;
    for (const ref of ["ZZZZZZZZ1", "XFE1"]) {
      const crafted = strFromU8(files[sheet]).replace(/r="A1"/, `r="${ref}"`);
      const back = xlsxToJson(zipSync({ ...files, [sheet]: strToU8(crafted) }));
      expect(back.ok, ref).toBe(false);
    }
  });
});
