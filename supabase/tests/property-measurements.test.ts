/**
 * Migration 0113 at the table: every write path, not only the app's forms,
 * is held to the measurement rules (LST-07; audit 2026-09-23). Requires the
 * local Supabase stack.
 *
 * Service role on purpose: it bypasses RLS and every Zod schema, which is
 * exactly the CSV importer's position (scripts/import/properties.mts) and the
 * position of any hand-run script. A CHECK binds it anyway — the 0072/0077
 * lesson. The migration's own assertions prove the constraints exist and are
 * validated; this proves what they refuse and, as importantly, what they do
 * NOT refuse (basements, the ground floor, the top floor, unknowns, and the
 * zeros that mean something).
 *
 * EVERY case also asks the app's rule (lib/validators/property-measurements.ts)
 * about the row the write would leave, and requires the same answer: the
 * forms refuse with a named message exactly what the table refuses with a
 * 23514. If either side moves alone — a CHECK tightened to `<`, a rule
 * loosened — this file fails, not production.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measurementProblem } from "../../lib/validators/property-measurements";
import { ORG_A, ensureTestOrg, serviceClient } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);

/** The flat every case writes to, as seeded: a flat on the 2nd of 4 floors. */
const SEEDED = { covered_area_sqm: 92, plot_area_sqm: null, floor_number: 2, total_floors: 4 };
const REFUSED_INSERT_REF = `ZZTESTMI${run}`.slice(0, 20);

let flatId: string;
let projectId: string;

/** The measurement columns as stored — what a refused write must have left alone. */
async function stored(id: string) {
  const { data, error } = await svc
    .from("properties")
    .select("covered_area_sqm, plot_area_sqm, floor_number, total_floors, updated_at")
    .eq("id", id)
    .single();
  if (error) throw new Error(`read back: ${error.message}`);
  return data;
}

/** Put the flat back to its seeded measurements between cases. */
async function reset() {
  const { error } = await svc.from("properties").update(SEEDED).eq("id", flatId);
  if (error) throw new Error(`reset: ${error.message}`);
}

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");

  const { data: flat, error: flatErr } = await svc
    .from("properties")
    .insert({
      org_id: ORG_A,
      reference: `ZZTESTMS${run}`.slice(0, 20),
      property_type: "apartment",
      status: "available",
      ...SEEDED,
    })
    .select("id")
    .single();
  if (flatErr) throw new Error(`seed flat: ${flatErr.message}`);
  flatId = flat.id;

  const { data: project, error: projectErr } = await svc
    .from("properties")
    .insert({
      org_id: ORG_A,
      reference: `ZZTESTMP${run}`.slice(0, 20),
      kind: "project",
      property_type: "apartment",
      status: "available",
    })
    .select("id")
    .single();
  if (projectErr) throw new Error(`seed project: ${projectErr.message}`);
  projectId = project.id;
});

afterAll(async () => {
  // no events are written for these rows (service-role writes; events are the
  // app's), so deleting them leaves no hole in any chain. The project's unit
  // types go with it (unit_types_project_id_fkey ON DELETE CASCADE).
  await svc.from("properties").delete().in("id", [flatId, projectId].filter(Boolean));
  await svc.from("properties").delete().eq("org_id", ORG_A).eq("reference", REFUSED_INSERT_REF);
});

describe("0113 refuses an impossible measurement on every write path (23514) — and so does the app", () => {
  it.each([
    ["covered_area_sqm = 0", { covered_area_sqm: 0 }, "properties_covered_area_positive"],
    ["covered_area_sqm < 0", { covered_area_sqm: -5 }, "properties_covered_area_positive"],
    // 0.004::numeric(10,2) is 0.00 — positive in JavaScript, zero when stored
    ["covered_area_sqm = 0.004", { covered_area_sqm: 0.004 }, "properties_covered_area_positive"],
    ["plot_area_sqm = 0", { plot_area_sqm: 0 }, "properties_plot_area_positive"],
    ["floor 9 of 3", { floor_number: 9, total_floors: 3 }, "properties_floor_within_total"],
  ])("UPDATE %s is refused and the row is unchanged", async (_label, patch, constraint) => {
    await reset();
    expect(measurementProblem({ ...SEEDED, ...patch }), "the app refuses it too").not.toBeNull();

    const before = await stored(flatId);
    const { data, error } = await svc.from("properties").update(patch).eq("id", flatId).select("id");
    expect(error, "refused").not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toContain(constraint);
    expect(data).toBeNull();
    expect(await stored(flatId), "the refused write changed nothing").toEqual(before);
  });

  it("an INSERT carrying a zero area is refused (the importer's shape)", async () => {
    const row = { covered_area_sqm: null, plot_area_sqm: 0, floor_number: null, total_floors: null };
    expect(measurementProblem(row), "the importer's rule refuses it too").not.toBeNull();
    const { error } = await svc.from("properties").insert({
      org_id: ORG_A,
      reference: REFUSED_INSERT_REF,
      property_type: "land",
      status: "available",
      ...row,
    });
    expect(error?.code).toBe("23514");
    expect(error!.message).toContain("properties_plot_area_positive");
    const { count } = await svc
      .from("properties")
      .select("id", { count: "exact", head: true })
      .eq("reference", REFUSED_INSERT_REF);
    expect(count, "no row was created").toBe(0);
  });

  it("a PARTIAL update cannot pair a new value with a stored one it never mentioned", async () => {
    await reset();
    // floor 9 with the building height unknown is admissible…
    const heightUnknown = { ...SEEDED, floor_number: 9, total_floors: null };
    expect(measurementProblem(heightUnknown)).toBeNull();
    const { error: floorOnly } = await svc
      .from("properties")
      .update({ floor_number: 9, total_floors: null })
      .eq("id", flatId);
    expect(floorOnly).toBeNull();

    // …and a later write that sends ONLY the height is checked against the
    // floor already stored: the CHECK sees the resulting row, not the patch
    expect(measurementProblem({ ...heightUnknown, total_floors: 3 })).not.toBeNull();
    const { error } = await svc.from("properties").update({ total_floors: 3 }).eq("id", flatId);
    expect(error?.code).toBe("23514");
    expect(error!.message).toContain("properties_floor_within_total");
    expect(await stored(flatId)).toMatchObject({ floor_number: 9, total_floors: null });

    // and the other way round: a stored height, a new floor alone
    await reset();
    expect(measurementProblem({ ...SEEDED, floor_number: 5 })).not.toBeNull();
    const { error: floorAbove } = await svc
      .from("properties")
      .update({ floor_number: 5 })
      .eq("id", flatId);
    expect(floorAbove?.code).toBe("23514");
    expect(await stored(flatId)).toMatchObject({ floor_number: 2, total_floors: 4 });
  });

  it("a unit type cannot hold a zero area, so stamping one onto units cannot fail half-way", async () => {
    expect(measurementProblem({ covered_area_sqm: 0 })).not.toBeNull();
    const { error } = await svc.from("unit_types").insert({
      org_id: ORG_A,
      project_id: projectId,
      code: `Z${run}`.slice(0, 10).toUpperCase(),
      covered_area_sqm: 0,
    });
    expect(error?.code).toBe("23514");
    expect(error!.message).toContain("unit_types_covered_area_positive");
  });
});

describe("0113 admits every legitimate case — and so does the app", () => {
  it.each([
    ["the ground floor", { floor_number: 0, total_floors: 3 }],
    ["a basement", { floor_number: -1, total_floors: 3 }],
    ["a basement under a 0-floor record", { floor_number: -2, total_floors: 0 }],
    ["the top floor (total_floors' ground-storey convention is not fixed, so ≤ not <)", { floor_number: 3, total_floors: 3 }],
    ["a floor with the height unknown", { floor_number: 7, total_floors: null }],
    ["a height with the floor unknown", { floor_number: null, total_floors: 5 }],
    ["both unknown", { floor_number: null, total_floors: null }],
    ["the smallest storable area", { covered_area_sqm: 0.01, plot_area_sqm: 0.01 }],
    ["unknown areas", { covered_area_sqm: null, plot_area_sqm: null }],
    [
      "zeros that mean something (a studio, no parking, no veranda)",
      { bedrooms: 0, parking_spaces: 0, veranda_sqm: 0, basement_sqm: 0, roof_garden_sqm: 0 },
    ],
  ])("%s", async (_label, patch) => {
    await reset();
    expect(measurementProblem({ ...SEEDED, ...patch }), "the app admits it too").toBeNull();
    const { data, error } = await svc.from("properties").update(patch).eq("id", flatId).select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("a unit type with a positive or unknown area", async () => {
    expect(measurementProblem({ covered_area_sqm: 85 })).toBeNull();
    const { error } = await svc.from("unit_types").insert([
      { org_id: ORG_A, project_id: projectId, code: `P${run}`.slice(0, 10).toUpperCase(), covered_area_sqm: 85 },
      { org_id: ORG_A, project_id: projectId, code: `N${run}`.slice(0, 10).toUpperCase(), covered_area_sqm: null },
    ]);
    expect(error).toBeNull();
  });
});
