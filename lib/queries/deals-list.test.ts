import { describe, expect, it } from "vitest";
import {
  applyDealListFilters,
  applyDealTypeFilter,
  closedRangeFilter,
  isDealListFiltered,
  parseDealListFilters,
  parseDealType,
} from "./deals-list";
import { isDayKey } from "@/lib/validators/deals";
import { zonedDateRangeToUtc } from "@/lib/utils/tz";

describe("parseDealType", () => {
  it("defaults to sale and keeps a valid tab", () => {
    expect(parseDealType({})).toBe("sale");
    expect(parseDealType({ type: "rental" })).toBe("rental");
    expect(parseDealType({ type: "advisory" })).toBe("advisory");
    expect(parseDealType({ type: "bogus" })).toBe("sale");
    expect(parseDealType({ type: ["antiparoxi", "sale"] })).toBe("antiparoxi");
  });
});

describe("applyDealTypeFilter", () => {
  it("filters the query to the chosen deal_type", () => {
    const calls: unknown[][] = [];
    const q: Record<string, (...a: unknown[]) => unknown> = {
      eq: (...args) => {
        calls.push(args);
        return q;
      },
    };
    applyDealTypeFilter(q as never, "rental");
    expect(calls[0]).toEqual(["deal_type", "rental"]);
  });
});

// ---------------------------------------------------------------------------
// The /deals register (F05)
// ---------------------------------------------------------------------------

/** A builder that records every filter call, in order, as [method, ...args]. */
function spy() {
  const calls: unknown[][] = [];
  const q: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ["eq", "in", "or", "ilike"]) {
    q[m] = (...args) => {
      calls.push([m, ...args]);
      return q;
    };
  }
  return { q: q as never, calls };
}

const ID = "11111111-2222-4333-8444-555555555555";
// the seed and hosted shapes the strict z.uuid() refused (T3.2) are ids too
const SEED_ID = "00000000-0000-0000-0000-000000000001";

describe("isDayKey", () => {
  it("accepts real calendar days only", () => {
    expect(isDayKey("2026-01-31")).toBe(true);
    expect(isDayKey("2024-02-29")).toBe(true); // a leap day
    for (const bad of [
      "2026-02-29", // not a leap year
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-1-01",
      "26-01-01",
      "2026-01-01T00:00",
      " 2026-01-01",
      "0001-01-01", // no year a deal closed in — and Date.UTC reads 0–99 as 1900+
      "9999-12-31", // its next day would not print as a four-digit ISO date
      "",
      undefined,
      20260101,
    ]) {
      expect(isDayKey(bad), String(bad)).toBe(false);
    }
  });
});

describe("parseDealListFilters", () => {
  it("no parameters is no filter", () => {
    expect(parseDealListFilters({})).toEqual({});
    expect(isDealListFiltered(parseDealListFilters({}))).toBe(false);
    // the page number and the view are not filters
    expect(parseDealListFilters({ page: "3", view: "cards" })).toEqual({});
  });

  it("keeps every valid filter", () => {
    const f = parseDealListFilters({
      q: "  Maria — PAF0001 ",
      type: "rental",
      status: "lost",
      agent: ID,
      property: SEED_ID,
      contact: ID,
      closed_from: "2026-01-01",
      closed_to: "2026-08-31",
    });
    expect(f).toEqual({
      q: "Maria — PAF0001",
      type: "rental",
      status: "lost",
      agent: ID,
      property: SEED_ID,
      contact: ID,
      closed_from: "2026-01-01",
      closed_to: "2026-08-31",
    });
    expect(isDealListFiltered(f)).toBe(true);
  });

  it("drops junk as if absent: an unknown type or status, a malformed id, an impossible day, a blank search", () => {
    expect(
      parseDealListFilters({
        q: "   ",
        type: "Sale", // case matters: not a deal_type
        status: "deleted",
        agent: "not-an-id",
        property: `${ID},owner_contact_id.not.is.null`, // a filter smuggled after an id
        contact: "00000000-0000-0000-0000-00000000000", // one digit short
        closed_from: "2026-02-30",
        closed_to: "yesterday",
      }),
    ).toEqual({});
  });

  it("there is no default deal type (unlike the board's tab) and `closed` is a status", () => {
    expect(parseDealListFilters({ status: "closed" })).toEqual({ status: "closed" });
    expect(parseDealListFilters({ type: "bogus" }).type).toBeUndefined();
  });

  it("a repeated parameter reads its FIRST value, as the other lists do", () => {
    expect(parseDealListFilters({ status: ["won", "lost"], q: ["first", "second"] })).toEqual({
      status: "won",
      q: "first",
    });
  });
});

describe("closedRangeFilter", () => {
  it("is no filter without a bound", () => {
    expect(closedRangeFilter(undefined, undefined)).toBeNull();
  });

  it("both bounds: a won deal by won_at, a lost deal by lost_at, each in the Cyprus days' half-open interval", () => {
    // winter (EET, UTC+2) start, summer (EEST, UTC+3) end: 2026-01-01 00:00 Nicosia
    // is 2025-12-31T22:00Z; the day AFTER 2026-08-31 starts 2026-08-31T21:00Z
    expect(closedRangeFilter("2026-01-01", "2026-08-31")).toBe(
      "and(status.eq.won,won_at.gte.2025-12-31T22:00:00.000Z,won_at.lt.2026-08-31T21:00:00.000Z)," +
        "and(status.eq.lost,lost_at.gte.2025-12-31T22:00:00.000Z,lost_at.lt.2026-08-31T21:00:00.000Z)",
    );
  });

  it("either bound alone", () => {
    expect(closedRangeFilter("2026-07-01", undefined)).toBe(
      "and(status.eq.won,won_at.gte.2026-06-30T21:00:00.000Z),and(status.eq.lost,lost_at.gte.2026-06-30T21:00:00.000Z)",
    );
    expect(closedRangeFilter(undefined, "2026-12-31")).toBe(
      "and(status.eq.won,won_at.lt.2026-12-31T22:00:00.000Z),and(status.eq.lost,lost_at.lt.2026-12-31T22:00:00.000Z)",
    );
  });

  it("uses the shared Cyprus-day conversion, so it agrees with the reports", () => {
    const { gte, lt } = zonedDateRangeToUtc("2026-03-29", "2026-03-29"); // the spring DST switch
    expect(closedRangeFilter("2026-03-29", "2026-03-29")).toContain(`won_at.gte.${gte},won_at.lt.${lt}`);
  });
});

describe("applyDealListFilters", () => {
  it("no filter adds nothing to the query", () => {
    const { q, calls } = spy();
    applyDealListFilters(q, {});
    expect(calls).toEqual([]);
  });

  it("emits each filter as PostgREST reads it", () => {
    const { q, calls } = spy();
    applyDealListFilters(q, {
      q: "Maria",
      type: "sale",
      status: "won",
      agent: ID,
      property: SEED_ID,
      contact: ID,
      closed_from: "2026-01-01",
    });
    expect(calls).toEqual([
      ["ilike", "title", "%Maria%"],
      ["eq", "deal_type", "sale"],
      ["eq", "status", "won"],
      ["eq", "agent_id", ID],
      ["eq", "property_id", SEED_ID],
      ["or", `buyer_contact_id.eq.${ID},seller_contact_id.eq.${ID}`],
      ["or", closedRangeFilter("2026-01-01", undefined)],
    ]);
  });

  it("status=closed is won or lost", () => {
    const { q, calls } = spy();
    applyDealListFilters(q, { status: "closed" });
    expect(calls).toEqual([["in", "status", ["won", "lost"]]]);
  });

  it("the search loses the characters that would break out of a PostgREST filter", () => {
    const { q, calls } = spy();
    applyDealListFilters(q, { q: "a%b,c(d)" });
    expect(calls).toEqual([["ilike", "title", "%a b c d%"]]);
    // nothing left after stripping is no search at all — never `%%`, which matches every title
    const empty = spy();
    applyDealListFilters(empty.q, { q: "%,()" });
    expect(empty.calls).toEqual([]);
  });

  it("parse → apply: a crafted URL reaches the query only as validated values", () => {
    const { q, calls } = spy();
    applyDealListFilters(
      q,
      parseDealListFilters({
        contact: `${ID}),and(status.eq.open`,
        closed_from: "2026-01-01),or(id.not.is.null",
        status: "open",
      }),
    );
    expect(calls).toEqual([["eq", "status", "open"]]);
  });
});
