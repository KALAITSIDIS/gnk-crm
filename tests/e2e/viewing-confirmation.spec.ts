import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { ADMIN_EMAIL, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * Generated viewing confirmation (IMPROVEMENTS B4, migration 0027).
 *
 * The render is a template and the action is plumbing; what neither can be
 * trusted to prove on its own is that the three artefacts agree — a file in the
 * private bucket, a `documents` row pointing at it, and a hash-chained event
 * recording its digest. This drives the real button and then checks the stored
 * bytes against the event.
 *
 * It also pins the rollback contract from the other direction: exactly ONE
 * document and ONE event per generation. `generateEvidenceReport`'s guardrail —
 * no stored document without its event — is worth nothing if a success path
 * quietly files two of either.
 */

const REF_PREFIX = "VCONF-FIXTURE-";
const CONTACT_TAG = "vconf-fixture";

async function seedViewing(svc: SupabaseClient) {
  const tag = Date.now().toString(36);
  const { data: admin } = await svc
    .from("profiles")
    .select("id, org_id")
    .eq("email", ADMIN_EMAIL)
    .single();

  const { data: property, error: pErr } = await svc
    .from("properties")
    .insert({
      org_id: admin!.org_id,
      reference: `${REF_PREFIX}${tag}`,
      property_type: "villa",
      asking_price: 250000,
    })
    .select("id")
    .single();
  expect(pErr, `seeding a property: ${pErr?.message}`).toBeNull();

  const { data: contact, error: cErr } = await svc
    .from("contacts")
    .insert({
      org_id: admin!.org_id,
      first_name: "Vconf",
      last_name: `Fixture-${tag}`,
      phone_e164: `+357970${tag.slice(-5)}`,
      notes: CONTACT_TAG,
    })
    .select("id")
    .single();
  expect(cErr, `seeding a contact: ${cErr?.message}`).toBeNull();

  const { data: viewing, error: vErr } = await svc
    .from("viewings")
    .insert({
      org_id: admin!.org_id,
      property_id: property!.id,
      contact_id: contact!.id,
      agent_id: admin!.id,
      scheduled_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  expect(vErr, `seeding a viewing: ${vErr?.message}`).toBeNull();

  return viewing!.id as string;
}

test.describe("Viewing confirmation PDF", () => {
  test.skip(!isLocal(), "seeding and Storage reads need the local service key");

  test.afterAll(async () => {
    const svc = serviceClient();
    const { data: props } = await svc.from("properties").select("id").like("reference", `${REF_PREFIX}%`);
    for (const p of props ?? []) {
      const { data: vs } = await svc.from("viewings").select("id").eq("property_id", p.id);
      for (const v of vs ?? []) {
        // Paths come from the rows — reconstructing a Storage key is a silent
        // no-op when it is wrong (learned the hard way on slip-pdf-hash).
        const { data: docs } = await svc
          .from("documents")
          .select("id, storage_path")
          .eq("entity_type", "viewing")
          .eq("entity_id", v.id);
        const keys = (docs ?? []).map((d) => d.storage_path).filter(Boolean);
        if (keys.length) await svc.storage.from("documents").remove(keys);
        await svc.from("documents").delete().eq("entity_type", "viewing").eq("entity_id", v.id);
        await svc.from("viewings").delete().eq("id", v.id);
      }
      await svc.from("properties").delete().eq("id", p.id);
    }
    await svc.from("contacts").delete().eq("notes", CONTACT_TAG);
  });

  test("generates a real PDF whose digest matches the chained event", async ({ page }) => {
    const svc = serviceClient();
    const viewingId = await seedViewing(svc);

    await page.goto(`/viewings/${viewingId}`);
    await expect(page.getByRole("heading", { name: /^Viewing$/ })).toBeVisible();

    // Before: no confirmation, so no Download offered.
    await expect(page.getByRole("button", { name: /download \(pdf\)/i })).toHaveCount(0);

    await page.getByRole("button", { name: /generate confirmation/i }).click();

    await expect
      .poll(
        async () => {
          const { count } = await svc
            .from("documents")
            .select("id", { count: "exact", head: true })
            .eq("entity_id", viewingId)
            .eq("doc_type", "viewing_confirmation");
          return count ?? 0;
        },
        { timeout: opTimeout(30_000), message: "no confirmation document was filed" },
      )
      .toBe(1);

    const { data: doc } = await svc
      .from("documents")
      .select("id, storage_path, title, visibility, entity_type")
      .eq("entity_id", viewingId)
      .eq("doc_type", "viewing_confirmation")
      .single();
    expect(doc!.entity_type).toBe("viewing");
    expect(doc!.visibility).toBe("internal");
    expect(doc!.title).toContain(REF_PREFIX);

    // The stored bytes really are a PDF, and really are the ones hashed.
    const { data: file, error: dlErr } = await svc.storage
      .from("documents")
      .download(doc!.storage_path);
    expect(dlErr, `downloading the confirmation: ${dlErr?.message}`).toBeNull();
    const bytes = Buffer.from(await file!.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("latin1"), "stored file is not a PDF").toBe("%PDF");
    expect(bytes.length).toBeGreaterThan(1000);

    const { data: events } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", viewingId)
      .eq("event_type", "viewing_confirmation_generated");
    expect(events?.length, "exactly one generation event").toBe(1);
    const payload = events![0].payload as { document_id?: string; pdf_sha256?: string };
    expect(payload.document_id).toBe(doc!.id);
    expect(payload.pdf_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    // The chain must still verify — this writes to the append-only log.
    const { data: chainOk } = await svc.rpc("verify_events_chain", {
      p_org: "00000000-0000-0000-0000-000000000001",
    });
    expect(chainOk).toBe(true);

    // After: the Download button is offered without needing a regenerate.
    await page.reload();
    await expect(page.getByRole("button", { name: /download \(pdf\)/i })).toBeVisible();
  });
});
