import { describe, expect, it } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";
import {
  describeHold,
  fetchContainerAvailability,
  liveHoldsUnder,
  PARENTS_PER_READ,
  type LiveHold,
} from "./container-availability";

/**
 * A05: the units page's holds and its read-only availability across phases.
 * What is pinned: every read is by PARENT (never a unit-id list), paged over a
 * unique order, de-duplicated, and the definition of "a unit" is the one
 * container-units.ts holds — and a hold is said beside the status it may
 * disagree with.
 */

const reservation = (id: string, propertyId: string, over: Record<string, unknown> = {}) => ({
  id,
  property_id: propertyId,
  status: "held",
  held_from: "2026-10-01T09:00:00Z",
  expires_at: "2026-11-12T09:00:00Z",
  contacts: { display_name: "Buyer One" },
  properties: { parent_id: "ph1", kind: "unit" },
  ...over,
});

const unitRow = (id: string, parent_id: string, over: Record<string, unknown> = {}) => ({
  id,
  parent_id,
  reference: id.toUpperCase(),
  unit_number: "101",
  block: "A",
  property_type: "apartment",
  transaction_type: "sale",
  bedrooms: 2,
  covered_area_sqm: 85,
  asking_price: 250000,
  rent_price_month: null,
  status: "available",
  delivery_date: "2027-06-30",
  ...over,
});

describe("liveHoldsUnder", () => {
  it("asks nothing for no parents", async () => {
    const fake = fakeClient({});
    expect((await liveHoldsUnder(fake.client as never, [])).size).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("filters by the units' PARENT through properties!inner — held and confirmed only, units only, ordered by id", async () => {
    const fake = fakeClient({ reservations: [{ data: [reservation("r1", "u1")], error: null }] });
    const holds = await liveHoldsUnder(fake.client as never, ["proj", "ph1"]);
    expect(fake.argsOf("reservations", "select")[0]![0]).toContain("properties!inner(parent_id, kind)");
    // the same two filters on each of the read's two pages
    expect(fake.argsOf("reservations", "in")).toEqual([
      ["status", ["held", "confirmed"]],
      ["properties.parent_id", ["proj", "ph1"]],
      ["status", ["held", "confirmed"]],
      ["properties.parent_id", ["proj", "ph1"]],
    ]);
    expect(fake.argsOf("reservations", "eq")).toContainEqual(["properties.kind", "unit"]);
    expect(fake.argsOf("reservations", "order")[0]).toEqual(["id"]);
    // fetchAll: the page with the row, then the empty page that ends the read
    expect(fake.argsOf("reservations", "range")).toEqual([
      [0, 999],
      [1, 1000],
    ]);
    expect(holds.get("u1")).toEqual<LiveHold>({
      reservationId: "r1",
      propertyId: "u1",
      status: "held",
      heldFrom: "2026-10-01T09:00:00Z",
      expiresAt: "2026-11-12T09:00:00Z",
      buyer: "Buyer One",
    });
  });

  it("never sends a unit-id list: parents go out in slices, each paged", async () => {
    const parents = Array.from({ length: PARENTS_PER_READ + 5 }, (_, i) => `p${i}`);
    const fake = fakeClient({});
    await liveHoldsUnder(fake.client as never, parents);
    const lists = fake
      .argsOf("reservations", "in")
      .filter(([col]) => col === "properties.parent_id")
      .map(([, ids]) => ids as string[]);
    expect(lists.map((l) => l.length)).toEqual([PARENTS_PER_READ, 5]);
    expect(lists.flat()).toEqual(parents);
  });

  it("de-duplicates a row two pages both returned, and a hold with no buyer keeps the hold", async () => {
    const fake = fakeClient({
      reservations: [
        { data: [reservation("r1", "u1"), reservation("r2", "u2", { contacts: null })], error: null },
        { data: [reservation("r2", "u2", { contacts: null })], error: null },
        { data: [], error: null },
      ],
    });
    const holds = await liveHoldsUnder(fake.client as never, ["ph1"]);
    expect([...holds.keys()]).toEqual(["u1", "u2"]);
    expect(holds.get("u2")?.buyer).toBeNull();
  });

  it("a failed page throws — a hold that could not be read is never 'no hold'", async () => {
    const fake = fakeClient({ reservations: [{ data: null, error: { message: "boom" } }] });
    await expect(liveHoldsUnder(fake.client as never, ["ph1"])).rejects.toThrow(/live holds/);
  });
});

describe("fetchContainerAvailability", () => {
  it("a phase: only its own holds, no overview, no phase or unit read", async () => {
    const fake = fakeClient({ reservations: [{ data: [], error: null }] });
    const r = await fetchContainerAvailability(fake.client as never, { id: "ph1", kind: "phase" });
    expect(r.overview).toBeNull();
    expect(fake.served.properties ?? 0).toBe(0);
    expect(fake.argsOf("reservations", "in")).toContainEqual(["properties.parent_id", ["ph1"]]);
  });

  it("a project with no live phase: holds for the project alone, no overview", async () => {
    const fake = fakeClient({ properties: [{ data: [], error: null }], reservations: [{ data: [], error: null }] });
    const r = await fetchContainerAvailability(fake.client as never, { id: "proj", kind: "project" });
    expect(r.overview).toBeNull();
    // the phase read excludes archived phases — container-units.ts's definition
    expect(fake.argsOf("properties", "neq")).toContainEqual(["visibility", "archived"]);
    expect(fake.argsOf("properties", "eq")).toEqual(
      expect.arrayContaining([
        ["parent_id", "proj"],
        ["kind", "phase"],
      ]),
    );
    expect(fake.argsOf("reservations", "in")).toContainEqual(["properties.parent_id", ["proj"]]);
  });

  it("a phased project: units under the project AND its phases, by parent, kind unit, not archived, uniquely ordered and de-duplicated", async () => {
    const fake = fakeClient({
      properties: [
        // the phases
        {
          data: [
            {
              id: "ph1",
              reference: "PAF0002-P1",
              title: { en: "Phase 1" },
              status: "available",
              delivery_date: "2027-06-30",
              construction_status: "structure",
            },
          ],
          error: null,
        },
        { data: [], error: null },
        // the units: a repeated row across two pages
        { data: [unitRow("u1", "ph1"), unitRow("u0", "proj")], error: null },
        { data: [unitRow("u0", "proj")], error: null },
        { data: [], error: null },
      ],
      reservations: [{ data: [reservation("r1", "u1")], error: null }],
    });
    const r = await fetchContainerAvailability(fake.client as never, { id: "proj", kind: "project" });
    expect(r.overview?.phases).toEqual([
      {
        id: "ph1",
        reference: "PAF0002-P1",
        title: "Phase 1",
        status: "available",
        delivery_date: "2027-06-30",
        construction_status: "structure",
      },
    ]);
    expect(r.overview?.units.map((u) => u.id)).toEqual(["u1", "u0"]);
    // every unit page asked by the two parents — never by unit ids
    const unitLists = fake.argsOf("properties", "in");
    expect(unitLists.length).toBe(3);
    for (const args of unitLists) expect(args).toEqual(["parent_id", ["proj", "ph1"]]);
    expect(fake.argsOf("properties", "eq")).toContainEqual(["kind", "unit"]);
    // the phase read's two pages and the unit read's three all leave archived rows out
    const neq = fake.argsOf("properties", "neq");
    expect(neq).toHaveLength(5);
    for (const args of neq) expect(args).toEqual(["visibility", "archived"]);
    // each page is ordered on a unique key: the phase read's first, the unit read's last
    const orders = fake.argsOf("properties", "order").map(([c]) => c);
    expect(orders.slice(0, 2)).toEqual(["reference", "id"]);
    expect(orders.slice(-4)).toEqual(["parent_id", "block", "unit_number", "id"]);
    // the holds cover the phases' units too — the matrix and the overview read one set
    expect(fake.argsOf("reservations", "in")).toContainEqual(["properties.parent_id", ["proj", "ph1"]]);
    expect(r.holds.get("u1")?.status).toBe("held");
  });

  it("a failed unit read throws to the page's boundary", async () => {
    const fake = fakeClient({
      properties: [
        { data: [{ id: "ph1", reference: "P1", title: null, status: "available", delivery_date: null, construction_status: null }], error: null },
        { data: [], error: null },
        { data: null, error: { message: "boom" } },
      ],
      reservations: [{ data: [], error: null }],
    });
    await expect(fetchContainerAvailability(fake.client as never, { id: "proj", kind: "project" })).rejects.toThrow(
      /availability units/,
    );
  });
});

describe("describeHold", () => {
  const NOW = new Date("2026-10-19T10:00:00Z");
  const hold = (over: Partial<LiveHold> = {}): LiveHold => ({
    reservationId: "r1",
    propertyId: "u1",
    status: "held",
    heldFrom: "2026-10-01T09:00:00Z",
    expiresAt: "2026-11-12T09:00:00Z",
    buyer: "Buyer One",
    ...over,
  });

  it("a held unit whose status agrees: the expiry and the buyer, no note", () => {
    expect(describeHold("reserved", hold(), NOW)).toEqual({
      label: "Held to 12 Nov 2026",
      buyer: "Buyer One",
      lapsed: false,
      note: null,
    });
    expect(describeHold("under_offer", hold({ status: "confirmed" }), NOW).label).toBe("Confirmed to 12 Nov 2026");
  });

  it("status Available with a live hold: said — the two are not coupled, by decision", () => {
    expect(describeHold("available", hold(), NOW).note).toBe("Status still says Available");
  });

  it("a sold or withdrawn unit with a live hold: said", () => {
    expect(describeHold("sold", hold(), NOW).note).toBe("Status says Sold, but the hold is still live");
    expect(describeHold("withdrawn", hold(), NOW).note).toBe("Status says Withdrawn, but the hold is still live");
  });

  it("Reserved with no live hold: said; any other status with none: nothing", () => {
    expect(describeHold("reserved", null, NOW)).toEqual({
      label: null,
      buyer: null,
      lapsed: false,
      note: "Reserved, but no live hold is recorded",
    });
    expect(describeHold("available", undefined, NOW)).toEqual({ label: null, buyer: null, lapsed: false, note: null });
  });

  it("past its expiry and still live: lapsed, until the nightly sweep closes it", () => {
    const v = describeHold("reserved", hold({ expiresAt: "2026-10-18T09:00:00Z" }), NOW);
    expect(v.lapsed).toBe(true);
    expect(v.label).toBe("Held — lapsed 18 Oct 2026; the nightly sweep closes it");
  });

  it("the date is the Cyprus day: a hold ending 23:30 UTC ends the next day in Nicosia", () => {
    expect(describeHold("reserved", hold({ expiresAt: "2026-11-11T23:30:00Z" }), NOW).label).toBe(
      "Held to 12 Nov 2026",
    );
  });
});
