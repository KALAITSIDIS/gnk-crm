import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * Reschedule + the calendar file, end to end (audit WF-1 + ICS-1).
 *
 * The pure halves are pinned elsewhere (viewing-ics.test.ts for the VCALENDAR
 * text, RLS test 51 for the no-show nudge). This spec proves the running
 * surfaces: the detail page serves a real .ics over the authed route, and the
 * Reschedule dialog actually moves the viewing and writes the `rescheduled`
 * event — the flow that used to require cancel + recreate.
 */

const REF = "E2ERSCH01";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: props } = await svc.from("properties").select("id").eq("reference", REF);
  for (const p of props ?? []) {
    await svc.from("tasks").delete().eq("property_id", p.id);
    await svc.from("viewings").delete().eq("property_id", p.id);
    await svc.from("properties").delete().eq("id", p.id);
  }
  await svc.from("contacts").delete().eq("first_name", "E2EReschedBuyer");
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("a scheduled viewing downloads as .ics and reschedules with history intact", async ({
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
      status: "available",
      address: "12 Reschedule Ave",
    })
    .select("id")
    .single();
  const { data: buyer } = await svc
    .from("contacts")
    .insert({ org_id: orgId, first_name: "E2EReschedBuyer" })
    .select("id")
    .single();
  // tomorrow 10:00 UTC — safely in the future in any timezone
  const originalAt = new Date(Date.now() + 24 * 3_600_000);
  originalAt.setUTCHours(10, 0, 0, 0);
  const { data: viewing } = await svc
    .from("viewings")
    .insert({
      org_id: orgId,
      property_id: prop!.id,
      contact_id: buyer!.id,
      agent_id: profileId,
      scheduled_at: originalAt.toISOString(),
      duration_min: 30,
    })
    .select("id")
    .single();

  try {
    await page.goto(`/viewings/${viewing!.id}`, { waitUntil: "networkidle" });

    // ---------- ICS-1: the calendar file is real ----------
    const icsLink = page.getByRole("link", { name: /add to calendar/i });
    await expect(icsLink).toBeVisible();
    const icsRes = await page.request.get(`/viewings/${viewing!.id}/ics`);
    expect(icsRes.status()).toBe(200);
    expect(icsRes.headers()["content-type"]).toContain("text/calendar");
    const ics = await icsRes.text();
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain(`UID:viewing-${viewing!.id}@gnk-crm`);
    expect(ics).toContain(`SUMMARY:Viewing: ${REF}`);

    // ---------- WF-1: reschedule to the day after, 12:00 ----------
    await page.getByRole("button", { name: /reschedule/i }).click();
    const dialog = page.getByRole("dialog");
    const newDay = new Date(originalAt.getTime() + 24 * 3_600_000);
    const dayKey = newDay.toISOString().slice(0, 10);
    await dialog.getByLabel(/new date/i).fill(`${dayKey}T12:00`);
    await dialog.getByRole("button", { name: /^reschedule$/i }).click();

    // the detail page re-renders with the new time
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: opTimeout(15_000) });

    const { data: moved } = await svc
      .from("viewings")
      .select("scheduled_at, status")
      .eq("id", viewing!.id)
      .single();
    expect(moved!.status, "still the SAME viewing — no cancel + recreate").toBe("scheduled");
    expect(new Date(moved!.scheduled_at).getTime()).not.toBe(originalAt.getTime());

    const { data: events } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", viewing!.id)
      .eq("event_type", "rescheduled");
    expect(events, "the move is evented with from/to").toHaveLength(1);
    // compare as instants — PostgREST and toISOString() format timestamptz
    // differently (+00:00 vs .000Z) while naming the same moment
    const payload = events![0].payload as { from?: string; to?: string };
    expect(new Date(payload.from!).getTime()).toBe(originalAt.getTime());
    expect(new Date(payload.to!).getTime()).toBe(new Date(moved!.scheduled_at).getTime());
  } finally {
    await removeFixture(svc);
  }
});
