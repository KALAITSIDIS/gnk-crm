import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * Redacting an enquiry from the leads inbox takes the desk's notes with its
 * message (T-redact-lead-notes) — and a redaction interrupted between the two
 * is offered again as "Finish redaction" until it is done.
 *
 * Each lead hangs off a property with a unique reference: the property link
 * is the row's anchor, because the message — the other thing a row shows —
 * is exactly what the redaction replaces.
 */

const RUN = Date.now().toString(36).toUpperCase();
const MARKER = "[erased at the contact's request]";

async function seed(svc: SupabaseClient, orgId: string, ref: string, message: string, noteText: string) {
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
  const { data: lead, error: le } = await svc
    .from("leads")
    .insert({ org_id: orgId, source: "website", property_id: prop!.id, message })
    .select("id")
    .single();
  expect(le, "seeding the lead").toBeNull();
  const { data: noteId, error: ne } = await svc.rpc("log_conversation", {
    p_entity_type: "lead",
    p_entity_id: lead!.id,
    p_channel: "phone",
    p_note: noteText,
  });
  expect(ne, "seeding the note").toBeNull();
  return { propertyId: prop!.id as string, leadId: lead!.id as string, noteId: noteId as string };
}

async function cleanup(svc: SupabaseClient, rows: { propertyId: string; leadId: string }[]) {
  for (const r of rows) {
    await svc.from("interaction_notes").delete().eq("entity_id", r.leadId);
    await svc.from("events").delete().eq("entity_id", r.leadId);
    await svc.from("notification_jobs").delete().eq("lead_id", r.leadId);
    await svc.from("tasks").delete().eq("lead_id", r.leadId);
    await svc.from("leads").delete().eq("id", r.leadId);
    await svc.from("properties").delete().eq("id", r.propertyId);
  }
}

const rowOf = (page: Page, ref: string) => page.locator("li").filter({ has: page.getByRole("link", { name: ref }) });

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
  const fresh = await seed(svc, orgId, freshRef, `Website enquiry\nName: E2E Redact ${RUN}\nPhone: 99000111`, `Called her back ${RUN}`);
  const half = await seed(svc, orgId, halfRef, MARKER, `Left behind ${RUN}`);
  try {
    page.on("dialog", (d) => d.accept());
    await page.goto("/leads");

    // 1. a fresh redaction
    const freshRow = rowOf(page, freshRef);
    await expect(freshRow).toBeVisible({ timeout: opTimeout(15_000) });
    await freshRow.getByRole("button", { name: "Redact", exact: true }).click();
    await expect(page.getByText("Enquiry redacted").first()).toBeVisible({ timeout: opTimeout(10_000) });
    await expect(freshRow.getByRole("button", { name: /Redact|Finish redaction/ })).toHaveCount(0, {
      timeout: opTimeout(10_000),
    });
    const { data: n1 } = await svc.from("interaction_notes").select("body, redacted_at").eq("id", fresh.noteId).single();
    expect(n1).toMatchObject({ body: null });
    expect(n1!.redacted_at).not.toBeNull();
    const { data: l1 } = await svc.from("leads").select("message").eq("id", fresh.leadId).single();
    expect(l1!.message).toBe(MARKER);

    // 2. a redaction whose notes were left behind is offered again, and finished
    const halfRow = rowOf(page, halfRef);
    await expect(halfRow.getByRole("button", { name: "Finish redaction" })).toBeVisible();
    await halfRow.getByRole("button", { name: "Finish redaction" }).click();
    await expect(halfRow.getByRole("button", { name: /Redact|Finish redaction/ })).toHaveCount(0, {
      timeout: opTimeout(10_000),
    });
    const { data: n2 } = await svc.from("interaction_notes").select("body").eq("id", half.noteId).single();
    expect(n2!.body).toBeNull();
  } finally {
    await cleanup(svc, [fresh, half]);
  }
});
