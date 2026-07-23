import { describe, expect, it } from "vitest";
import { toCsv, type CsvColumn } from "./csv";

/**
 * A minimal RFC-4180 reader, mirroring the import-side parser in
 * `scripts/import/_shared.mts` (strip BOM, quoted fields, "" escapes, CRLF,
 * trim). Kept test-local because that script is excluded from the tsconfig;
 * round-tripping through an equivalent reader is what proves the writer sound.
 */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => (obj[h] = (r[i] ?? "").trim()));
    return obj;
  });
}

interface Row {
  name: string;
  note: string | null;
  count: number;
}

const cols: CsvColumn<Row>[] = [
  { header: "Name", value: (r) => r.name },
  { header: "Note", value: (r) => r.note },
  { header: "Count", value: (r) => String(r.count) },
];

// The parser lives on the IMPORT side (scripts/import/_shared.mts). Round-tripping
// through it is the strongest guarantee the writer is well-formed: strip BOM,
// quoted fields, "" escapes, CRLF. It trims fields, so these assertions describe
// import-visible values.
function roundTrip(csv: string): Record<string, string>[] {
  return parseCsv(csv);
}

describe("toCsv", () => {
  it("writes a header row then one row per record", () => {
    const csv = toCsv(cols, [
      { name: "Alice", note: "vip", count: 2 },
      { name: "Bob", note: null, count: 0 },
    ]);
    const rows = roundTrip(csv);
    expect(rows).toEqual([
      { Name: "Alice", Note: "vip", Count: "2" },
      { Name: "Bob", Note: "", Count: "0" },
    ]);
  });

  it("starts with a UTF-8 BOM so Excel reads Greek/Cyrillic correctly", () => {
    // Paphos data is full of Greek and Russian names; without the BOM Excel
    // renders them as mojibake. This is the single most important detail here.
    const csv = toCsv(cols, [{ name: "Δημήτρης Σαββίδης", note: "Кириллица", count: 1 }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(roundTrip(csv)[0]).toEqual({
      Name: "Δημήτρης Σαββίδης",
      Note: "Кириллица",
      Count: "1",
    });
  });

  it("uses CRLF line endings (RFC 4180)", () => {
    const csv = toCsv(cols, [{ name: "Alice", note: "x", count: 1 }]);
    expect(csv.replace(/^﻿/, "").split("\r\n").length).toBe(3); // header + 1 row + trailing
  });

  it("quotes and escapes fields containing comma, quote, or newline", () => {
    const csv = toCsv(cols, [
      { name: 'Smith, John', note: 'said "hello"', count: 1 },
      { name: "line one\nline two", note: null, count: 2 },
    ]);
    const rows = roundTrip(csv);
    expect(rows[0]).toEqual({ Name: "Smith, John", Note: 'said "hello"', Count: "1" });
    expect(rows[1]).toEqual({ Name: "line one\nline two", Note: "", Count: "2" });
  });

  it("neutralises spreadsheet formula injection on user-controlled leading chars", () => {
    // A field like =HYPERLINK(...) or +1+1 is executed as a formula when the CSV
    // is opened in Excel/Sheets. These values are user-typed (names, notes), so
    // prefix a risky leading char with a single quote to force text.
    const csv = toCsv(cols, [
      { name: "=1+1", note: "@handle", count: 1 },
      { name: "+44 79...", note: "-lead", count: 2 },
      { name: "\ttab-lead", note: null, count: 3 },
    ]);
    const rows = roundTrip(csv);
    expect(rows[0].Name).toBe("'=1+1");
    expect(rows[0].Note).toBe("'@handle");
    expect(rows[1].Name).toBe("'+44 79...");
    expect(rows[1].Note).toBe("'-lead");
    expect(rows[2].Name).toBe("'\ttab-lead");
  });

  it("does not prefix an ordinary field that merely contains a symbol later", () => {
    const csv = toCsv(cols, [{ name: "A=B later", note: "e@mail.com is fine mid-value", count: 1 }]);
    const rows = roundTrip(csv);
    // note: parser trims, but the leading char here is 'e', not risky
    expect(rows[0].Name).toBe("A=B later");
    expect(rows[0].Note).toBe("e@mail.com is fine mid-value");
  });

  it("renders an empty record set as a header-only document", () => {
    const csv = toCsv(cols, []);
    expect(roundTrip(csv)).toEqual([]);
    expect(csv.replace(/^﻿/, "")).toBe("Name,Note,Count\r\n");
  });
});
