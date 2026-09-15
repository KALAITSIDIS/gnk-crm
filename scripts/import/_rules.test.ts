import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  batchIdFor,
  insertVisibilityFor,
  KNOWN_CONTACT_COLUMNS,
  KNOWN_PROPERTY_COLUMNS,
  publishDecision,
  unknownColumns,
} from "./_rules.mts";

/**
 * The importers' pure rules (audit 2026-09-15, LST-02 and LST-10).
 *
 * Three things the CSV path used to do without saying so: accept any header
 * and silently import a misspelt column as null; write `visibility` straight
 * from the file, so a standalone row could go public with no score, no gate
 * and no publish stamp; and leave no batch identity on the rows it created.
 */
describe("unknownColumns", () => {
  it("names the headers the template does not know, in file order", () => {
    expect(unknownColumns(["reference", "bedroom", "kind", "Bathrooms"], ["reference", "kind", "bedrooms"])).toEqual([
      "bedroom",
      "Bathrooms",
    ]);
  });

  it("reports a blank header cell — a trailing comma is a column nothing will read", () => {
    expect(unknownColumns(["reference", ""], ["reference"])).toEqual(["(blank)"]);
  });

  it("is empty when every header is known", () => {
    expect(unknownColumns(["kind", "reference"], ["reference", "kind"])).toEqual([]);
  });
});

describe("insertVisibilityFor — what the row is written with, before its score exists", () => {
  it("holds a standalone row requested public as private until it has been scored", () => {
    expect(insertVisibilityFor("public", "standalone")).toBe("private");
    expect(insertVisibilityFor("public", "unit")).toBe("private");
  });

  it("keeps the container rule: a project or phase requested public imports as coming_soon", () => {
    expect(insertVisibilityFor("public", "project")).toBe("coming_soon");
    expect(insertVisibilityFor("public", "phase")).toBe("coming_soon");
  });

  it("passes every other visibility through untouched", () => {
    expect(insertVisibilityFor("private", "standalone")).toBe("private");
    expect(insertVisibilityFor("coming_soon", "standalone")).toBe("coming_soon");
    expect(insertVisibilityFor("off_market", "unit")).toBe("off_market");
  });
});

describe("publishDecision — after the row exists and has a score", () => {
  it("publishes a standalone row requested public whose score clears the threshold", () => {
    expect(publishDecision({ requested: "public", kind: "standalone", score: 70, threshold: 70 })).toEqual({
      publish: true,
      note: null,
    });
  });

  it("refuses below the threshold and says the numbers, so the report is an instruction", () => {
    const d = publishDecision({ requested: "public", kind: "unit", score: 60, threshold: 70 });
    expect(d.publish).toBe(false);
    expect(d.note).toMatch(/60/);
    expect(d.note).toMatch(/70/);
    expect(d.note).toMatch(/private/);
  });

  it("never publishes a container from the importer, whatever its score", () => {
    const d = publishDecision({ requested: "public", kind: "project", score: 100, threshold: 70 });
    expect(d.publish).toBe(false);
    expect(d.note).toMatch(/coming_soon/);
  });

  it("does nothing when public was not requested", () => {
    expect(publishDecision({ requested: "private", kind: "standalone", score: 100, threshold: 70 })).toEqual({
      publish: false,
      note: null,
    });
  });
});

describe("batchIdFor", () => {
  it("derives a sortable id from the run time and the file name", () => {
    expect(batchIdFor("docs/samples/properties_import.csv", new Date("2026-09-15T20:07:03Z"))).toBe(
      "20260915-200703-properties_import",
    );
  });

  it("uses an explicit id verbatim when one is given", () => {
    expect(batchIdFor("x.csv", new Date(), "onboarding-2026-10")).toBe("onboarding-2026-10");
  });
});

/**
 * The known-column lists are pinned to doc 09, both ways: a column the doc
 * describes must be accepted, and a column the importer reads must be
 * documented. A CSV template that drifts from its own documentation is how
 * a misspelt column becomes "normal".
 */
describe("KNOWN_*_COLUMNS agree with docs/09_DATA_IMPORT_TEMPLATES.md", () => {
  const doc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "09_DATA_IMPORT_TEMPLATES.md"),
    "utf8",
  );

  /** First cell of every table row under the named heading, split on " / ". */
  const documented = (heading: string): string[] => {
    const start = doc.indexOf("## " + heading);
    expect(start, heading + " heading present").toBeGreaterThan(-1);
    const rest = doc.slice(start + heading.length + 3);
    const end = rest.indexOf("\n## ");
    const section = end === -1 ? rest : rest.slice(0, end);
    return section
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| Column") && !line.startsWith("|---"))
      .flatMap((line) => line.split("|")[1]!.split("/").map((c) => c.trim()))
      .filter(Boolean);
  };

  it("contacts", () => {
    expect([...KNOWN_CONTACT_COLUMNS].sort()).toEqual(documented("contacts_import.csv").sort());
  });

  it("properties", () => {
    expect([...KNOWN_PROPERTY_COLUMNS].sort()).toEqual(documented("properties_import.csv").sort());
  });
});
