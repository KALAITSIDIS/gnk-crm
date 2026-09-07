import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { buildQualityInput, computeQualityScore, type QualityScoreSource } from "./quality-score";
import { writeGeneratedUnits, type UnitParent } from "./unit-writer";
import type { GeneratedUnit } from "./unit-generator";

/**
 * The writer had no unit test, which is how sixty units at a stored score of
 * ZERO went unnoticed until `recompute:scores` was run for another reason
 * (2026-09-07). `quality_score` is read by the properties list and the CSV
 * export; nothing here set it, so every generated unit showed a red 0/100 ring
 * while the detail page one click away computed 60 from the same data.
 */
vi.mock("@/lib/services/events", () => ({ logEvents: vi.fn(async () => undefined) }));

const unit = (over: Partial<GeneratedUnit> = {}): GeneratedUnit =>
  ({
    unit_number: "01",
    block: null,
    floor_number: null,
    bedrooms: 3,
    bathrooms: 2,
    covered_area_sqm: 120,
    plot_area_sqm: 300,
    asking_price: 450000,
    label: "V01",
    ...over,
  }) as GeneratedUnit;

const project = {
  id: "proj-1",
  org_id: "org-1",
  reference: "PAF0002",
  transaction_type: "sale",
  title_deed_status: "separate",
  permit_status: "granted",
  owner_contact_id: "owner-1",
  developer_contact_id: null,
  location: "0101000020E6100000",
  currency: "EUR",
} as unknown as UnitParent;

/** A stored row as PostgREST returns it after the insert — what the score is computed from. */
const storedRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  reference: `PAF0002-${id}`,
  kind: "unit",
  property_type: "villa",
  title: null,
  public_description: null,
  asking_price: 450000,
  rent_price_month: null,
  covered_area_sqm: 120,
  plot_area_sqm: 300,
  bedrooms: 3,
  bathrooms: 2,
  planning_zone_code: null,
  building_density_pct: null,
  location: "0101000020E6100000",
  location_approx: false,
  title_deed_status: "separate",
  permit_status: "granted",
  assigned_agent_id: null,
  owner_contact_id: "owner-1",
  developer_contact_id: null,
  ...over,
});

/** The score the app would compute for a freshly written unit — no photos, no mandate. */
const expectedScore = (row: Record<string, unknown>) =>
  computeQualityScore(
    buildQualityInput(row as unknown as QualityScoreSource, {
      hasCoverPhoto: false,
      photoCount: 0,
      mandateActive: false,
    }),
  ).score;

function setup(pages: FakePage[]) {
  const fake = fakeClient({ properties: pages });
  return fake;
}

describe("a generated unit is scored the moment it is written", () => {
  it("writes the score the app would compute — not the column's default of zero", async () => {
    const rows = [storedRow("u1"), storedRow("u2")];
    const fake = setup([
      { data: [], error: null }, // the clash pre-check
      { data: rows, error: null }, // the insert
      { data: null, error: null }, // the score update
    ]);
    const res = await writeGeneratedUnits(
      fake.client as never,
      project,
      [unit(), unit()],
      { propertyType: "villa", actorId: "actor-1" },
    );
    expect(res.error).toBeNull();

    const updates = fake.argsOf("properties", "update");
    expect(updates, "one UPDATE — units of one run score alike").toHaveLength(1);
    const written = (updates[0][0] as { quality_score: number }).quality_score;
    expect(written).toBe(expectedScore(rows[0]));
    expect(written, "the whole point: not the default").toBeGreaterThan(0);
    // and it targets exactly the rows just created
    expect(fake.argsOf("properties", "in")).toEqual(
      expect.arrayContaining([["id", ["u1", "u2"]]]),
    );
  });

  it("scores each SHAPE on its own — a cheaper unit is not given its neighbour's score", async () => {
    const full = storedRow("u1");
    const bare = storedRow("u2", { asking_price: null, bedrooms: null, bathrooms: null });
    const fake = setup([
      { data: [], error: null },
      { data: [full, bare], error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);
    await writeGeneratedUnits(fake.client as never, project, [unit(), unit()], {
      propertyType: "villa",
      actorId: "actor-1",
    });
    const scores = fake
      .argsOf("properties", "update")
      .map((a) => (a[0] as { quality_score: number }).quality_score);
    expect(scores).toEqual([expectedScore(full), expectedScore(bare)]);
    expect(expectedScore(bare)).toBeLessThan(expectedScore(full));
  });

  it("computes from the STORED row, so an inherited value it did not send still counts", async () => {
    // The insert spreads the project's inherited columns; scoring the object we
    // sent rather than the row that came back would be a second opinion about
    // what a unit is. Here the database also stamped a deed status.
    const row = storedRow("u1", { title_deed_status: "separate" });
    const withoutDeed = { ...row, title_deed_status: "unknown" };
    const fake = setup([
      { data: [], error: null },
      { data: [row], error: null },
      { data: null, error: null },
    ]);
    await writeGeneratedUnits(fake.client as never, project, [unit()], {
      propertyType: "villa",
      actorId: "actor-1",
    });
    const written = (fake.argsOf("properties", "update")[0][0] as { quality_score: number })
      .quality_score;
    expect(written).toBe(expectedScore(row));
    expect(written).toBeGreaterThan(expectedScore(withoutDeed));
  });

  it("never fails the run when the score update does — the units exist and the column is derived", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = setup([
      { data: [], error: null },
      { data: [storedRow("u1")], error: null },
      { data: null, error: { message: "permission denied" } },
    ]);
    const res = await writeGeneratedUnits(fake.client as never, project, [unit()], {
      propertyType: "villa",
      actorId: "actor-1",
    });
    expect(res.error, "the units were created — that is the result").toBeNull();
    expect(res.created).toHaveLength(1);
    expect(err, "but it is never silent").toHaveBeenCalledWith(
      "unit scoring failed:",
      "permission denied",
    );
    err.mockRestore();
  });
});
