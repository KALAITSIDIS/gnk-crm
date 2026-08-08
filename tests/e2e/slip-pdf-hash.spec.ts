import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { ADMIN_EMAIL } from "./helpers";

/**
 * The slip PDF's recorded hash must describe the bytes actually in Storage (0026).
 *
 * `viewing_slips.signature_sha256` covered the signature PNG, so a substituted
 * IMAGE was detectable, while the slip PDF had no hash in the row or the event —
 * found by the 2026-08-05 Storage restore drill (BACKUP_RESTORE §4c). The slip is
 * the strongest commission-dispute artefact this system produces, so "we can
 * prove this file is the one that was signed" is the whole point of it.
 *
 * That claim cannot be tested at the unit level. `sha256Hex(pdf)` returning the
 * hash of its argument is trivially true and proves nothing about whether the
 * value stored alongside the file describes the file. So this signs a real slip
 * through the real canvas, then re-downloads the PDF and re-hashes it.
 *
 * Fixtures are seeded through the local service key rather than the UI — the
 * same convention as csp.spec.ts and nudges.spec.ts — and swept by marker so a
 * crashed run self-heals.
 */

const baseUrl = () => process.env.E2E_BASE_URL ?? "http://localhost:3000";
const isLocal = () => /localhost|127\.0\.0\.1/.test(baseUrl());

/** Local-stack demo key. Not a secret; only ever reaches 127.0.0.1. */
const LOCAL_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const SLIP_FIXTURE_REF = "SLIPHASH-FIXTURE-";
const SLIP_FIXTURE_TAG = "sliphash-fixture";

function serviceClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321", LOCAL_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function seedViewing(svc: SupabaseClient) {
  const tag = Date.now().toString(36);

  const { data: admin, error: adminErr } = await svc
    .from("profiles")
    .select("id, org_id")
    .eq("email", ADMIN_EMAIL)
    .single();
  expect(adminErr, `finding the admin profile: ${adminErr?.message}`).toBeNull();

  const { data: property, error: pErr } = await svc
    .from("properties")
    .insert({
      org_id: admin!.org_id,
      reference: `${SLIP_FIXTURE_REF}${tag}`,
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
      first_name: "Sliphash",
      last_name: `Fixture-${tag}`,
      phone_e164: `+357980${tag.slice(-5)}`,
      notes: SLIP_FIXTURE_TAG,
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

  return { viewingId: viewing!.id as string, propertyId: property!.id as string, contactId: contact!.id as string };
}

test.describe("Signed slip PDF hash", () => {
  test.skip(!isLocal(), "seeding and Storage reads need the local service key");

  test.afterAll(async () => {
    // Marker sweep, not id-based: a crashed run is cleaned by the next one.
    const svc = serviceClient();
    const { data: props } = await svc
      .from("properties")
      .select("id")
      .like("reference", `${SLIP_FIXTURE_REF}%`);
    for (const p of props ?? []) {
      const { data: vs } = await svc.from("viewings").select("id").eq("property_id", p.id);
      for (const v of vs ?? []) {
        // Storage keys are `<org_id>/<viewing_id>.<ext>`, so take them from the
        // row rather than reconstructing — a wrong key deletes nothing and leaks
        // objects into the signatures bucket silently.
        const { data: s } = await svc
          .from("viewing_slips")
          .select("pdf_path, signature_path")
          .eq("viewing_id", v.id)
          .maybeSingle();
        const keys = [s?.pdf_path, s?.signature_path].filter((k): k is string => Boolean(k));
        if (keys.length) await svc.storage.from("signatures").remove(keys);
        await svc.from("viewing_slips").delete().eq("viewing_id", v.id);
        await svc.from("viewings").delete().eq("id", v.id);
      }
      await svc.from("properties").delete().eq("id", p.id);
    }
    await svc.from("contacts").delete().eq("notes", SLIP_FIXTURE_TAG);
  });

  test("the recorded pdf_sha256 matches the PDF actually stored", async ({ page }) => {
    const svc = serviceClient();
    const { viewingId } = await seedViewing(svc);

    await page.goto(`/viewings/${viewingId}/sign`);

    // Draw on the real signature pad. It binds pointer events and exports via
    // toDataURL on pointer-up, so nothing short of an actual stroke produces a
    // signature — setting the hidden input would be React-controlled anyway.
    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 3, box.y + 20, { steps: 8 });
    await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 8 });
    await page.mouse.up();

    await page.getByRole("button", { name: /sign|confirm|save/i }).first().click();

    // Wait on the ROW, not on wording. `revalidatePath` re-renders the sign page
    // into its server-rendered "Already signed" branch, which races the client's
    // "Slip signed" panel — either is a success, and neither is what this test is
    // about.
    await expect
      .poll(
        async () => {
          const { count } = await svc
            .from("viewing_slips")
            .select("viewing_id", { count: "exact", head: true })
            .eq("viewing_id", viewingId);
          return count ?? 0;
        },
        { timeout: 30_000, message: "the slip row never appeared — signing failed" },
      )
      .toBe(1);

    // What the app recorded.
    const { data: slip, error: slipErr } = await svc
      .from("viewing_slips")
      .select("pdf_path, pdf_sha256, signature_sha256")
      .eq("viewing_id", viewingId)
      .single();
    expect(slipErr, `reading the slip row: ${slipErr?.message}`).toBeNull();
    expect(slip!.pdf_path, "a PDF should have been stored").toBeTruthy();
    expect(slip!.pdf_sha256, "0026: the PDF hash must be recorded").toMatch(/^[0-9a-f]{64}$/);

    // The PNG hash must NOT have been reused for the PDF — that would look
    // correct in the row and prove nothing about the file.
    expect(slip!.pdf_sha256).not.toBe(slip!.signature_sha256);

    // The claim itself: re-download and re-hash.
    const { data: file, error: dlErr } = await svc.storage
      .from("signatures")
      .download(slip!.pdf_path!);
    expect(dlErr, `downloading the stored PDF: ${dlErr?.message}`).toBeNull();
    const bytes = Buffer.from(await file!.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("latin1"), "stored file is not a PDF").toBe("%PDF");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(slip!.pdf_sha256);

    // And the hash-chained copy, which is the half that cannot be edited later.
    const { data: events } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", viewingId)
      .eq("event_type", "viewing_slip_signed");
    expect(events?.length, "one viewing_slip_signed event").toBe(1);
    expect((events![0].payload as { pdf_sha256?: string }).pdf_sha256).toBe(slip!.pdf_sha256);
  });
});
