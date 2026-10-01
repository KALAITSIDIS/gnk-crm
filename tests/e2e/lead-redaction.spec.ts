import { test, expect, type Locator, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * Redacting an enquiry from the leads inbox takes the desk's notes with its
 * message (T-redact-lead-notes) — and a redaction interrupted between the two
 * is offered again as "Finish redaction" until it is done.
 *
 * Each lead hangs off a property with a unique reference: the property link
 * is the row's anchor, because the message — the other thing a row shows —
 * is exactly what the redaction replaces. On a phone the row's secondary
 * actions sit behind "More…" (audit CRM-06), so the spec opens it when shown.
 *
 * Cleanup removes the rows it seeded and NEVER the events: they are
 * hash-chained in the shared fixture organisation, and deleting from the
 * middle of a chain breaks every later verification.
 */

const RUN = Date.now().toString(36).toUpperCase();
const MARKER = "[erased at the contact's request]";

interface Seeded {
  propertyId: string;
  leadId?: string;
  noteId?: string;
}

async function seed(svc: SupabaseClient, orgId: string, ref: string, message: string, noteText: string, into: Seeded[]) {
  const { data: prop, error: pe } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference: ref,
      kind: "standalone",
      property_type: "apartment",
      transaction_type: "sale",
      status: "available",
      asking_price: 250000,
    })
    .select("id")
    .single();
  expect(pe, "seeding the property").toBeNull();
  const row: Seeded = { propertyId: prop!.id as string };
  into.push(row); // registered before anything else can fail, so cleanup sees it
  const { data: lead, error: le } = await svc
    .from("leads")
    .insert({ org_id: orgId, source: "website", property_id: row.propertyId, message })
    .select("id")
    .single();
  expect(le, "seeding the lead").toBeNull();
  row.leadId = lead!.id as string;
  const { data: noteId, error: ne } = await svc.rpc("log_conversation", {
    p_entity_type: "lead",
    p_entity_id: row.leadId,
    p_channel: "phone",
    p_note: noteText,
  });
  expect(ne, "seeding the note").toBeNull();
  row.noteId = noteId as string;
  return row as Required<Seeded>;
}

async function cleanup(svc: SupabaseClient, rows: Seeded[]) {
  for (const r of rows) {
    if (r.leadId) {
      await svc.from("interaction_notes").delete().eq("entity_id", r.leadId);
      await svc.from("notification_jobs").delete().eq("lead_id", r.leadId);
      await svc.from("tasks").delete().eq("lead_id", r.leadId);
      await svc.from("leads").delete().eq("id", r.leadId);
    }
    await svc.from("properties").delete().eq("id", r.propertyId);
  }
}

const rowOf = (page: Page, ref: string) => page.locator("li").filter({ has: page.getByRole("link", { name: ref }) });

/** The row's action button — behind "More…" on a phone. */
async function action(row: Locator, name: string | RegExp): Promise<Locator> {
  const more = row.getByRole("button", { name: "More…" });
  if (await more.isVisible()) await more.click();
  return row.getByRole("button", { name, exact: typeof name === "string" });
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("Redact takes the enquiry's notes with its message; an interrupted one is finished from the same row", async ({
  page,
}) => {
  const svc = serviceClient();
  const { orgId } = await fixtureProfile(svc);
  const freshRef = `E2ERED${RUN}A`;
  const halfRef = `E2ERED${RUN}B`;
  const seeded: Seeded[] = [];
  try {
    const fresh = await seed(svc, orgId, freshRef, `Website enquiry\nName: E2E Redact ${RUN}\nPhone: 99000111`, `Called her back ${RUN}`, seeded);
    const half = await seed(svc, orgId, halfRef, MARKER, `Left behind ${RUN}`, seeded);

    page.on("dialog", (d) => d.accept());
    await page.goto("/leads");

    // 1. a fresh redaction
    const freshRow = rowOf(page, freshRef);
    await expect(freshRow).toBeVisible({ timeout: opTimeout(15_000) });
    await (await action(freshRow, "Redact")).click();
    await expect(page.getByText("Enquiry redacted").first()).toBeVisible({ timeout: opTimeout(10_000) });
    await expect(freshRow.getByRole("button", { name: /^(Redact|Finish redaction)$/ })).toHaveCount(0, {
      timeout: opTimeout(10_000),
    });
    const { data: n1 } = await svc.from("interaction_notes").select("body, redacted_at").eq("id", fresh.noteId).single();
    expect(n1).toMatchObject({ body: null });
    expect(n1!.redacted_at).not.toBeNull();
    const { data: l1 } = await svc.from("leads").select("message").eq("id", fresh.leadId).single();
    expect(l1!.message).toBe(MARKER);

    // 2. a redaction whose notes were left behind is offered again, and finished
    const halfRow = rowOf(page, halfRef);
    const finish = await action(halfRow, "Finish redaction");
    await expect(finish).toBeVisible();
    await finish.click();
    await expect(halfRow.getByRole("button", { name: /^(Redact|Finish redaction)$/ })).toHaveCount(0, {
      timeout: opTimeout(10_000),
    });
    const { data: n2 } = await svc.from("interaction_notes").select("body").eq("id", half.noteId).single();
    expect(n2!.body).toBeNull();
  } finally {
    await cleanup(svc, seeded);
  }
});
