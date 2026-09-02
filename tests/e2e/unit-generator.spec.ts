import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * Bulk unit generation (BACKLOG proposal, follow-on to finding 5).
 *
 * Two things are worth a test here, and neither is "the form submits".
 *
 * The COLLISION GUARD, because a partial generation is the worst outcome: you
 * cannot tell by looking which half of a block landed, and the obvious retry
 * then collides with the half that did.
 *
 * The INHERITANCE, because generated units must arrive identical to a
 * hand-added one — a second inheritance path that drifted from `createUnit`
 * would be worse than no generator at all. Including the exclusion: a `public`
 * project must not mint sixty already-published empty units.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seedProject(admin: SupabaseClient, orgId: string) {
  const { data: district } = await admin
    .from("districts")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", "PAF")
    .single();

  const { data } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-GEN-${randomBytes(3).toString("hex")}`,
      kind: "project" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      district_id: district!.id,
      title: { en: "E2E generator project" },
      vat_status: "new_vat" as const,
      title_deed_status: "pending" as const,
      delivery_date: "2027-06-30",
    })
    .select("id, reference")
    .single();
  return data!;
}

/**
 * Remove a seeded project and everything under it. Order matters —
 * `properties.parent_id` is ON DELETE RESTRICT — so units go before the phase
 * that holds them, and both go before the project. Two levels are enough:
 * `createPhase` refuses a phase inside a phase.
 */
async function cleanupProject(admin: SupabaseClient, projectId: string) {
  const { data: children } = await admin
    .from("properties")
    .select("id")
    .eq("parent_id", projectId);
  const childIds = (children ?? []).map((c) => c.id);
  if (childIds.length > 0) {
    await admin.from("properties").delete().in("parent_id", childIds);
  }
  await admin.from("properties").delete().eq("parent_id", projectId);
  await admin.from("properties").delete().eq("id", projectId);
}

/**
 * Insert a phase or a unit under `parentId` the way the app's own actions do:
 * same org, district, property type and transaction type as the parent,
 * available, private. The reference is the caller's — the app composes it as
 * `${parent.reference}-${code}` (createPhase, createUnit) and so do the tests.
 */
async function seedChild(
  admin: SupabaseClient,
  parentId: string,
  child: {
    kind: "phase" | "unit";
    reference: string;
    unit_number?: string;
    asking_price?: number;
  },
) {
  const { data: parent } = await admin
    .from("properties")
    .select("org_id, district_id, property_type, transaction_type")
    .eq("id", parentId)
    .single();
  const { data, error } = await admin
    .from("properties")
    .insert({
      org_id: parent!.org_id,
      district_id: parent!.district_id,
      property_type: parent!.property_type,
      transaction_type: parent!.transaction_type,
      parent_id: parentId,
      kind: child.kind,
      reference: child.reference,
      unit_number: child.unit_number ?? null,
      asking_price: child.asking_price ?? null,
      status: "available" as const,
      visibility: "private" as const,
      title: { en: child.reference },
    })
    .select("id")
    .single();
  expect(error, `seeding ${child.kind} ${child.reference}`).toBeNull();
  return data!;
}

/** Fill the generator form and submit it. */
async function generate(
  page: import("@playwright/test").Page,
  fields: Record<string, string>,
) {
  for (const [id, value] of Object.entries(fields)) {
    await page.locator(`#${id}`).fill(value);
  }
  await page.getByRole("button", { name: /^Generate \d+ units$/ }).click();
}

test.describe("bulk unit generation", () => {
  test("creates a whole block, inheriting the project but never its visibility", async ({
    page,
  }) => {
    const admin = svc();
    const { orgId } = await fixtureProfile(admin);
    const project = await seedProject(admin, orgId);

    // A published project is the dangerous case: units must NOT come out public.
    await admin.from("properties").update({ visibility: "public" }).eq("id", project.id);

    await page.goto(`/properties/${project.id}/units`);
    await generate(page, {
      "gen-block": "A",
      "gen-floor-from": "1",
      "gen-floor-to": "3",
      "gen-per-floor": "2",
      "gen-base-price": "200000",
      "gen-price-step": "10000",
    });

    await expect(page.getByText("Units generated")).toBeVisible();

    const { data: units } = await admin
      .from("properties")
      .select("reference, floor_number, asking_price, visibility, vat_status, title_deed_status, delivery_date")
      .eq("parent_id", project.id)
      .order("reference");

    expect(units).toHaveLength(6);
    expect(units!.map((u) => u.reference)).toEqual([
      `${project.reference}-A101`,
      `${project.reference}-A102`,
      `${project.reference}-A201`,
      `${project.reference}-A202`,
      `${project.reference}-A301`,
      `${project.reference}-A302`,
    ]);

    // price climbs a floor at a time, from the bottom floor's base
    expect(units!.map((u) => Number(u.asking_price))).toEqual([
      200000, 200000, 210000, 210000, 220000, 220000,
    ]);

    // inherited from the project…
    for (const u of units!) {
      expect(u.vat_status).toBe("new_vat");
      expect(u.title_deed_status).toBe("pending");
      expect(u.delivery_date).toBe("2027-06-30");
      // …except visibility, which would publish an empty unit
      expect(u.visibility).toBe("private");
    }

    // Every unit owes its OWN event — six units, six created rows, each marked
    // as generated so the timeline distinguishes a block from a hand-added unit.
    const { data: ids } = await admin
      .from("properties")
      .select("id")
      .eq("parent_id", project.id);
    const { data: events } = await admin
      .from("events")
      .select("entity_id, event_type, payload")
      .eq("entity_type", "property")
      .in("entity_id", ids!.map((u) => u.id));

    expect(events).toHaveLength(6);
    expect(new Set(events!.map((e) => e.entity_id)).size).toBe(6);
    for (const e of events!) {
      expect(e.event_type).toBe("created");
      const payload = e.payload as { generated?: boolean; inherited?: string[] };
      expect(payload.generated).toBe(true);
      expect(payload.inherited).toContain("vat_status");
    }

    // …and the hash chain has to survive writing six of them in one statement
    const { data: chain } = await admin.rpc("verify_events_chain", { p_org: orgId });
    expect(chain).toBe(true);

    await admin.from("properties").delete().eq("parent_id", project.id);
    await admin.from("properties").delete().eq("id", project.id);
  });

  test("refuses the whole run when any reference already exists", async ({ page }) => {
    const admin = svc();
    const { orgId } = await fixtureProfile(admin);
    const project = await seedProject(admin, orgId);

    await page.goto(`/properties/${project.id}/units`);
    await generate(page, {
      "gen-block": "B",
      "gen-floor-from": "1",
      "gen-floor-to": "2",
      "gen-per-floor": "2",
    });
    await expect(page.getByText("Units generated")).toBeVisible();

    // Overlapping range: floor 2 already exists, floor 3 does not.
    await page.reload();
    await generate(page, {
      "gen-block": "B",
      "gen-floor-from": "2",
      "gen-floor-to": "3",
      "gen-per-floor": "2",
    });

    // scoped to the form: Next's route announcer is also role="alert"
    const formAlert = page
      .locator("form", { has: page.locator("#gen-block") })
      .getByRole("alert");
    await expect(formAlert).toContainText("already exist");
    await expect(formAlert).toContainText("nothing was created");

    // ALL or nothing: floor 3 must not have been created despite being free.
    const { data: after } = await admin
      .from("properties")
      .select("reference")
      .eq("parent_id", project.id);
    expect(after).toHaveLength(4);
    expect(after!.map((u) => u.reference)).not.toContain(`${project.reference}-B301`);

    await admin.from("properties").delete().eq("parent_id", project.id);
    await admin.from("properties").delete().eq("id", project.id);
  });
});

/**
 * Inheritance drift and sync (BACKLOG audit finding 5, the drift half).
 *
 * Copy-on-create means a project edit does not reach units that already exist.
 * `inherited_fields` is what separates "nobody has touched this" from "somebody
 * set it deliberately", and the ONE thing that must never regress is that a
 * sync leaves the deliberate values alone. A sync that overwrites a per-unit
 * price or handover date is worse than no sync at all.
 */
test.describe("inheritance drift", () => {
  test("syncs the units that still inherit and spares the one that does not", async ({
    page,
  }) => {
    const admin = svc();
    const { orgId } = await fixtureProfile(admin);
    const project = await seedProject(admin, orgId);

    await page.goto(`/properties/${project.id}/units`);
    await generate(page, {
      "gen-block": "D",
      "gen-floor-from": "1",
      "gen-floor-to": "2",
      "gen-per-floor": "2",
    });
    await expect(page.getByText("Units generated")).toBeVisible();

    const { data: units } = await admin
      .from("properties")
      .select("id, reference")
      .eq("parent_id", project.id)
      .order("reference");
    expect(units).toHaveLength(4);

    // One unit is given its own VAT and opts out, exactly as a UI edit would.
    const opinionated = units![0];
    await admin
      .from("properties")
      .update({ vat_status: "resale_no_vat", inherited_fields: ["delivery_date"] })
      .eq("id", opinionated.id);

    // The project moves on.
    await admin
      .from("properties")
      .update({ vat_status: "reduced_rate_eligible" })
      .eq("id", project.id);

    await page.reload();

    // The panel counts 3, not 4 — the opinionated unit is invisible by design.
    const panel = page.getByText("Units are behind this project");
    await expect(panel).toBeVisible();
    await page.getByRole("button", { name: "Update 3" }).click();
    await expect(page.getByText("3 units updated")).toBeVisible();

    const { data: after } = await admin
      .from("properties")
      .select("id, vat_status")
      .eq("parent_id", project.id);

    const opinion = after!.find((u) => u.id === opinionated.id);
    expect(opinion!.vat_status).toBe("resale_no_vat"); // untouched
    for (const u of after!.filter((u) => u.id !== opinionated.id)) {
      expect(u.vat_status).toBe("reduced_rate_eligible");
    }

    // and the chain survives the bulk sync events
    const { data: chain } = await admin.rpc("verify_events_chain", { p_org: orgId });
    expect(chain).toBe(true);

    await admin.from("properties").delete().eq("parent_id", project.id);
    await admin.from("properties").delete().eq("id", project.id);
  });
});

/**
 * Villas do not stack (2026-09-02). The floor grid would have numbered them
 * 101…1NN and written floor_number = 1 on each — an apartment number and a
 * lie, both of which reach a proposal through the availability share.
 */
test.describe("villa complexes", () => {
  // Keyed on the seeded id rather than deleted inline, so a failed assertion
  // still removes its villas (units first: parent_id is ON DELETE RESTRICT).
  let seededId: string | null = null;
  test.afterEach(async () => {
    if (!seededId) return;
    await cleanupProject(svc(), seededId);
    seededId = null;
  });

  test("generates numbered villas with no floor, and prices the row", async ({ page }) => {
    const admin = svc();
    const { orgId } = await fixtureProfile(admin);
    const project = await seedProject(admin, orgId);
    seededId = project.id;

    await page.goto(`/properties/${project.id}/units`, { waitUntil: "networkidle" });

    // switch the generator to villas
    await page.getByRole("button", { name: /^Villas$/ }).click();
    await page.locator("#gen-villa-count").fill("4");
    await page.locator("#gen-villa-prefix").fill("V");
    await page.locator("#gen-base-price").fill("800000");
    await page.locator("#gen-villa-step").fill("50000");

    // the preview is built by the SAME function the action calls
    await expect(page.getByTestId("generate-preview")).toContainText(`${project.reference}-V01`);
    await expect(page.getByTestId("generate-preview")).toContainText(`${project.reference}-V04`);

    await page.getByRole("button", { name: /^Generate 4 villas$/ }).click();

    await expect
      .poll(async () => {
        const { count } = await admin
          .from("properties")
          .select("id", { count: "exact", head: true })
          .eq("parent_id", project.id);
        return count ?? 0;
      }, { timeout: 20_000 })
      .toBe(4);

    const { data: villas } = await admin
      .from("properties")
      .select("reference, unit_number, floor_number, asking_price, kind, visibility")
      .eq("parent_id", project.id)
      .order("unit_number");

    // padded, so text ordering reads correctly past nine
    expect(villas!.map((v) => v.unit_number)).toEqual(["V01", "V02", "V03", "V04"]);
    expect(villas!.map((v) => v.reference)).toEqual([
      `${project.reference}-V01`,
      `${project.reference}-V02`,
      `${project.reference}-V03`,
      `${project.reference}-V04`,
    ]);
    // the whole point: no invented floor
    expect(villas!.every((v) => v.floor_number === null), "villas have no floor").toBe(true);
    expect(villas!.map((v) => Number(v.asking_price))).toEqual([800000, 850000, 900000, 950000]);
    expect(villas!.every((v) => v.kind === "unit")).toBe(true);
    // the visibility exclusion holds on this path too
    expect(villas!.every((v) => v.visibility === "private")).toBe(true);
  });
});

/**
 * The incident this whole change exists for: a project with no units scored
 * 100/100 and went public, where no buyer could be matched to it and nobody
 * could reserve it.
 */
test.describe("an empty container is not a listing", () => {
  let seededId: string | null = null;
  test.afterEach(async () => {
    if (!seededId) return;
    await cleanupProject(svc(), seededId);
    seededId = null;
  });

  const CONTAINER_REFUSAL = /with no units cannot be published/i;

  /** The details form — the visibility select, the admin override and Save live here. */
  const detailsForm = (page: import("@playwright/test").Page) =>
    page.locator("form").filter({ has: page.getByLabel(/^visibility$/i) });

  /**
   * Set visibility Public and press Save, then wait for the server action's
   * round trip. The wait is what makes a SECOND save assertable: the refusal
   * from the first save is still on screen, so "the message is visible" alone
   * could not tell a refused save from one that never happened.
   */
  async function savePublic(page: import("@playwright/test").Page, projectId: string) {
    await page.getByLabel(/^visibility$/i).click();
    await page.getByRole("option", { name: /^public$/i }).click();
    const roundTrip = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" && new URL(r.url()).pathname === `/properties/${projectId}`,
    );
    await detailsForm(page).getByRole("button", { name: /^save$/i }).click();
    await roundTrip;
  }

  /** The admin's override checkbox (detail-forms.tsx: `<Checkbox id="publish_override">`). */
  async function tickOverride(page: import("@playwright/test").Page) {
    const override = detailsForm(page).locator("#publish_override");
    await override.check();
    await expect(override).toBeChecked();
  }

  test("scores the missing units and refuses to publish", async ({ page }) => {
    const admin = svc();
    const { orgId } = await fixtureProfile(admin);
    const project = await seedProject(admin, orgId);
    seededId = project.id;

    await page.goto(`/properties/${project.id}`, { waitUntil: "networkidle" });
    // The score grades a container on its units, not on rooms and area: the
    // ring's tooltip must list the container item and NOT a dwelling's. The
    // number itself is pinned in quality-score.test.ts; this pins the branch.
    const ring = page.getByLabel(/quality score \d+ of 100/i);
    await expect(ring).toBeVisible({ timeout: 15_000 });
    await ring.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("At least one unit");
    await expect(tooltip).not.toContainText("Covered area set");

    // try to publish it
    await page.getByRole("tab", { name: /^details$/i }).click();
    await savePublic(page, project.id);
    await expect(page.getByText(CONTAINER_REFUSAL)).toBeVisible({ timeout: 15_000 });

    // and it really did not publish
    const { data: after } = await admin
      .from("properties")
      .select("visibility")
      .eq("id", project.id)
      .single();
    expect(after!.visibility, "the refusal is not cosmetic").not.toBe("public");

    // The admin override is for a listing that is thin but deliberate. An
    // empty container is not thin, it is empty — so the override must neither
    // publish it NOR be written to the log as if it had been consulted.
    await tickOverride(page);
    await savePublic(page, project.id);
    await expect(page.getByText(CONTAINER_REFUSAL)).toBeVisible();
    // exact: the details panel also says "derived, not saved" in running text
    await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);

    const { data: overridden } = await admin
      .from("properties")
      .select("visibility")
      .eq("id", project.id)
      .single();
    expect(overridden!.visibility, "the override does not reach an empty container").not.toBe(
      "public",
    );
    const { data: overrideEvents } = await admin
      .from("events")
      .select("id")
      .eq("entity_type", "property")
      .eq("entity_id", project.id)
      .eq("event_type", "publish_override");
    expect(overrideEvents, "no override was consulted, so none may be logged").toEqual([]);
  });

  /**
   * A phase is a container too, not a unit: a project holding only an empty
   * phase has nothing a buyer can act on. But a unit UNDER that phase is a
   * unit of the project — that is how a phased development is laid out — so
   * the count has to look one level down, not just at direct children.
   */
  test("a phase is not a unit", async ({ page }) => {
    const admin = svc();
    const { orgId } = await fixtureProfile(admin);
    const project = await seedProject(admin, orgId);
    seededId = project.id;

    const phase = await seedChild(admin, project.id, {
      kind: "phase",
      reference: `${project.reference}-P1`,
    });

    // With the override ticked from the start, the score gate cannot be the
    // thing that refuses — only the container rule can.
    const publishWithOverride = async () => {
      await page.goto(`/properties/${project.id}`, { waitUntil: "networkidle" });
      await page.getByRole("tab", { name: /^details$/i }).click();
      await tickOverride(page);
      await savePublic(page, project.id);
    };

    // plain save first: a phase-only project is refused with no override in
    // sight (the refusal runs before the override is ever read)
    await page.goto(`/properties/${project.id}`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^details$/i }).click();
    await savePublic(page, project.id);
    await expect(page.getByText(CONTAINER_REFUSAL)).toBeVisible({ timeout: 15_000 });

    await publishWithOverride();
    await expect(page.getByText(CONTAINER_REFUSAL)).toBeVisible({ timeout: 15_000 });
    const { data: withPhaseOnly } = await admin
      .from("properties")
      .select("visibility")
      .eq("id", project.id)
      .single();
    expect(withPhaseOnly!.visibility, "a phase must not count as a unit").not.toBe("public");

    // one unit under the phase makes the project a listing
    await seedChild(admin, phase.id, {
      kind: "unit",
      reference: `${project.reference}-P1-01`,
      unit_number: "01",
      asking_price: 100000,
    });

    await publishWithOverride();
    // exact: the details panel carries "derived, not saved" in running text,
    // which a substring match accepts even when the save was refused
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(CONTAINER_REFUSAL)).toHaveCount(0);
    await expect
      .poll(async () => {
        const { data } = await admin
          .from("properties")
          .select("visibility")
          .eq("id", project.id)
          .single();
        return data?.visibility;
      })
      .toBe("public");
  });
});
