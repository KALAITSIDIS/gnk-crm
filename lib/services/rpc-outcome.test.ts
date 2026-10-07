import { describe, expect, it } from "vitest";
import { certainlyRolledBack } from "@/lib/services/rpc-outcome";
import { insertDefinitelyRefused } from "@/lib/services/media-upload";

/**
 * The one classifier for "did this request's transaction certainly NOT
 * commit?" (close_deal, record_price_list_version, the property_media insert).
 * An allowlist: only codes whose semantics were read from PostgREST's and
 * PostgreSQL's source say "rolled back"; everything else is unknown
 * (DECISIONS T-media-insert-outcome).
 */
const DEFINITE = [
  // the database refused the statement, before any commit record
  "42501", "42P01", "23505", "23503", "23514", "22P02", "22001", "40001", "40P01",
  "55P03", "P0001", "0A000", "21000", "25006", "2D000", "44000", "54000",
  // PostgREST refused before running it, or condemned the transaction
  "PGRST002", "PGRST003", "PGRST100", "PGRST102", "PGRST105", "PGRST108", "PGRST115",
  "PGRST121", "PGRST124", "PGRST128", "PGRST200", "PGRST202", "PGRST204", "PGRST205",
  "PGRST300", "PGRST301", "PGRST303",
];

const UNKNOWN: unknown[] = [
  // no answer from the database at all
  "", undefined, null, 503, {},
  // connection exceptions: can arrive after a COMMIT that went through
  "08000", "08003", "08006", "08001", "PGRST000", "PGRST001",
  // classes that can be reported for a committed transaction
  "57014", "57P01", "53100", "53200", "58030", "XX000", "40003",
  // built after the commit (111/112 measured committed), or by postgrest-js after a 2xx
  "PGRST103", "PGRST111", "PGRST112", "PGRST116",
  // nobody has classified these
  "PGRST999", "PGRST109", "PGRSTX00", "PT402", "ERROR", "418", "pgrst204", " 42501",
  // never raised by v14.5 / v16.1 (no raise site): not understood, so unknown
  "PGRST104", "PGRST120",
  // one past each allowlisted range, and classes nobody listed
  "PGRST004", "PGRST119", "PGRST129", "PGRST206", "PGRST304",
  "72000", "38000", "F0000", "HV000", "39000", "2F000",
  // a gateway body's NUMBER that spells a SQLSTATE is still not PostgREST's code
  42501, 23514, 40001,
];

describe("certainlyRolledBack — an allowlist, never 'any code'", () => {
  it.each(DEFINITE)("%s: certainly rolled back", (code) => {
    expect(certainlyRolledBack(code)).toBe(true);
  });
  it.each(UNKNOWN.map((c) => [JSON.stringify(c) ?? String(c), c]))("%s: unknown", (_label, code) => {
    expect(certainlyRolledBack(code)).toBe(false);
  });
});

describe("insertDefinitelyRefused — the media insert's licence to delete", () => {
  it("RLS (42501), a constraint, a PostgREST refusal: definite", () => {
    for (const code of ["42501", "23514", "23503", "PGRST204", "PGRST301"]) {
      expect(insertDefinitelyRefused({ code }), code).toBe(true);
    }
  });
  it("23505 on the attempt id names an EXISTING row: not a licence to delete", () => {
    expect(insertDefinitelyRefused({ code: "23505" })).toBe(false);
  });
  it("no error, no code, an unknown code: not a licence to delete", () => {
    for (const e of [null, {}, { code: "" }, { code: null }, { code: "PGRST001" }, { code: "08006" }, { code: 42501 }, { code: "PGRST111" }]) {
      expect(insertDefinitelyRefused(e as never), JSON.stringify(e)).toBe(false);
    }
  });
});
