import { describe, expect, it } from "vitest";
import { CANDIDATE_COLUMNS, findMatchingBuyers, findMatchingProperties } from "./matches";
import { RETIRED_PROPERTY_VISIBILITY } from "@/lib/validators/properties";
import type { MatchRequirement } from "@/lib/services/matching";

/**
 * What this query pushes down into SQL is the whole safety of the matcher: a
 * row it never fetches can never be scored, and a row it fetches that should
 * not be inventory gets proposed to a buyer.
 *
 * The filter that was missing until 2026-09-07 is the second half of
 * retirement. A listing is retired by `status = 'withdrawn'` OR by
 * `visibility = 'archived'`; this query excluded the first and not the second,
 * so an archived listing — one the properties list, the quality worklist and
 * the container-unit reader all refuse to show — was still offered to buyers.
 * On production that was five units archived precisely because their data was
 * fabricated.
 */

/** A chainable spy standing in for the Supabase filter builder, awaitable at the end. */
function spyBuilder(rows: unknown[] = []) {
  const calls: { method: string; args: unknown[] }[] = [];
  const spy: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      // the chain is awaited at the end — resolve to a PostgREST-shaped result
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
      }
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return proxy;
      };
    },
  };
  const proxy = new Proxy(spy, handler);
  return { client: { from: (t: string) => (calls.push({ method: "from", args: [t] }), proxy) }, calls };
}

const req = (over: Partial<MatchRequirement> = {}): MatchRequirement =>
  ({
    id: "req-1",
    label: null,
    transaction_type: "sale",
    property_types: [],
    district_ids: [],
    area_ids: [],
    features_required: [],
    budget_min: null,
    budget_max: null,
    bedrooms_min: null,
    bedrooms_max: null,
    bathrooms_min: null,
    covered_area_min_sqm: null,
    plot_area_min_sqm: null,
    max_sea_distance_m: null,
    title_deed_required: false,
    vat_preference: null,
    delivery_by: null,
    ...over,
  }) as unknown as MatchRequirement;

const argsOf = (calls: { method: string; args: unknown[] }[], method: string) =>
  calls.filter((c) => c.method === method).map((c) => c.args);

describe("findMatchingProperties pushes the right hard filters into SQL", () => {
  it("refuses retired listings — archived is the other half of withdrawn", async () => {
    const { client, calls } = spyBuilder();
    await findMatchingProperties(client as never, req());
    expect(
      argsOf(calls, "neq"),
      "an archived listing is off the books; proposing it to a buyer undoes the archiving",
    ).toEqual(expect.arrayContaining([["visibility", RETIRED_PROPERTY_VISIBILITY]]));
  });

  it("uses the SHARED constant, so retirement cannot drift between surfaces", () => {
    // The properties list and this query must agree on what "retired" means.
    // A literal here would let one surface be updated and the other not — the
    // exact way this defect arrived.
    expect(RETIRED_PROPERTY_VISIBILITY).toBe("archived");
  });

  it("still refuses containers — a project or phase is not a thing anyone buys", async () => {
    const { client, calls } = spyBuilder();
    await findMatchingProperties(client as never, req());
    const neqs = argsOf(calls, "neq");
    expect(neqs).toEqual(
      expect.arrayContaining([
        ["kind", "project"],
        ["kind", "phase"],
      ]),
    );
  });

  it("only considers the three live statuses", async () => {
    const { client, calls } = spyBuilder();
    await findMatchingProperties(client as never, req());
    const [statusArgs] = argsOf(calls, "in");
    expect(statusArgs[0]).toBe("status");
    expect(statusArgs[1]).toEqual(["available", "reserved", "under_offer"]);
  });

  it("orders before capping, so the cap is the same slice on every read", async () => {
    const { client, calls } = spyBuilder();
    await findMatchingProperties(client as never, req());
    const order = calls.findIndex((c) => c.method === "order");
    const limit = calls.findIndex((c) => c.method === "limit");
    expect(order).toBeGreaterThan(-1);
    expect(limit).toBeGreaterThan(order);
  });
});

/*
 * A04: a match row says when a listing is off-market (or VIP, partner, coming
 * soon) — it is still inventory and still matches, but the row is now where a
 * proposal is made, and a proposal shows the listing to the buyer. The column
 * has to be in the candidate select for the row to know.
 */
describe("the candidate select carries what a match row shows", () => {
  it("selects visibility — and selects exactly CANDIDATE_COLUMNS", async () => {
    const { client, calls } = spyBuilder();
    await findMatchingProperties(client as never, req());
    const [select] = argsOf(calls, "select");
    expect(select![0]).toBe(CANDIDATE_COLUMNS);
    expect(CANDIDATE_COLUMNS.split(",").map((c) => c.trim())).toContain("visibility");
  });

  it("the buyer side reads each buyer's languages, for the proposal's language", async () => {
    const { client, calls } = spyBuilder([
      {
        id: "req-1",
        label: "Sea view",
        contact_id: "c-1",
        ...req(),
        contacts: { id: "c-1", display_name: "Buyer One", assigned_agent_id: null, languages: ["ru", "en"] },
      },
    ]);
    const property = {
      id: "p1",
      status: "available",
      transaction_type: "sale",
      property_type: "apartment",
      district_id: null,
      area_id: null,
      asking_price: 250000,
      rent_price_month: null,
      bedrooms: 2,
      bathrooms: 1,
      covered_area_sqm: 90,
      plot_area_sqm: null,
      title_deed_status: "separate",
      vat_status: "resale_no_vat",
      sea_distance_m: null,
      delivery_date: null,
      features: [],
    } as const;
    const result = await findMatchingBuyers(client as never, { ...property, features: [] });
    const [select] = argsOf(calls, "select");
    expect(String(select![0])).toMatch(/contacts!inner\([^)]*\blanguages\b/);
    expect(result.rows[0]?.contactLanguages).toEqual(["ru", "en"]);
  });

  it("a buyer row whose languages did not come back reads as none, never undefined", async () => {
    const { client } = spyBuilder([
      { id: "req-2", label: null, contact_id: "c-2", ...req(), contacts: { id: "c-2", display_name: "B", assigned_agent_id: null } },
    ]);
    const result = await findMatchingBuyers(client as never, {
      id: "p1",
      status: "available",
      transaction_type: "sale",
      property_type: "apartment",
      district_id: null,
      area_id: null,
      asking_price: null,
      rent_price_month: null,
      bedrooms: null,
      bathrooms: null,
      covered_area_sqm: null,
      plot_area_sqm: null,
      title_deed_status: "unknown",
      vat_status: "unknown",
      sea_distance_m: null,
      delivery_date: null,
      features: [],
    });
    expect(result.rows[0]?.contactLanguages).toEqual([]);
  });
});
