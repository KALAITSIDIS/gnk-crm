import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * The three money figures on a reservation's payment schedule, read off a real
 * page against a real database. `reservation-schedule` had no e2e coverage at
 * all; a schedule is the money side of a hold, so what it prints is worth
 * pinning.
 *
 * IT ALSO SETTLES A CLAIM. A 2026-09-07 review reported these totals as a P1:
 * `pct`, `amount` and `paid_amount` are numeric(14,2), and this project's
 * working lore held that PostgREST sends numeric as a STRING — which would
 * make the card's `reduce((s, l) => s + l.amount, 0)` concatenate, collapse to
 * NaN, and print "—" for Scheduled, Received and Outstanding.
 *
 * The lore is wrong, at least for numeric. Measured against both the local
 * stack and hosted on 2026-09-07, PostgREST serialises numeric as an UNQUOTED
 * JSON number (`{"amount":70000.00}`, `{"asking_price":800000.00}`) and
 * supabase-js hands it over as a JS number. This test was written to reproduce
 * the reported bug and could not: with the suggested fixes reverted — the
 * original code, exactly — it still passes, and the totals are right.
 *
 * So it stays as coverage rather than as a regression test, and it is the
 * reason the "fix" was not shipped. A test that cannot fail for the reason it
 * was written is worth knowing about BEFORE the fix goes out, not after.
 */

const REF = "E2EPAYSCHED1";
const BUYER = "E2EPaySchedBuyer";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: props } = await svc.from("properties").select("id").eq("reference", REF);
  for (const p of props ?? []) {
    const { data: res } = await svc.from("reservations").select("id").eq("property_id", p.id);
    for (const r of res ?? []) {
      await svc.from("reservation_installments").delete().eq("reservation_id", r.id);
    }
    await svc.from("reservations").delete().eq("property_id", p.id);
    await svc.from("tasks").delete().eq("property_id", p.id);
    await svc.from("properties").delete().eq("id", p.id);
  }
  await svc.from("contacts").delete().eq("first_name", BUYER);
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("a payment schedule adds up on screen — three lines, three money totals", async ({
  page,
}) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { id: profileId, orgId } = await fixtureProfile(svc);

  const { data: prop, error: propErr } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference: REF,
      kind: "standalone",
      property_type: "apartment",
      transaction_type: "sale",
      status: "reserved",
      asking_price: 350000,
    })
    .select("id")
    .single();
  expect(propErr, "seeding the property").toBeNull();

  const { data: buyer, error: buyerErr } = await svc
    .from("contacts")
    .insert({ org_id: orgId, first_name: BUYER, contact_types: ["buyer"] })
    .select("id")
    .single();
  expect(buyerErr, "seeding the buyer").toBeNull();

  const { data: reservation, error: resErr } = await svc
    .from("reservations")
    .insert({
      org_id: orgId,
      property_id: prop!.id,
      contact_id: buyer!.id,
      status: "held",
      amount: 350000,
      expires_at: new Date(Date.UTC(2027, 0, 11)).toISOString(),
    })
    .select("id")
    .single();
  expect(resErr, "seeding the reservation").toBeNull();

  // Three lines, two of them unpaid: enough that a total has to actually add
  // rather than pass one value through.
  const { error: linesErr } = await svc.from("reservation_installments").insert([
    {
      org_id: orgId,
      reservation_id: reservation!.id,
      sort_order: 1,
      label: "Reservation deposit",
      pct: 20,
      amount: 70000,
      paid_amount: 70000,
      paid_at: new Date(Date.UTC(2026, 8, 1)).toISOString(),
      created_by: profileId,
    },
    {
      org_id: orgId,
      reservation_id: reservation!.id,
      sort_order: 2,
      label: "On contract signing",
      pct: 30,
      amount: 105000,
      created_by: profileId,
    },
    {
      org_id: orgId,
      reservation_id: reservation!.id,
      sort_order: 3,
      label: "On delivery",
      pct: 50,
      amount: 175000,
      created_by: profileId,
    },
  ]);
  expect(linesErr, "seeding the schedule").toBeNull();

  try {
    await page.goto(`/properties/${prop!.id}`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^reservation$/i }).click();

    const totals = page.locator("text=/Scheduled/").first();
    await expect(totals).toBeVisible({ timeout: opTimeout(15_000) });

    // The figures the desk reads. 70,000 + 105,000 + 175,000 = 350,000, of
    // which 70,000 is in and 280,000 is owed.
    const line = async (label: string) =>
      (await page.locator("span", { hasText: new RegExp(`^${label}\\s`) }).first().innerText())
        .replace(/\s+/g, " ")
        .trim();

    const scheduled = await line("Scheduled");
    const received = await line("Received");
    const owed = await line("Outstanding");

    for (const [name, text] of [
      ["Scheduled", scheduled],
      ["Received", received],
      ["Outstanding", owed],
    ] as const) {
      expect(
        text,
        `${name} must be a money figure — "—" is what formatMoney prints when the ` +
          `sum is not a finite number`,
      ).not.toMatch(/—/);
    }

    // and they are the right figures, not merely non-empty
    expect(scheduled.replace(/[^\d]/g, "")).toBe("350000");
    expect(received.replace(/[^\d]/g, "")).toBe("70000");
    expect(owed.replace(/[^\d]/g, "")).toBe("280000");
  } finally {
    await removeFixture(svc);
  }
});
