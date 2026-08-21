import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The Parties panel (BACKLOG audit findings 1, 2 and 12).
 *
 * The point of these tests is the PERMISSION BOUNDARY, not the form. Writing
 * `assigned_agent_id` grants edit and photo-upload rights via
 * `properties_update` / `property_media_insert` (0002), so the section is
 * admin + listing manager only — enforced in the action, because the UPDATE
 * with-check tests `org_id` alone and RLS would otherwise let an agent hand
 * their own property away and lock themselves out of it.
 *
 * The regression these pin down is finding 1: before this panel existed,
 * `assigned_agent_id` was written in exactly one place (an agent creating their
 * own property), so every property an admin created was permanently uneditable
 * by every agent — with an error message naming a cure the product did not have.
 */

const svc = (): SupabaseClient => serviceClient();

// Seeding needs the service key, which only exists against the local stack.
// The desktop project is ALREADY signed in via storageState — calling login()
// here would sit on /login, get redirected to /dashboard, and wait forever for
// an email field that never renders.
test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seedProperty(
  admin: SupabaseClient,
  orgId: string,
  kind: "standalone" | "project",
): Promise<string> {
  const { data } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-PTY-${randomBytes(3).toString("hex")}`,
      kind,
      property_type: kind === "project" ? "apartment" : "villa",
      status: "available",
      title: { en: `E2E parties ${kind}` },
      // deliberately unassigned — that IS the finding-1 starting state
      assigned_agent_id: null,
    })
    .select("id")
    .single();
  return data!.id as string;
}

test.describe("property parties", () => {
  test("developer field appears for a project and not for a standalone", async ({ page }) => {
    const admin = svc();
    const { orgId } = await fixtureProfile(admin);
    const standaloneId = await seedProperty(admin, orgId, "standalone");
    const projectId = await seedProperty(admin, orgId, "project");


    // A standalone listing belongs to a private owner by definition. The field
    // is not rendered, which is exactly why resolvePartyUpdates must not read
    // its absence as "clear" — the same trap as the land panel.
    await page.goto(`/properties/${standaloneId}`);
    await expect(page.getByLabel("Owner", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Assigned agent", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Developer", { exact: true })).toHaveCount(0);

    await page.goto(`/properties/${projectId}`);
    await expect(page.getByLabel("Developer", { exact: true })).toBeVisible();

    await admin.from("properties").delete().in("id", [standaloneId, projectId]);
  });

  test("the owner picker offers owners and refuses buyers", async ({ page }) => {
    const admin = svc();
    const { orgId } = await fixtureProfile(admin);
    const propertyId = await seedProperty(admin, orgId, "standalone");

    const tag = randomBytes(3).toString("hex");
    const { data: contacts } = await admin
      .from("contacts")
      .insert([
        {
          org_id: orgId,
          contact_kind: "person",
          first_name: "Ownerz",
          last_name: tag,
          contact_types: ["owner"],
        },
        {
          org_id: orgId,
          contact_kind: "person",
          first_name: "Buyerz",
          last_name: tag,
          contact_types: ["buyer"],
        },
      ])
      .select("id");
    const contactIds = (contacts ?? []).map((c) => c.id as string);

    await page.goto(`/properties/${propertyId}`);

    // Same surname, so the ONLY thing separating them is contact_types — if the
    // filter regressed, Buyerz would show up alongside Ownerz.
    await page.getByLabel("Owner", { exact: true }).fill(tag);
    await expect(page.getByRole("button", { name: /Ownerz/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Buyerz/ })).toHaveCount(0);

    await admin.from("properties").delete().eq("id", propertyId);
    await admin.from("contacts").delete().in("id", contactIds);
  });

  test("assigning an agent through the panel is what unlocks the property", async ({ page }) => {
    const admin = svc();
    const { orgId } = await fixtureProfile(admin);
    const propertyId = await seedProperty(admin, orgId, "standalone");

    const { data: agent } = await admin
      .from("profiles")
      .select("id, full_name")
      .eq("role", "agent")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    test.skip(!agent, "no active agent profile in this environment");

    await page.goto(`/properties/${propertyId}`);

    // Drive the real control: search, pick, save.
    await page.getByLabel("Assigned agent", { exact: true }).fill(agent!.full_name.slice(0, 4));
    await page.getByRole("button", { name: new RegExp(agent!.full_name) }).click();
    await page
      .locator("form", { has: page.locator('input[name="section"][value="parties"]') })
      .getByRole("button", { name: "Save" })
      .click();
    await expect(page.getByText("Saved")).toBeVisible();

    // The column that RLS reads is the assertion — a green toast is not proof.
    const { data: after } = await admin
      .from("properties")
      .select("assigned_agent_id")
      .eq("id", propertyId)
      .single();
    expect(after!.assigned_agent_id).toBe(agent!.id);

    // …and the mutation carries its event, per the repo's first guardrail.
    const { data: events } = await admin
      .from("events")
      .select("event_type, payload")
      .eq("entity_type", "property")
      .eq("entity_id", propertyId)
      .order("id", { ascending: false })
      .limit(1);
    expect(events?.[0]?.event_type).toBe("updated");
    expect((events?.[0]?.payload as { section?: string })?.section).toBe("parties");

    await admin.from("properties").delete().eq("id", propertyId);
  });
});
