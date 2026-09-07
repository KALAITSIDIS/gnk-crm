import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";

/*
 * The duplicate guard ("is a prompt of this kind already open on this
 * property?") reads through the ADMIN client, because `tasks_select` is scoped
 * to admin/assignee/creator and the invariant belongs to the database rather
 * than to whoever is asking. So these tests serve two clients: the caller's,
 * which reads requirements and inserts the task, and the system's, which
 * answers the count.
 */
const adminFake = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminFake.client }));

/** No prompt open yet — the ordinary case for a first alert. */
const noOpenPrompt = () => {
  const fake = fakeClient({ tasks: [{ data: null, error: null, count: 0 }] });
  adminFake.client = fake.client;
  return fake;
};
import { BUDGET_TOLERANCE_PCT } from "./matching";
import {
  becameMatchable,
  bulkNewlyMatching,
  raiseBulkPriceDropAlert,
  raiseNewListingAlert,
  isAlertableDrop,
  priceFor,
  wasPricedOut,
  type AlertProperty,
  type BulkPriceChange,
  type RequirementRow,
} from "./match-alerts";

describe("isAlertableDrop", () => {
  it("fires only on a genuine decrease", () => {
    expect(isAlertableDrop(500000, 450000)).toBe(true);
    expect(isAlertableDrop(450000, 500000), "a rise is not a drop").toBe(false);
    expect(isAlertableDrop(450000, 450000), "no change is not a drop").toBe(false);
  });

  it("does not fire when either side is unknown", () => {
    // Pricing a previously unpriced property is a NEW LISTING, not a drop, and
    // it is a different feature. Removing a price is not a drop either.
    expect(isAlertableDrop(null, 450000)).toBe(false);
    expect(isAlertableDrop(450000, null)).toBe(false);
    expect(isAlertableDrop(null, null)).toBe(false);
  });

  it("has NO arbitrary minimum, on purpose", () => {
    // A €1 drop only ever alerts if it crosses somebody's ceiling — see
    // wasPricedOut. A "minimum meaningful drop" constant would be a number
    // nobody could defend, and it would suppress exactly the case that matters.
    expect(isAlertableDrop(450001, 450000)).toBe(true);
  });
});

describe("wasPricedOut — the crux of the feature", () => {
  // The question is not "can they afford it now" but "could they NOT afford it
  // before". Without that, every price drop would alert every buyer who already
  // matched, which is noise the desk would learn to ignore.
  const ceiling = (budget: number) => budget * (1 + BUDGET_TOLERANCE_PCT / 100);

  it("is true only when the drop crosses their ceiling", () => {
    // budget 300k, ceiling 330k
    expect(wasPricedOut(300000, 400000, 320000), "crossed into reach").toBe(true);
    expect(wasPricedOut(300000, 400000, 350000), "still out of reach").toBe(false);
    expect(wasPricedOut(300000, 320000, 310000), "already in reach before").toBe(false);
  });

  it("uses the same tolerance the matcher uses, not a stricter one", () => {
    // If these disagreed, a buyer could be alerted and then not appear in the
    // match list, or appear in it and never be alerted.
    const budget = 300000;
    const justInside = ceiling(budget);
    expect(wasPricedOut(budget, justInside + 1, justInside)).toBe(true);
    expect(wasPricedOut(budget, justInside + 2, justInside + 1)).toBe(false);
  });

  it("treats a buyer with no ceiling as never priced out", () => {
    // No budget_max means no opinion on price, so a drop tells them nothing new.
    expect(wasPricedOut(null, 900000, 100000)).toBe(false);
  });

  it("handles a zero or negative budget without throwing", () => {
    expect(() => wasPricedOut(0, 100, 50)).not.toThrow();
    expect(wasPricedOut(0, 100, 50)).toBe(false);
  });

  it("accepts a numeric arriving as a string, whatever the driver does", () => {
    // KEPT AS DEFENCE, but its premise no longer holds and the note that said
    // otherwise cost real time. Measured 2026-09-07 against both the local
    // stack and hosted, PostgREST serialises numeric as an UNQUOTED JSON
    // number and supabase-js hands over a JS number:
    //
    //   GET /rest/v1/buyer_requirements?select=budget_max
    //     -> [{"budget_max":700000.00}]
    //
    // The older note here claimed the opposite, and that claim — not the code —
    // is what produced a confidently-argued P1 against the payment-schedule
    // card that turned out not to exist (see DECISIONS T-silent). The coercion
    // below is harmless and `wasPricedOut` is exported, so it stays; the story
    // does not. `Number.isFinite("700000.00")` is indeed false, which is why
    // the function coerces rather than tests the raw value.
    expect(wasPricedOut("700000.00" as unknown as number, 800000, 760000)).toBe(true);
    expect(wasPricedOut("700000.00" as unknown as number, 800000, 790000)).toBe(false);
  });

  it("still rejects a genuinely non-numeric value", () => {
    expect(wasPricedOut("not a number" as unknown as number, 800000, 760000)).toBe(false);
    expect(wasPricedOut("" as unknown as number, 800000, 760000)).toBe(false);
  });
});

describe("priceFor", () => {
  it("reads the rent for a rental requirement and the asking price otherwise", () => {
    const p = { asking_price: 250000, rent_price_month: 1200 };
    expect(priceFor("rent", p)).toBe(1200);
    expect(priceFor("sale", p)).toBe(250000);
    expect(priceFor("sale_or_rent", p)).toBe(250000);
  });

  it("returns null rather than NaN when the relevant price is unset", () => {
    expect(priceFor("rent", { asking_price: 250000, rent_price_month: null })).toBeNull();
    expect(priceFor("sale", { asking_price: null, rent_price_month: 1200 })).toBeNull();
  });
});

describe("becameMatchable — the new-listing trigger", () => {
  it("fires only when the status ENTERS a matchable state", () => {
    expect(becameMatchable("draft", "available"), "first publication").toBe(true);
    expect(becameMatchable("withdrawn", "available"), "put back on the market").toBe(true);
    // a sale that fell through is a new listing to a buyer never shown it
    expect(becameMatchable("sold", "available")).toBe(true);
    expect(becameMatchable(null, "available"), "arriving with no prior state").toBe(true);
  });

  it("does not fire while already on the market", () => {
    // These are the ones that would turn the feature into noise: an agent
    // editing a live listing must not re-alert every matching buyer.
    expect(becameMatchable("available", "available")).toBe(false);
    expect(becameMatchable("available", "reserved")).toBe(false);
    expect(becameMatchable("reserved", "under_offer")).toBe(false);
    expect(becameMatchable("under_offer", "available")).toBe(false);
  });

  it("does not fire when leaving the market", () => {
    expect(becameMatchable("available", "sold")).toBe(false);
    expect(becameMatchable("available", "withdrawn")).toBe(false);
    expect(becameMatchable("available", "draft")).toBe(false);
    expect(becameMatchable("draft", "draft")).toBe(false);
  });

  it("agrees with the matcher about which statuses are matchable", () => {
    // becameMatchable reads MATCHABLE_STATUSES rather than restating it. If the
    // two ever disagreed, the alert would fire for a property the matcher still
    // hides, or stay silent for one it shows. Assert the full set both ways.
    for (const live of ["available", "reserved", "under_offer"] as const) {
      expect(becameMatchable("draft", live), `${live} is matchable`).toBe(true);
    }
    for (const dead of ["draft", "sold", "rented", "withdrawn"] as const) {
      expect(becameMatchable("draft", dead), `${dead} is not matchable`).toBe(false);
    }
  });
});

describe("pricing an unpriced property is NOT an alert — either kind", () => {
  it("is excluded from the drop path", () => {
    // An earlier BACKLOG note of mine said this case "belongs to the
    // new-listing alert". That was wrong, and this pins why.
    expect(isAlertableDrop(null, 250000)).toBe(false);
  });

  it("is excluded from the new-listing path too, because status did not change", () => {
    expect(becameMatchable("available", "available")).toBe(false);
  });

  // The reason it belongs to NEITHER: matchProperty skips the budget hard
  // filter when the price is null, so an unpriced property is ALREADY eligible
  // for every buyer. Setting a price can only ever remove a match, never create
  // one — so there is no "newly matching" buyer to alert. Proven in
  // matching.test.ts ("does not reject an unpriced property").
});

describe("bulkNewlyMatching — a whole block, in memory", () => {
  const unit = (id: string, price: number, over: Partial<AlertProperty> = {}): AlertProperty => ({
    id,
    reference: id,
    assigned_agent_id: null,
    status: "available",
    transaction_type: "sale",
    property_type: "apartment",
    district_id: "d1",
    area_id: "a1",
    asking_price: price,
    rent_price_month: null,
    bedrooms: 2,
    bathrooms: 1,
    covered_area_sqm: 80,
    plot_area_sqm: null,
    title_deed_status: "separate",
    vat_status: "resale_no_vat",
    sea_distance_m: 500,
    delivery_date: null,
    features: [],
    ...over,
  });

  const req = (id: string, budgetMax: number, over: Partial<RequirementRow> = {}): RequirementRow =>
    ({
      id,
      contact_id: `c-${id}`,
      transaction_type: "sale",
      property_types: [],
      district_ids: [],
      area_ids: [],
      budget_min: null,
      budget_max: budgetMax,
      bedrooms_min: null,
      bedrooms_max: null,
      bathrooms_min: null,
      covered_area_min_sqm: null,
      plot_area_min_sqm: null,
      title_deed_required: false,
      vat_preference: null,
      max_sea_distance_m: null,
      delivery_by: null,
      features_required: [],
      ...over,
    }) as RequirementRow;

  const asMap = (us: AlertProperty[]) => new Map(us.map((u) => [u.id, u]));

  it("reports only the units that gained someone, and each buyer once", () => {
    // budget 300k -> ceiling 330k. u1 crosses it, u2 does not, u3 was already in.
    const changes: BulkPriceChange[] = [
      { id: "u1", reference: "u1", from: 400000, to: 320000 },
      { id: "u2", reference: "u2", from: 900000, to: 800000 },
      { id: "u3", reference: "u3", from: 300000, to: 280000 },
    ];
    const units = asMap([unit("u1", 320000), unit("u2", 800000), unit("u3", 280000)]);
    const out = bulkNewlyMatching(changes, units, [req("r1", 300000)]);
    expect(out.unitIds).toEqual(["u1"]);
    expect(out.contactIds).toEqual(["c-r1"]);
  });

  it("counts a buyer ONCE even when several units come into range", () => {
    // The whole reason the result is a set: one phone call, not three.
    const changes: BulkPriceChange[] = [
      { id: "u1", reference: "u1", from: 400000, to: 320000 },
      { id: "u2", reference: "u2", from: 400000, to: 310000 },
    ];
    const units = asMap([unit("u1", 320000), unit("u2", 310000)]);
    const out = bulkNewlyMatching(changes, units, [req("r1", 300000)]);
    expect(out.unitIds.sort()).toEqual(["u1", "u2"]);
    expect(out.contactIds, "one buyer, not two").toEqual(["c-r1"]);
  });

  it("ignores a price RISE, which is what an uplift usually is", () => {
    const changes: BulkPriceChange[] = [{ id: "u1", reference: "u1", from: 300000, to: 340000 }];
    const units = asMap([unit("u1", 340000)]);
    expect(bulkNewlyMatching(changes, units, [req("r1", 400000)]).contactIds).toEqual([]);
  });

  it("ignores a rental requirement — an asking-price uplift cannot reach it", () => {
    const changes: BulkPriceChange[] = [{ id: "u1", reference: "u1", from: 400000, to: 320000 }];
    const units = asMap([unit("u1", 320000)]);
    const rental = req("r1", 300000, { transaction_type: "rent" });
    expect(bulkNewlyMatching(changes, units, [rental]).contactIds).toEqual([]);
  });

  it("still applies every OTHER criterion, not just the budget", () => {
    const changes: BulkPriceChange[] = [{ id: "u1", reference: "u1", from: 400000, to: 320000 }];
    const units = asMap([unit("u1", 320000, { property_type: "apartment" })]);
    const wantsVilla = req("r1", 300000, { property_types: ["villa"] });
    expect(
      bulkNewlyMatching(changes, units, [wantsVilla]).contactIds,
      "a drop must not sell an apartment to someone who asked for a villa",
    ).toEqual([]);
  });

  it("skips a change whose unit was not fetched, rather than throwing", () => {
    const changes: BulkPriceChange[] = [{ id: "missing", reference: "x", from: 400000, to: 320000 }];
    expect(() => bulkNewlyMatching(changes, new Map(), [req("r1", 300000)])).not.toThrow();
    expect(bulkNewlyMatching(changes, new Map(), [req("r1", 300000)]).contactIds).toEqual([]);
  });

  it("handles a 60-unit block without needing a database", () => {
    // The shape that made this function exist: per-unit alerting would have
    // issued four queries per unit here. This is arithmetic.
    const changes: BulkPriceChange[] = Array.from({ length: 60 }, (_, i) => ({
      id: `u${i}`,
      reference: `u${i}`,
      from: 400000,
      to: 320000,
    }));
    const units = asMap(changes.map((c) => unit(c.id, 320000)));
    const reqs = Array.from({ length: 5 }, (_, i) => req(`r${i}`, 300000));
    const out = bulkNewlyMatching(changes, units, reqs);
    expect(out.unitIds).toHaveLength(60);
    expect(out.contactIds).toHaveLength(5);
  });
});

// The event write is the one thing an alert does that is not a read; it has
// its own tests. Here it is a no-op so the reads can be the subject.
vi.mock("@/lib/services/events", () => ({ logEvent: vi.fn(async () => undefined) }));

describe("the reads behind an alert are paged and loud (A08a)", () => {
  const prop: AlertProperty = {
    id: "p1",
    reference: "PAF0099",
    assigned_agent_id: null,
    status: "available",
    transaction_type: "sale",
    property_type: "apartment",
    district_id: "d1",
    area_id: "a1",
    asking_price: 300000,
    rent_price_month: null,
    bedrooms: 2,
    bathrooms: 1,
    covered_area_sqm: 80,
    plot_area_sqm: null,
    title_deed_status: "separate",
    vat_status: "resale_no_vat",
    sea_distance_m: 500,
    delivery_date: null,
    features: [],
  };
  const reqRow = (i: number): RequirementRow =>
    ({
      id: "r" + i,
      contact_id: "c" + i,
      transaction_type: "sale",
      property_types: [],
      district_ids: [],
      area_ids: [],
      budget_min: null,
      budget_max: 300000,
      bedrooms_min: null,
      bedrooms_max: null,
      bathrooms_min: null,
      covered_area_min_sqm: null,
      plot_area_min_sqm: null,
      title_deed_required: false,
      vat_preference: null,
      max_sea_distance_m: null,
      delivery_by: null,
      features_required: [],
    }) as RequirementRow;
  const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => reqRow(from + i));
  type Client = Parameters<typeof raiseNewListingAlert>[0];

  it("a failed requirements read THROWS — the caller logs it — instead of reporting no matches", async () => {
    // Until 2026-09-06 this returned [] on error: a failed read and "nobody is
    // looking" were the same answer, and the alert silently did nothing.
    const { client } = fakeClient({
      buyer_requirements: [{ data: null, error: { message: "statement timeout" } }],
    });
    await expect(
      raiseNewListingAlert(client as unknown as Client, {
        orgId: "o",
        actorId: "u",
        property: prop,
        previousStatus: "draft",
      }),
    ).rejects.toThrow("Query failed (buyer_requirements): statement timeout");
  });

  it("reads EVERY active requirement, past the thousandth — the 1,001st buyer is told too", async () => {
    noOpenPrompt();
    const { client, served, argsOf } = fakeClient({
      buyer_requirements: [
        { data: many(0, 1000), error: null },
        { data: many(1000, 3), error: null },
      ],
      tasks: [{ data: { id: "t1" }, error: null }],
    });
    const res = await raiseNewListingAlert(client as unknown as Client, {
      orgId: "o",
      actorId: "u",
      property: prop,
      previousStatus: "draft",
    });
    expect(
      served.buyer_requirements,
      "a full page, the short one, and the empty read that ends the sweep",
    ).toBe(3);
    // WHICH pages, and ordered — a factory that forgot .range() or .order("id")
    // used to pass this test on the count alone. Ranges advance by what
    // ARRIVED (fetch-all.ts), so the third starts at 1003.
    expect(argsOf("buyer_requirements", "range")).toEqual([
      [0, 999],
      [1000, 1999],
      [1003, 2002],
    ]);
    expect(argsOf("buyer_requirements", "order")).toEqual([["id"], ["id"], ["id"]]);
    expect(res.newlyMatching).toBe(1003);
    expect(res.taskCreated).toBe(true);
  });

  it("counts a BUYER once, not each of their saved searches", async () => {
    /*
     * The loop runs once per requirement, and one person may hold several
     * briefs. Counting rows announced "2 buyers now in budget" for one buyer
     * who had recorded two searches — and the task then named a number the
     * property page would not agree with.
     *
     * `bulkNewlyMatching` has always deduped ("one phone call, not three");
     * the single-property paths did not. One fact, two implementations.
     */
    const twice = [
      { ...reqRow(1), id: "r1", contact_id: "same-buyer" },
      { ...reqRow(2), id: "r2", contact_id: "same-buyer" },
    ] as RequirementRow[];
    noOpenPrompt();
    const { client } = fakeClient({
      buyer_requirements: [{ data: twice, error: null }, { data: [], error: null }],
      tasks: [{ data: { id: "t1" }, error: null }],
    });
    const res = await raiseNewListingAlert(client as unknown as Client, {
      orgId: "o",
      actorId: "u",
      property: prop,
      previousStatus: "draft",
    });
    expect(res.newlyMatching, "one person, two briefs, one buyer").toBe(1);
  });

  it("never reads an archived contact's requirements", async () => {
    /*
     * `findMatchingBuyers` — the property page's "Buyers looking for this" —
     * filters `contacts.is_archived = false`. This path did not, so an archived
     * contact's still-active searches kept raising tasks: the task said N
     * buyers, the page the agent opened showed fewer, and the desk was prompted
     * to ring someone the firm had archived.
     */
    noOpenPrompt();
    const { client, argsOf } = fakeClient({
      buyer_requirements: [{ data: [reqRow(1)], error: null }, { data: [], error: null }],
      tasks: [{ data: { id: "t1" }, error: null }],
    });
    await raiseNewListingAlert(client as unknown as Client, {
      orgId: "o",
      actorId: "u",
      property: prop,
      previousStatus: "draft",
    });
    expect(argsOf("buyer_requirements", "eq")).toEqual(
      expect.arrayContaining([["contacts.is_archived", false]]),
    );
  });

  it("a prompt the caller CANNOT SEE still suppresses a second one", async () => {
    /*
     * THE DEFECT. `tasks_select` is scoped to admin, assignee OR creator, so
     * the guard — "is a prompt of this kind already open on this property?" —
     * used to be answered from the subset the caller happens to see. An agent
     * blind to the prompt a colleague is holding got "none" and raised a
     * second one for the same property and kind, against a comment promising
     * "one open alert at a time per property per kind".
     *
     * Here the system's view says one is open while the caller's fake serves
     * no task at all: if the guard were still the caller's, this would insert.
     */
    const guard = fakeClient({ tasks: [{ data: null, error: null, count: 1 }] });
    adminFake.client = guard.client;
    const { client } = fakeClient({
      buyer_requirements: [{ data: [reqRow(1)], error: null }, { data: [], error: null }],
      // deliberately EMPTY: any insert here would throw, so a raise cannot hide
      tasks: [],
    });

    const res = await raiseNewListingAlert(client as unknown as Client, {
      orgId: "o",
      actorId: "u",
      property: prop,
      previousStatus: "draft",
    });
    expect(res.taskCreated, "the open prompt is honoured, whoever can see it").toBe(false);
    expect(res.newlyMatching, "and the buyer is still counted").toBe(1);
  });

  it("asks the guard with an org filter — the admin client has no RLS to add one", async () => {
    const guard = noOpenPrompt();
    const { client } = fakeClient({
      buyer_requirements: [{ data: [reqRow(1)], error: null }, { data: [], error: null }],
      tasks: [{ data: { id: "t1" }, error: null }],
    });
    await raiseNewListingAlert(client as unknown as Client, {
      orgId: "o",
      actorId: "u",
      property: prop,
      previousStatus: "draft",
    });
    expect(
      guard.argsOf("tasks", "eq"),
      "without org_id a property id from another organisation is reachable",
    ).toEqual(expect.arrayContaining([["org_id", "o"], ["property_id", prop.id]]));
  });

  it("a failed unit read on a block reprice THROWS for the same reason", async () => {
    const { client } = fakeClient({
      buyer_requirements: [{ data: [reqRow(1)], error: null }],
      properties: [{ data: null, error: { message: "boom" } }],
    });
    await expect(
      raiseBulkPriceDropAlert(client as unknown as Client, {
        orgId: "o",
        actorId: "u",
        project: { id: "proj", reference: "PRJ", assigned_agent_id: null },
        changes: [{ id: "u1", reference: "u1", from: 400000, to: 320000 }],
      }),
    ).rejects.toThrow("Query failed (properties (repriced units)): boom");
  });
});
