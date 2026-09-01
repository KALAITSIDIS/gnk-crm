import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The create wizard's party half (migration 0038) — the last piece of the
 * operator's opening request: choose the developer, and the record starts as
 * that developer's records always start.
 *
 * The assertion that matters is the WRITE, not the preview. The wizard shows
 * the terms before submit, but the action re-resolves them server-side, because
 * a form can post anything and these set a VAT treatment and a legal status on
 * a record the desk will quote from.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

test("choosing a developer writes their terms onto the new property", async ({ page }) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");

  const { data: district } = await admin
    .from("districts")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("code", "LIM")
    .single();

  const { data: developer } = await admin
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_kind: "company",
      company_name: `Wizardev ${tag}`,
      contact_types: ["developer"],
      party_defaults: {
        vat_status: "new_vat",
        title_deed_status: "pending",
        district_id: district!.id,
      },
    })
    .select("id")
    .single();

  await page.goto("/properties/new");

  // switch the source to developer — the picker follows it
  await page.getByLabel("Where is it from?").click();
  await page.getByRole("option", { name: "A developer" }).click();

  await page.getByLabel("Developer").fill(`Wizardev ${tag}`);
  await page.getByRole("button", { name: new RegExp(`Wizardev ${tag}`) }).click();

  // the terms are stated before submit, and the district comes from them
  await expect(page.getByText(/From Wizardev/)).toBeVisible();
  // the combobox specifically: the label text also appears in the hidden
  // native select Radix renders for form submission
  await expect(page.getByLabel("District")).toContainText(
    (district!.name as { en?: string }).en!,
  );

  // the source also chose the kind
  await expect(page.getByLabel("Kind")).toContainText("Developer project");

  await page.getByLabel("Property type").click();
  await page.getByRole("option", { name: "Apartment", exact: true }).click();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByLabel("Title (EN)").fill(`Wizard party ${tag}`);
  await page.getByRole("button", { name: /Create property/ }).click();

  await page.waitForURL(/\/properties\/[0-9a-f-]{36}$/);

  const { data: created } = await admin
    .from("properties")
    .select("kind, developer_contact_id, owner_contact_id, vat_status, title_deed_status, district_id, permit_status")
    .eq("title->>en", `Wizard party ${tag}`)
    .single();

  // the party column the SOURCE named, and only that one
  expect(created!.developer_contact_id).toBe(developer!.id);
  expect(created!.owner_contact_id).toBeNull();
  expect(created!.kind).toBe("project");
  // …and the terms, re-resolved server-side
  expect(created!.vat_status).toBe("new_vat");
  expect(created!.title_deed_status).toBe("pending");
  expect(created!.district_id).toBe(district!.id);
  // a term the party has no opinion on keeps the column's own default
  expect(created!.permit_status).toBe("unknown");

  // the timeline explains values nobody typed
  const { data: property } = await admin
    .from("properties")
    .select("id")
    .eq("title->>en", `Wizard party ${tag}`)
    .single();
  const { data: events } = await admin
    .from("events")
    .select("payload")
    .eq("entity_id", property!.id)
    .eq("event_type", "created")
    .single();
  const payload = events!.payload as { applied_defaults?: string[]; source?: string };
  expect(payload.source).toBe("developer");
  expect(payload.applied_defaults).toEqual(
    expect.arrayContaining(["vat_status", "title_deed_status"]),
  );

  await admin.from("properties").delete().eq("id", property!.id);
  await admin.from("contacts").delete().eq("id", developer!.id);
});

/**
 * A search box that renders nothing on zero hits is indistinguishable from a
 * broken one — the agent cannot tell "still looking", "nothing here" and "this
 * field is dead" apart, and reports it as a bug (a browser-agent session did
 * exactly that on 2026-09-01). The empty state is the fix; this pins it.
 */
test("the owner search says so when it finds nothing, and points at the way out", async ({
  page,
}) => {
  await page.goto("/properties/new", { waitUntil: "networkidle" });

  const search = page.getByPlaceholder(/search owners/i);
  await expect(search).toBeVisible();
  // a string no seeded contact can match
  await search.fill("zzzznobody");

  const empty = page.getByText(/no matches for/i);
  await expect(empty, "zero hits must SAY zero hits").toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/use .New owner. below to create one/i)).toBeVisible();
});
