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
