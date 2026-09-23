import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KNOWN_CONTACT_COLUMNS,
  KNOWN_PROPERTY_COLUMNS,
  PROPERTY_NUMBER_COLUMNS,
  measurementRefusal,
  parseNumberColumns,
} from "./_rules.mts";
import { CsvStructureError, loadCsv, parseCsvTable } from "./_shared.mts";

/**
 * A CSV file's STRUCTURE is checked before any of its values are read
 * (2026-09-23). The reader used to take whatever a line held: surplus cells
 * were dropped, so an unquoted `1,250,000` imported as a price of 1 and an
 * area of 250; a missing cell was padded to blank; a repeated header let the
 * second column overwrite the first; and a quote that never closed swallowed
 * the rest of the file without a word. None of it tripped the number or the
 * measurement rules, because by then every value looked plausible.
 */

/** The problems a file is refused for; [] when it parses. */
function problemsOf(text: string): string[] {
  try {
    parseCsvTable(text);
  } catch (e) {
    return (e as { problems?: string[] }).problems ?? [`not a structure refusal: ${String(e)}`];
  }
  return [];
}

const H = "reference,property_type,district_code,asking_price,covered_area_sqm";
const BOM = String.fromCharCode(0xfeff);

describe("the four audit cases — refused, never guessed", () => {
  it("A: surplus cells (an unquoted 1,250,000) are refused, not dropped", () => {
    expect(problemsOf(`${H}\nAUDIT,apartment,PAF,1,250,000,85.5\n`)).toEqual([
      'line 2: expected 5 cells (one per header column), found 7 — a value that contains "," must be wrapped in double quotes, e.g. "1,250,000"',
    ]);
  });

  it("B: a repeated header name is refused, not overwritten by its second column", () => {
    expect(
      problemsOf(
        "reference,property_type,district_code,asking_price,asking_price,covered_area_sqm\nAUDIT,apartment,PAF,250000,150000,85.5\n",
      ),
    ).toEqual(['line 1 (header): column "asking_price" appears more than once (columns 4, 5) — keep one']);
  });

  it("C: a quote that never closes is refused where it opens", () => {
    expect(problemsOf(`${H}\nAUDIT,apartment,PAF,250000,"85.5\n`)).toEqual([
      "line 2, column 5 (covered_area_sqm): the double quote that opens this value is never closed",
    ]);
  });

  it("D: a missing cell is refused, not padded to blank", () => {
    expect(problemsOf(`${H}\nAUDIT,apartment,PAF,250000\n`)).toEqual([
      "line 2: expected 5 cells (one per header column), found 4 — every row needs a separator for every column, even an empty one",
    ]);
  });

  it("the refusal is a CsvStructureError and nothing is returned", () => {
    expect(() => parseCsvTable(`${H}\nAUDIT,apartment,PAF,1,250,000,85.5\n`)).toThrow(CsvStructureError);
  });

  it("a semicolon file names its own separator and example", () => {
    expect(problemsOf("reference;features\nZZ1;pool;garden\n")).toEqual([
      'line 2: expected 2 cells (one per header column), found 3 — a value that contains ";" must be wrapped in double quotes, e.g. "pool;garden"',
    ]);
  });
});

describe("the header", () => {
  it("refuses a column with no name", () => {
    expect(problemsOf("reference,,district_code\nZZ1,x,PAF\n")).toEqual([
      "line 1 (header): column 2 has no name — delete the empty column (a separator at the end of the header line makes one)",
    ]);
  });

  it("refuses the blank column a trailing separator makes, even when every row has one too", () => {
    expect(problemsOf("reference,district_code,\nZZ1,PAF,\n")).toEqual([
      "line 1 (header): column 3 has no name — delete the empty column (a separator at the end of the header line makes one)",
    ]);
  });

  it("a name of spaces is no name", () => {
    expect(problemsOf("reference, ,district_code\nZZ1,x,PAF\n")).toHaveLength(1);
  });

  it("compares names after the existing trim, and lists every position of a repeat", () => {
    expect(problemsOf("reference, bedrooms,bedrooms ,kind,bedrooms\nZZ1,1,2,standalone,3\n")).toEqual([
      'line 1 (header): column "bedrooms" appears more than once (columns 2, 3, 5) — keep one',
    ]);
  });

  it("does not fold case: Bedrooms is a different (unknown) column, left to the unknown-column check", () => {
    expect(problemsOf("bedrooms,Bedrooms\n2,3\n")).toEqual([]);
  });
});

describe("quoting", () => {
  it("refuses a quote inside an unquoted value", () => {
    expect(problemsOf(`${H}\nAUDIT,apartment,PAF,12"5,85.5\n`)).toEqual([
      'line 2, column 4 (asking_price): a double quote inside an unquoted value — wrap the whole value in double quotes and write each quote inside it twice ("")',
    ]);
  });

  it("refuses text after a closing quote", () => {
    expect(problemsOf(`${H}\nAUDIT,apartment,PAF,"1,250"000,85.5\n`)).toEqual([
      "line 2, column 4 (asking_price): text after the closing double quote — a quoted value must end at its closing quote",
    ]);
  });

  it("an unclosed quote that swallows later lines is reported at the line that opened it", () => {
    const problems = problemsOf(`${H}\nAUDIT1,apartment,PAF,"250000,85.5\nAUDIT2,villa,PAF,650000,180\n`);
    expect(problems).toEqual([
      "line 2, column 4 (asking_price): the double quote that opens this value is never closed",
    ]);
  });

  it("allows spaces around a quoted value (they are trimmed like any cell)", () => {
    const { rows } = parseCsvTable(`${H}\nAUDIT,apartment,PAF, "1,250,000" ,85.5\n`);
    expect(rows[0].asking_price).toBe("1,250,000");
  });
});

describe("the whole file is checked before a single row is returned", () => {
  it("valid rows followed by a malformed final row: refused, no row returned", () => {
    const text = `${H}\nZZ1,apartment,PAF,250000,85.5\nZZ2,villa,PAF,650000,180\nZZ3,apartment,PAF,1,250,000,85.5\n`;
    expect(() => parseCsvTable(text)).toThrow(CsvStructureError);
    expect(problemsOf(text)).toEqual([
      'line 4: expected 5 cells (one per header column), found 7 — a value that contains "," must be wrapped in double quotes, e.g. "1,250,000"',
    ]);
  });

  it("reports every problem, in file order", () => {
    const text =
      "reference,asking_price,asking_price\n" + // header repeat
      "ZZ1,1,2,3\n" + // surplus
      "ZZ2,1\n" + // missing
      'ZZ3,"1,2"x,3\n'; // text after a quote
    expect(problemsOf(text).map((p) => p.split(":")[0])).toEqual([
      "line 1 (header)",
      "line 2",
      "line 3",
      "line 4, column 2 (asking_price)",
    ]);
  });

  it("line numbers are PHYSICAL lines — a quoted line break before the bad row counts", () => {
    const text = 'reference,title_en,asking_price\nZZ1,"Villa\nwith a view",250000\nZZ2,Flat,1,250,000\n';
    expect(problemsOf(text)[0]).toMatch(/^line 4: expected 3 cells .* found 5/);
  });

  it("and skipped blank lines count too", () => {
    expect(problemsOf("reference,asking_price\n\nZZ1,1,2\n")[0]).toMatch(/^line 3: /);
    expect(problemsOf("reference,asking_price\r\n\r\nZZ1,1,2\r\n")[0]).toMatch(/^line 3: /);
  });

  it("never prints a cell's value — the report carries positions, counts and header names only", () => {
    const text =
      "first_name,last_name,phone,email\n" +
      "Maria,Constantinou,99 12 34 56,maria.c@example.com,extra\n" +
      'Andreas,"Georgiou,99 11 22 33,andreas@example.com\n';
    const joined = problemsOf(text).join("\n");
    expect(joined).not.toBe("");
    for (const secret of ["Maria", "Constantinou", "99 12 34 56", "maria.c@", "Andreas", "Georgiou", "99 11 22 33"]) {
      expect(joined).not.toContain(secret);
    }
  });
});

describe("well-formed files keep every value they had", () => {
  const priceAndArea = (text: string) => {
    const { rows } = parseCsvTable(text);
    expect(rows).toHaveLength(1);
    const { values, errors } = parseNumberColumns(rows[0], PROPERTY_NUMBER_COLUMNS);
    const refusal = measurementRefusal({
      covered_area_sqm: values.covered_area_sqm,
      plot_area_sqm: values.plot_area_sqm,
      floor_number: values.floor_number,
      total_floors: values.total_floors,
    });
    return { price: values.asking_price, area: values.covered_area_sqm, errors, refusal };
  };

  it("control: a comma file with the price quoted", () => {
    expect(priceAndArea(`${H}\nAUDIT,apartment,PAF,"1,250,000",85.5\n`)).toEqual({
      price: 1250000,
      area: 85.5,
      errors: [],
      refusal: null,
    });
  });

  it("control: a semicolon file with Greek number marks", () => {
    expect(
      priceAndArea(
        "reference;property_type;district_code;asking_price;covered_area_sqm\nAUDIT;apartment;PAF;1.250.000;85,5\n",
      ),
    ).toEqual({ price: 1250000, area: 85.5, errors: [], refusal: null });
  });

  it("escaped quotes, quoted line breaks and quoted separators", () => {
    const { rows } = parseCsvTable(
      'reference,title_en,address,features\r\nZZ1,"Villa ""Sunrise""","12 Poseidonos Ave,\r\nChloraka","pool;garden"\r\n',
    );
    expect(rows).toEqual([
      { reference: "ZZ1", title_en: 'Villa "Sunrise"', address: "12 Poseidonos Ave,\r\nChloraka", features: "pool;garden" },
    ]);
  });

  it("explicitly empty cells — bare or quoted — are empty, not missing", () => {
    const { rows } = parseCsvTable(`${H}\nAUDIT,apartment,PAF,,""\n`);
    expect(rows).toEqual([
      { reference: "AUDIT", property_type: "apartment", district_code: "PAF", asking_price: "", covered_area_sqm: "" },
    ]);
  });

  it("a UTF-8 BOM, CRLF, LF and a missing final line break", () => {
    for (const text of [
      `${BOM}${H}\r\nAUDIT,apartment,PAF,1,2\r\n`,
      `${H}\nAUDIT,apartment,PAF,1,2\n`,
      `${H}\nAUDIT,apartment,PAF,1,2`,
    ]) {
      const { header, rows } = parseCsvTable(text);
      expect(header[0]).toBe("reference");
      expect(rows).toEqual([
        { reference: "AUDIT", property_type: "apartment", district_code: "PAF", asking_price: "1", covered_area_sqm: "2" },
      ]);
    }
  });

  it("blank lines — empty, or nothing but spaces — are skipped wherever they fall", () => {
    const { rows } = parseCsvTable("reference,asking_price\n\nZZ1,1\n   \n\nZZ2,2\n\n\n");
    expect(rows).toEqual([
      { reference: "ZZ1", asking_price: "1" },
      { reference: "ZZ2", asking_price: "2" },
    ]);
  });

  it("an optional column may be left out of the header entirely", () => {
    const { rows } = parseCsvTable("reference,property_type,district_code\nZZ1,land,PAF\n");
    expect(parseNumberColumns(rows[0], PROPERTY_NUMBER_COLUMNS).values.asking_price).toBeNull();
  });

  it("a header with no rows is an empty import, not an error", () => {
    expect(parseCsvTable(`${H}\n`)).toEqual({ header: H.split(","), rows: [] });
  });

  it.each([
    ["contacts_import.csv", KNOWN_CONTACT_COLUMNS, 5],
    ["properties_import.csv", KNOWN_PROPERTY_COLUMNS, 3],
  ])("the committed sample %s still parses whole", (name, known, count) => {
    const text = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "samples", name),
      "utf8",
    );
    const { header, rows } = parseCsvTable(text);
    expect(header.every((h) => (known as readonly string[]).includes(h))).toBe(true);
    expect(rows).toHaveLength(count);
    for (const row of rows) expect(Object.keys(row)).toEqual(header);
  });
});

describe("loadCsv — the importers' loader", () => {
  let dir: string;
  let errors: string[];
  let warnings: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "csv-structure-"));
    errors = [];
    warnings = [];
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warnings.push(a.join(" ")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  it("stops the run on a malformed file, naming the file, the line and the counts", () => {
    const path = file("audit-a.csv", `${H}\nZZ1,apartment,PAF,250000,85.5\nAUDIT,apartment,PAF,1,250,000,85.5\n`);
    expect(() => loadCsv(path, KNOWN_PROPERTY_COLUMNS)).toThrow("process.exit(1)");
    const out = errors.join("\n");
    expect(out).toContain(path);
    expect(out).toContain("line 3: expected 5 cells (one per header column), found 7");
    expect(out).toMatch(/nothing was imported/i);
  });

  it("--allow-extra does not bypass it", () => {
    const path = file(
      "audit-b.csv",
      "reference,property_type,district_code,asking_price,asking_price\nAUDIT,apartment,PAF,250000,150000\n",
    );
    expect(() => loadCsv(path, KNOWN_PROPERTY_COLUMNS, true)).toThrow("process.exit(1)");
    expect(errors.join("\n")).toContain('column "asking_price" appears more than once');
  });

  it("--allow-extra still ignores an unknown column in a well-formed file, as documented", () => {
    const path = file("extra.csv", `${H},colour\nAUDIT,apartment,PAF,"1,250,000",85.5,blue\n`);
    const rows = loadCsv(path, KNOWN_PROPERTY_COLUMNS, true);
    expect(rows).toHaveLength(1);
    expect(rows[0].asking_price).toBe("1,250,000");
    expect(warnings.join("\n")).toContain("colour");
  });

  it("lists at most twenty problems, then says how many more", () => {
    const bad = Array.from({ length: 25 }, (_, i) => `ZZ${i},apartment,PAF,1,250,000,85.5`).join("\n");
    const path = file("many.csv", `${H}\n${bad}\n`);
    expect(() => loadCsv(path, KNOWN_PROPERTY_COLUMNS)).toThrow("process.exit(1)");
    const out = errors.join("\n");
    expect(out.match(/^ {2}line \d+:/gm)).toHaveLength(20);
    expect(out).toContain("and 5 more");
  });
});
