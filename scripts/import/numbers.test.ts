import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTACT_NUMBER_COLUMNS,
  delimiterOf,
  parseNumberCell,
  parseNumberColumns,
  PROPERTY_NUMBER_COLUMNS,
} from "./_rules.mts";
import { parseCsvTable } from "./_shared.mts";

/**
 * Numbers as Cyprus writes them (2026-09-23). The importer used to strip
 * every comma before Number(), so a Greek-style `85,5` m² imported as 855 —
 * ten times too large, silently — `1.200,50` as 1.2005, and anything with a
 * symbol (`€250,000`) as a blank. Both conventions are in daily use here:
 * the Greek one (decimal comma, dot thousands — what Excel writes under Greek
 * regional settings) and the English one (decimal dot, comma thousands).
 */

const value = (raw: string, kind: Parameters<typeof parseNumberCell>[1]) => {
  const r = parseNumberCell(raw, kind);
  return "error" in r && r.error !== undefined ? `ERROR: ${r.error}` : r.value;
};

describe("amounts (prices, areas, lengths) — either Cyprus convention", () => {
  it.each([
    // the reported defect: a decimal comma
    ["85,5", 85.5],
    ["85,50", 85.5],
    ["0,5", 0.5],
    ["0,004", 0.004],
    // the English decimal, unchanged
    ["85.5", 85.5],
    ["0.004", 0.004],
    ["12.25", 12.25],
    // a single separator + exactly three digits is a THOUSANDS separator in
    // either convention — nobody writes a price or an area to three decimals
    ["1.200", 1200],
    ["1,200", 1200],
    ["250.000", 250000],
    ["250,000", 250000],
    // several groups
    ["1.234.567", 1234567],
    ["1,234,567", 1234567],
    // both marks: the LAST one is the decimal
    ["1.200,50", 1200.5],
    ["1,200.50", 1200.5],
    ["1.234.567,89", 1234567.89],
    // spaces as thousands (incl. the no-break space Excel and Word insert)
    ["1 200", 1200],
    ["1 200,5", 1200.5],
    // plain
    ["95", 95],
    ["-1", -1],
    ["−1", -1], // a typographic minus
    ["+3", 3],
  ])("%j → %s", (raw, expected) => {
    expect(value(raw, "amount")).toBe(expected);
  });

  it.each([[""], ["   "]])("a blank cell (%j) is null — unknown, never 0", (raw) => {
    expect(value(raw, "amount")).toBeNull();
  });

  it.each([
    ["€250,000", "a symbol"],
    ["185 m²", "a unit"],
    ["abc", "text"],
    ["1e3", "an exponent"],
    ["0x10", "hex"],
    ["85,", "a dangling separator"],
    ["1,20,000", "a malformed grouping"],
    ["1.234,567.8", "a decimal mark used twice"],
    ["12,34.5", "a thousands group that is not three digits"],
  ])("refuses %j (%s) instead of guessing or blanking it", (raw) => {
    expect(value(raw, "amount")).toMatch(/^ERROR: /);
  });
});

describe("coordinates and percentages — a single separator is always the decimal mark", () => {
  it.each([
    ["34.7754", 34.7754],
    ["34,7754", 34.7754],
    // exactly three decimals must NOT become thousands here: 34.775 is a latitude
    ["34.775", 34.775],
    ["34,775", 34.775],
    ["32.424", 32.424],
    ["2,5", 2.5],
    ["12.500", 12.5],
    ["120", 120],
    ["-0,5", -0.5],
  ])("%j → %s", (raw, expected) => {
    expect(value(raw, "decimal")).toBe(expected);
  });

  it.each([["1.234,5"], ["34.775.1"], ["1,234,567"]])("refuses %j — these never carry thousands", (raw) => {
    expect(value(raw, "decimal")).toMatch(/^ERROR: /);
  });
});

describe("whole numbers (rooms, floors, year) — a fraction is refused, not truncated", () => {
  it.each([
    ["2", 2],
    ["0", 0],
    ["-1", -1],
    ["2021", 2021],
  ])("%j → %s", (raw, expected) => {
    expect(value(raw, "integer")).toBe(expected);
  });

  it.each([
    ["2,5", "a decimal comma — used to be 25 bedrooms"],
    ["2.9", "used to be truncated to 2"],
    ["0.4", "used to be truncated to 0"],
  ])("refuses %j (%s)", (raw) => {
    expect(value(raw, "integer")).toMatch(/^ERROR: .*whole number/);
  });
});

describe("parseNumberColumns — every numeric column of a row, every refusal named", () => {
  it("parses a Greek-style row", () => {
    const { values, errors } = parseNumberColumns(
      {
        latitude: "34,7754",
        longitude: "32,4245",
        asking_price: "250.000",
        covered_area_sqm: "85,5",
        plot_area_sqm: "",
        bedrooms: "2",
        floor_number: "-1",
        mandate_commission_pct: "2,5",
      },
      PROPERTY_NUMBER_COLUMNS,
    );
    expect(errors).toEqual([]);
    expect(values).toMatchObject({
      latitude: 34.7754,
      longitude: 32.4245,
      asking_price: 250000,
      covered_area_sqm: 85.5,
      plot_area_sqm: null,
      bedrooms: 2,
      floor_number: -1,
      mandate_commission_pct: 2.5,
      total_floors: null, // absent column → unknown
    });
  });

  it("reports EVERY unreadable cell with its column, not only the first", () => {
    const { errors } = parseNumberColumns(
      { asking_price: "€250,000", bedrooms: "2,5", covered_area_sqm: "85,5" },
      PROPERTY_NUMBER_COLUMNS,
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^asking_price: /);
    expect(errors[1]).toMatch(/^bedrooms: .*whole number/);
  });

  it("contacts: a budget written either way", () => {
    const { values, errors } = parseNumberColumns(
      { budget_min: "250.000", budget_max: "400,000", pref_bedrooms_min: "3" },
      CONTACT_NUMBER_COLUMNS,
    );
    expect(errors).toEqual([]);
    expect(values).toEqual({ budget_min: 250000, budget_max: 400000, pref_bedrooms_min: 3 });
  });
});

describe("the numeric-column maps agree with docs/09_DATA_IMPORT_TEMPLATES.md", () => {
  // Every column the doc documents as a number/int/decimal is parsed as one,
  // and nothing else is — a numeric column missing from the map would be read
  // as raw text by nobody, and silently dropped.
  const doc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "09_DATA_IMPORT_TEMPLATES.md"),
    "utf8",
  );
  const numericColumns = (heading: string): string[] => {
    const start = doc.indexOf("## " + heading);
    const rest = doc.slice(start + heading.length + 3);
    const end = rest.indexOf("\n## ");
    return (end === -1 ? rest : rest.slice(0, end))
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| Column"))
      .map((line) => line.split("|").map((c) => c.trim()))
      .filter((cells) => /^(number|int|decimal)\b/.test(cells[3] ?? ""))
      .flatMap((cells) => cells[1]!.split("/").map((c) => c.trim()));
  };

  it("properties", () => {
    expect(Object.keys(PROPERTY_NUMBER_COLUMNS).sort()).toEqual(numericColumns("properties_import.csv").sort());
  });

  it("contacts", () => {
    expect(Object.keys(CONTACT_NUMBER_COLUMNS).sort()).toEqual(numericColumns("contacts_import.csv").sort());
  });
});

describe("semicolon files — what Excel saves under Greek regional settings", () => {
  it.each([
    ["reference,kind,covered_area_sqm", ","],
    ["reference;kind;covered_area_sqm", ";"],
    ['"reference";"kind"', ";"],
    ["reference", ","],
  ])("delimiterOf(%j) = %j", (line, expected) => {
    expect(delimiterOf(line)).toBe(expected);
  });

  it("parses a Greek-locale Excel export: semicolons between cells, decimal commas and ;-lists inside", () => {
    const csv =
      "﻿reference;title_en;covered_area_sqm;features\r\n" +
      'ZZ1;Flat;85,5;"pool;garden"\r\n' +
      'ZZ2;"Villa; sea view";1.200;\r\n';
    const { header, rows } = parseCsvTable(csv);
    expect(header).toEqual(["reference", "title_en", "covered_area_sqm", "features"]);
    expect(rows).toEqual([
      { reference: "ZZ1", title_en: "Flat", covered_area_sqm: "85,5", features: "pool;garden" },
      { reference: "ZZ2", title_en: "Villa; sea view", covered_area_sqm: "1.200", features: "" },
    ]);
  });

  it("a comma file with a quoted decimal comma still parses as before", () => {
    const { rows } = parseCsvTable('reference,covered_area_sqm\nZZ1,"85,5"\n');
    expect(rows).toEqual([{ reference: "ZZ1", covered_area_sqm: "85,5" }]);
  });
});
