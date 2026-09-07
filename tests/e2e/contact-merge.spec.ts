import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * Merging a duplicate contact — irreversible, admin-only, and until now with
 * NO automated coverage of any kind (no e2e spec, no unit test named
 * `mergeContacts`; `leads-dedup.spec` covers DETECTING a duplicate, never
 * merging one). Erasure is the other uncovered irreversible operation.
 *
 * The rule this pins is not "the action does what it currently does" — that
 * would just photograph the bug. It is: EVERY row that pointed at the
 * duplicate points at the primary afterwards. The list below is derived from
 * the schema (every FK column referencing `contacts`), so a table added later
 * and forgotten in the repoint list fails here rather than in a client's
 * database.
 *
 * That distinction matters because the failure is silent. The duplicate is
 * archived, so a record left behind on it is not deleted and raises no error —
 * it simply stops appearing anywhere the desk looks. A buyer's saved searches
 * left on the archived half stop matching; nobody is told.
 */

const PRIMARY = "E2EMergeKeep";
const DUPLICATE = "E2EMergeGone";
const REF = "E2EMERGE1";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: props } = await svc.from("properties").select("id").eq("reference", REF);
  const { data: contacts } = await svc
    .from("contacts")
    .select("id")
    .in("first_name", [PRIMARY, DUPLICATE]);
  const cids = (contacts ?? []).map((c) => c.id);
  const pids = (props ?? []).map((p) => p.id);

  if (pids.length) {
    await svc.from("offers").delete().in("property_id", pids);
    await svc.from("reservations").delete().in("property_id", pids);
    await svc.from("viewings").delete().in("property_id", pids);
    await svc.from("mandates").delete().in("property_id", pids);
  }
  if (cids.length) {
    await svc.from("share_links").delete().in("contact_id", cids);
    await svc.from("buyer_requirements").delete().in("contact_id", cids);
    await svc.from("tasks").delete().in("contact_id", cids);
    await svc.from("leads").delete().in("contact_id", cids);
    await svc.from("offers").delete().in("contact_id", cids);
    await svc.from("deals").delete().in("buyer_contact_id", cids);
    await svc.from("deals").delete().in("seller_contact_id", cids);
    await svc.from("viewings").delete().in("contact_id", cids);
    await svc.from("events").delete().in("entity_id", cids);
  }
  for (const id of pids) await svc.from("properties").delete().eq("id", id);
  // merged_into_id points contact→contact, so clear it before deleting
  if (cids.length) {
    await svc.from("contacts").update({ merged_into_id: null }).in("id", cids);
    await svc.from("contacts").delete().in("id", cids);
  }
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("merging a duplicate moves every record that pointed at it", async ({ page }) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { id: profileId, orgId } = await fixtureProfile(svc);

  const ins = async <T extends Record<string, unknown>>(table: string, row: T) => {
    const { data, error } = await svc.from(table).insert(row).select("id").single();
    expect(error, `seeding ${table}`).toBeNull();
    return data!.id as string;
  };

  // Two contacts. The duplicate carries a phone so the merge dialog can find
  // it by an exact, unambiguous query.
  const primaryId = await ins("contacts", {
    org_id: orgId,
    first_name: PRIMARY,
    contact_types: ["buyer"],
  });
  const duplicateId = await ins("contacts", {
    org_id: orgId,
    first_name: DUPLICATE,
    contact_types: ["buyer"],
    phone_e164: "+35799000199",
  });

  const propertyId = await ins("properties", {
    org_id: orgId,
    reference: REF,
    kind: "standalone",
    property_type: "apartment",
    transaction_type: "sale",
    status: "available",
    asking_price: 200000,
    owner_contact_id: duplicateId,
    developer_contact_id: duplicateId,
  });

  const { data: stage } = await svc
    .from("deal_stages")
    .select("id")
    .eq("org_id", orgId)
    .eq("deal_type", "sale")
    .order("sort_order")
    .limit(1)
    .single();

  const dealId = await ins("deals", {
    org_id: orgId,
    stage_id: stage!.id,
    title: "E2E merge deal",
    buyer_contact_id: duplicateId,
    seller_contact_id: duplicateId,
  });

  // One row per FK column referencing `contacts`, all hung off the duplicate.
  const rows: Record<string, string> = {
    leads: await ins("leads", { org_id: orgId, contact_id: duplicateId }),
    viewings: await ins("viewings", {
      org_id: orgId,
      property_id: propertyId,
      contact_id: duplicateId,
      agent_id: profileId,
      scheduled_at: new Date(Date.UTC(2027, 0, 4, 10, 0)).toISOString(),
    }),
    tasks: await ins("tasks", {
      org_id: orgId,
      title: "E2E merge task",
      contact_id: duplicateId,
    }),
    offers: await ins("offers", {
      org_id: orgId,
      deal_id: dealId,
      amount: 195000,
      contact_id: duplicateId,
    }),
    mandates: await ins("mandates", {
      org_id: orgId,
      property_id: propertyId,
      type: "exclusive",
      owner_contact_id: duplicateId,
    }),
    buyer_requirements: await ins("buyer_requirements", {
      org_id: orgId,
      contact_id: duplicateId,
      transaction_type: "sale",
      property_types: [],
      district_ids: [],
      area_ids: [],
      features_required: [],
      title_deed_required: false,
    }),
    reservations: await ins("reservations", {
      org_id: orgId,
      property_id: propertyId,
      contact_id: duplicateId,
      status: "held",
      expires_at: new Date(Date.UTC(2027, 0, 11)).toISOString(),
    }),
    share_links: await ins("share_links", {
      org_id: orgId,
      token_sha256: createHash("sha256").update(`e2e-merge-${REF}`).digest("hex"),
      locale: "en",
      title: "E2E merge proposal",
      expires_at: new Date(Date.UTC(2027, 0, 11)).toISOString(),
      created_by: profileId,
      contact_id: duplicateId,
    }),
  };

  try {
    // ---------- merge, through the UI a desk actually uses ----------
    await page.goto(`/contacts/${primaryId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^merge$/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(new RegExp(`merge a duplicate into.*${PRIMARY}`, "i"))).toBeVisible();
    await dialog.getByPlaceholder(/search name, phone, email/i).fill("99000199");
    await dialog.getByRole("button", { name: new RegExp(DUPLICATE, "i") }).click();
    await dialog.getByRole("button", { name: new RegExp(`merge ".*${DUPLICATE}.*" into`, "i") }).click();

    // the merge landed: the duplicate is archived and points at the primary
    await expect
      .poll(
        async () => {
          const { data } = await svc
            .from("contacts")
            .select("is_archived, merged_into_id")
            .eq("id", duplicateId)
            .single();
          return data?.is_archived === true && data?.merged_into_id === primaryId;
        },
        { timeout: opTimeout(20_000) },
      )
      .toBe(true);

    // ---------- and NOTHING was left behind on the archived half ----------
    const stillOnDuplicate: string[] = [];
    const check = async (table: string, column: string, id: string) => {
      const { data } = await svc.from(table).select(column).eq("id", id).single();
      const holder = (data as Record<string, string | null> | null)?.[column];
      if (holder !== primaryId) stillOnDuplicate.push(`${table}.${column}`);
    };
    await check("leads", "contact_id", rows.leads);
    await check("viewings", "contact_id", rows.viewings);
    await check("tasks", "contact_id", rows.tasks);
    await check("offers", "contact_id", rows.offers);
    await check("mandates", "owner_contact_id", rows.mandates);
    await check("deals", "buyer_contact_id", dealId);
    await check("deals", "seller_contact_id", dealId);
    await check("properties", "owner_contact_id", propertyId);
    await check("properties", "developer_contact_id", propertyId);
    await check("buyer_requirements", "contact_id", rows.buyer_requirements);
    await check("reservations", "contact_id", rows.reservations);
    await check("share_links", "contact_id", rows.share_links);

    expect(
      stillOnDuplicate,
      "every row that pointed at the duplicate must point at the primary — anything " +
        "left behind is stranded on an archived contact, silently, where no screen shows it",
    ).toEqual([]);

    // the merge is evented on the surviving contact
    const { data: merged } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", primaryId)
      .eq("event_type", "merged");
    expect(merged, "a merge is a state change, so it owes an event").toHaveLength(1);
  } finally {
    await removeFixture(svc);
  }
});

test("the saved searches of a merged buyer keep matching under the surviving contact", async ({
  page,
}) => {
  // The consequence, stated in the product's own terms rather than as a
  // foreign key: a buyer whose duplicate record held the brief must still be
  // proposed listings after the desk tidies up. This is the whole reason the
  // repoint above matters — a stranded requirement is not an orphaned row, it
  // is a buyer who stops being rung.
  const svc = serviceClient();
  await removeFixture(svc);
  const { orgId } = await fixtureProfile(svc);

  const { data: primary } = await svc
    .from("contacts")
    .insert({ org_id: orgId, first_name: PRIMARY, contact_types: ["buyer"] })
    .select("id")
    .single();
  const { data: duplicate } = await svc
    .from("contacts")
    .insert({
      org_id: orgId,
      first_name: DUPLICATE,
      contact_types: ["buyer"],
      phone_e164: "+35799000199",
    })
    .select("id")
    .single();
  const { error: propErr } = await svc.from("properties").insert({
    org_id: orgId,
    reference: REF,
    kind: "standalone",
    property_type: "apartment",
    transaction_type: "sale",
    status: "available",
    visibility: "private",
    asking_price: 200000,
    bedrooms: 2,
    title: { en: "E2E merge fixture flat" },
  });
  expect(propErr, "seeding the property").toBeNull();
  const { error: reqErr } = await svc.from("buyer_requirements").insert({
    org_id: orgId,
    contact_id: duplicate!.id,
    label: "E2E merged buyer brief",
    transaction_type: "sale",
    property_types: ["apartment"],
    district_ids: [],
    area_ids: [],
    features_required: [],
    title_deed_required: false,
    budget_max: 250000,
  });
  expect(reqErr, "seeding the requirement").toBeNull();

  try {
    await page.goto(`/contacts/${primary!.id}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^merge$/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/search name, phone, email/i).fill("99000199");
    await dialog.getByRole("button", { name: new RegExp(DUPLICATE, "i") }).click();
    await dialog.getByRole("button", { name: new RegExp(`merge ".*${DUPLICATE}.*" into`, "i") }).click();

    await expect
      .poll(
        async () => {
          const { data } = await svc
            .from("contacts")
            .select("merged_into_id")
            .eq("id", duplicate!.id)
            .single();
          return data?.merged_into_id;
        },
        { timeout: opTimeout(20_000) },
      )
      .toBe(primary!.id);

    await page.goto(`/contacts/${primary!.id}`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^preferences$/i }).click();
    await expect(
      page.getByText("E2E merged buyer brief"),
      "the brief survives the merge on the contact the desk kept",
    ).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(
      page.getByRole("link", { name: "E2E merge fixture flat" }),
      "and it is still matched against the books",
    ).toBeVisible({ timeout: opTimeout(15_000) });
  } finally {
    await removeFixture(svc);
  }
});
