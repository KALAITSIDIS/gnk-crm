import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * A unit's status from the units grid (T-unit-status-atomic, migration 0143).
 *
 * What only the browser can show: the grid says the TRUE outcome, and the
 * trigger shows the status the database holds — never a pick it refused, and
 * never "Saved" or "failed" for an answer that did not arrive. The database
 * side of every outcome is pinned in supabase/tests/unit-status-actions.test.ts.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seed(admin: SupabaseClient, orgId: string, actorId: string) {
  const tag = randomBytes(3).toString("hex").toUpperCase();
  const { data: project } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-US-${tag}`,
      kind: "project" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      title: { en: "E2E unit status project" },
    })
    .select("id, reference")
    .single();
  const { data: units } = await admin
    .from("properties")
    .insert(
      ["101", "102", "103"].map((n) => ({
        org_id: orgId,
        reference: `${project!.reference}-A${n}`,
        kind: "unit" as const,
        parent_id: project!.id,
        property_type: "apartment" as const,
        status: "available" as const,
        block: "A",
        unit_number: n,
      })),
    )
    .select("id, reference")
    .order("reference");
  // what a won deal leaves behind on the first unit: the check a sale satisfies
  const { data: task } = await admin
    .from("tasks")
    .insert({
      org_id: orgId,
      title: "E2E set the listing status",
      due_at: new Date().toISOString(),
      assignee_id: actorId,
      created_by: actorId,
      property_id: units![0]!.id,
      kind: "listing_status_check",
    })
    .select("id")
    .single();
  return { project: project!, units: units!, taskId: task!.id as string };
}

async function cleanup(admin: SupabaseClient, projectId: string) {
  await admin.from("tasks").delete().in("property_id", (await admin.from("properties").select("id").eq("parent_id", projectId)).data!.map((u) => u.id));
  await admin.from("properties").delete().eq("parent_id", projectId);
  await admin.from("properties").delete().eq("id", projectId);
}

const statusLines = async (admin: SupabaseClient, unitId: string) =>
  (
    await admin
      .from("events")
      .select("actor_id, payload")
      .eq("entity_type", "property")
      .eq("entity_id", unitId)
      .eq("event_type", "status_changed")
  ).data ?? [];

async function pick(page: Page, reference: string, label: string) {
  await page.getByLabel(`Status of ${reference}`).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

const toast = (page: Page, text: string | RegExp) => page.locator("[data-sonner-toast]").filter({ hasText: text });

test("a change is saved with ONE line, closes the check it satisfies, and the trigger shows it", async ({ page }) => {
  const admin = svc();
  const { id: actorId, orgId } = await fixtureProfile(admin);
  const { project, units, taskId } = await seed(admin, orgId, actorId);
  const unit = units[0]!;
  try {
    await page.goto(`/properties/${project.id}/units`);
    await pick(page, unit.reference, "Sold");
    await expect(toast(page, "Saved")).toBeVisible();
    await expect(page.getByLabel(`Status of ${unit.reference}`)).toContainText(/sold/i);

    const { data: row } = await admin.from("properties").select("status").eq("id", unit.id).single();
    expect(row!.status).toBe("sold");
    const lines = await statusLines(admin, unit.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actor_id: actorId, payload: { reference: unit.reference, from: "available", to: "sold" } });
    expect(lines[0]!.payload.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    const { data: task } = await admin.from("tasks").select("is_done").eq("id", taskId).single();
    expect(task!.is_done, "the check the sale satisfies is closed").toBe(true);
  } finally {
    await cleanup(admin, project.id);
  }
});

test("a unit that moved since the page loaded: refused in words, nothing written, the trigger shows what the database holds", async ({ page }) => {
  const admin = svc();
  const { id: actorId, orgId } = await fixtureProfile(admin);
  const { project, units } = await seed(admin, orgId, actorId);
  const unit = units[1]!;
  try {
    await page.goto(`/properties/${project.id}/units`);
    await expect(page.getByLabel(`Status of ${unit.reference}`)).toContainText(/available/i);
    // someone else reserves it while this page is open
    await admin.from("properties").update({ status: "reserved" }).eq("id", unit.id);

    await pick(page, unit.reference, "Sold");
    await expect(toast(page, /This unit is now reserved — it changed after this page was loaded/)).toBeVisible();
    // refreshed: the trigger shows the status the unit actually has, not the refused pick
    await expect(page.getByLabel(`Status of ${unit.reference}`)).toContainText(/reserved/i);

    const { data: row } = await admin.from("properties").select("status").eq("id", unit.id).single();
    expect(row!.status).toBe("reserved");
    expect(await statusLines(admin, unit.id), "the refused change wrote no line").toHaveLength(0);
  } finally {
    await cleanup(admin, project.id);
  }
});

test("an answer lost after the commit: 'could not confirm', never Saved or failed — Check answers it, one line", async ({ page }) => {
  const admin = svc();
  const { id: actorId, orgId } = await fixtureProfile(admin);
  const { project, units } = await seed(admin, orgId, actorId);
  const unit = units[2]!;
  try {
    await page.goto(`/properties/${project.id}/units`);

    // the Server Action POST reaches the server and commits; its answer never reaches the page
    let dropped = 0;
    const thisPage = (url: URL) => url.pathname === `/properties/${project.id}/units`;
    await page.route(
      thisPage,
      async (route) => {
        const req = route.request();
        if (dropped === 0 && req.method() === "POST" && req.headers()["next-action"]) {
          dropped += 1;
          await route.fetch();
          await route.abort("failed");
          return;
        }
        await route.continue();
      },
    );
    await pick(page, unit.reference, "Reserved");
    const unknown = toast(page, /Could not confirm whether the status was changed/);
    await expect(unknown).toBeVisible();
    expect(dropped).toBe(1);
    await expect(toast(page, "Saved")).toHaveCount(0);

    const { data: row } = await admin.from("properties").select("status").eq("id", unit.id).single();
    expect(row!.status, "the lost answer DID commit").toBe("reserved");
    expect(await statusLines(admin, unit.id)).toHaveLength(1);

    await page.unroute(thisPage);
    await unknown.getByRole("button", { name: "Check" }).click();
    await expect(toast(page, "Already saved — the change was made once.")).toBeVisible();
    expect(await statusLines(admin, unit.id), "Check wrote nothing twice").toHaveLength(1);
    await expect(page.getByLabel(`Status of ${unit.reference}`)).toContainText(/reserved/i);
  } finally {
    await cleanup(admin, project.id);
  }
});
