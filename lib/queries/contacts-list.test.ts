import { describe, expect, it } from "vitest";
import { applyContactListFilters, parseContactListFilters } from "./contacts-list";

const AGENT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c01";

describe("parseContactListFilters", () => {
  it("reads every filter the list understands", () => {
    const f = parseContactListFilters({
      q: "  smith ",
      type: "buyer",
      temperature: "hot",
      source: "referral",
      agent: AGENT,
      nationality: " GB ",
      language: "el",
      archived: "1",
    });
    expect(f).toEqual({
      q: "smith",
      type: "buyer",
      temperature: "hot",
      source: "referral",
      agent: AGENT,
      nationality: "GB",
      language: "el",
      archived: true,
    });
  });

  it("defaults to the active (non-archived) scope and drops blanks", () => {
    const f = parseContactListFilters({ q: "   ", nationality: "" });
    expect(f.archived).toBe(false);
    expect(f.q).toBeUndefined();
    expect(f.nationality).toBeUndefined();
    expect(f.type).toBeUndefined();
  });

  it("treats archived as true only for the exact flag '1'", () => {
    expect(parseContactListFilters({ archived: "1" }).archived).toBe(true);
    expect(parseContactListFilters({ archived: "true" }).archived).toBe(false);
    expect(parseContactListFilters({ archived: "0" }).archived).toBe(false);
    expect(parseContactListFilters({}).archived).toBe(false);
  });

  it("takes the first value when a param repeats", () => {
    expect(parseContactListFilters({ type: ["buyer", "seller"] }).type).toBe("buyer");
  });

  /*
   * T-malformed-ids: `agent` is sent as `.eq("assigned_agent_id", …)` on a
   * uuid column, so a hand-typed or stale `?agent=` that is not an id made
   * PostgREST answer 22P02 — the contacts page's error boundary, and the
   * export's "failed… Try again" (MEASURED 2026-10-12). An id filter that is
   * not an id is no filter: dropped as if absent, like propertyFiltersSchema's
   * optionalUuid. The page and the export share this parser.
   */
  it("drops an agent filter that is not an id, as if it were absent", () => {
    for (const bad of ["notauuid", "agent-1", "1", `${AGENT},x`, ` ${AGENT}x`]) {
      expect(parseContactListFilters({ agent: bad }).agent, bad).toBeUndefined();
    }
    // the first of a repeated key is the one judged, as for every other filter
    expect(parseContactListFilters({ agent: ["notauuid", AGENT] }).agent).toBeUndefined();
  });

  it("keeps a well-formed agent id — trimmed, as before", () => {
    expect(parseContactListFilters({ agent: ` ${AGENT} ` }).agent).toBe(AGENT);
    expect(parseContactListFilters({ agent: [AGENT, "notauuid"] }).agent).toBe(AGENT);
  });

  it("a dropped agent filter never reaches the query; a kept one does", () => {
    const eqs = (sp: Record<string, string>) => {
      const calls: unknown[][] = [];
      const builder = {
        or: () => builder,
        eq: (...args: unknown[]) => {
          calls.push(args);
          return builder;
        },
        contains: () => builder,
        ilike: () => builder,
      };
      applyContactListFilters(builder, parseContactListFilters(sp));
      return calls;
    };
    expect(eqs({ agent: "notauuid" })).toEqual([["is_archived", false]]);
    expect(eqs({ agent: AGENT })).toEqual([
      ["is_archived", false],
      ["assigned_agent_id", AGENT],
    ]);
  });
});
