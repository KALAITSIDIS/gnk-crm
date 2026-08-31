import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * The OTHER leg of DB-01 (2026-09-01 review): a reservation converted to a
 * sale while the listing still reads on-market must raise the same
 * listing_status_check prompt a won deal does — and must NOT flip the status
 * itself (the auto-coupling was DECLINED 2026-08-26). markDealWon's leg is
 * pinned by deal-close.spec; until this spec, the reservation leg had no
 * coverage because it had no implementation.
 */

const REF = "E2ERESCONV1";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: props } = await svc.from("properties").select("id").eq("reference", REF);
  for (const p of props ?? []) {
    await svc.from("tasks").delete().eq("property_id", p.id);
    await svc.from("reservations").delete().eq("property_id", p.id);
    await svc.from("properties").delete().eq("id", p.id);
  }
  await svc.from("contacts").delete().eq("first_name", "E2EResConvBuyer");
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("converting a reservation prompts the listing flip, never performs it", async ({
  page,
}) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { id: profileId, orgId } = await fixtureProfile(svc);

  const { data: prop } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference: REF,
      property_type: "apartment",
      status: "reserved",
      asking_price: 250000,
    })
    .select("id")
    .single();
  const { data: buyer } = await svc
    .from("contacts")
    .insert({ org_id: orgId, first_name: "E2EResConvBuyer" })
    .select("id")
    .single();
  const { error: resErr } = await svc.from("reservations").insert({
    org_id: orgId,
    property_id: prop!.id,
    contact_id: buyer!.id,
    status: "held",
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  expect(resErr).toBeNull();

  try {
    await page.goto(`/properties/${prop!.id}`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^reservation$/i }).click();
    await page.getByRole("button", { name: /converted to sale/i }).click();

    // the transition lands: the reservation reads converted
    await expect
      .poll(
        async () => {
          const { data } = await svc
            .from("reservations")
            .select("status")
            .eq("property_id", prop!.id)
            .single();
          return data?.status;
        },
        { timeout: opTimeout(15_000) },
      )
      .toBe("converted");

    // the status is the desk's call — still reserved, never auto-flipped
    const { data: still } = await svc
      .from("properties")
      .select("status")
      .eq("id", prop!.id)
      .single();
    expect(still!.status, "the convert must ASK, not flip").toBe("reserved");

    // one open prompt, linked to the reservation, assigned to the closer
    // (no linked deal in this fixture — the deal.agent_id path is pinned by
    // deal-close.spec)
    const { data: prompts } = await svc
      .from("tasks")
      .select("id, assignee_id, is_done, reservation_id")
      .eq("property_id", prop!.id)
      .eq("kind", "listing_status_check");
    expect(prompts, "one open prompt task").toHaveLength(1);
    expect(prompts![0].is_done).toBe(false);
    expect(prompts![0].reservation_id, "linked to the reservation").not.toBeNull();
    expect(prompts![0].assignee_id, "no linked deal → assigned to the closer").toBe(profileId);

    // and the raise is evented
    const { data: events } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", prop!.id)
      .eq("event_type", "followup_task_created");
    const mine = (events ?? []).filter(
      (e) => (e.payload as { kind?: string }).kind === "listing_status_check",
    );
    expect(mine, "the raise writes its event").toHaveLength(1);
  } finally {
    await removeFixture(svc);
  }
});
