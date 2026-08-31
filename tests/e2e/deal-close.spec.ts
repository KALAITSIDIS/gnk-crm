import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * The guarded Won flow, end to end (T3.4 + audit WF-2/DB-03 + DB-01).
 *
 * The arithmetic is pinned elsewhere — RLS test 38 proves the reports read
 * coalesce(final_value, expected_value), unit tests pin the schema. This spec
 * covers what only the running app can prove, none of which had ANY e2e
 * coverage before: the Won dialog prefills the accepted offer's amount, the
 * confirmed figure lands on the deal AND in the won event, and a won deal
 * whose listing still reads on-market raises the listing_status_check prompt
 * task — a task that ASKS, never a write that flips the status.
 */

const REF = "E2EWON01";
const DEAL_TITLE = "E2E won-flow fixture deal";
// a REAL second profile as the deal's agent, so "assigned to the deal's
// agent" is distinguishable from "assigned to whoever clicked" (2026-09-01
// review: with agent_id = the closing admin, the assertion was degenerate —
// a regression to `profile.id` would still pass)
const AGENT_EMAIL = "deal-close-agent@gnk.local";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: deals } = await svc.from("deals").select("id").eq("title", DEAL_TITLE);
  for (const d of deals ?? []) {
    await svc.from("tasks").delete().eq("deal_id", d.id);
    await svc.from("offers").delete().eq("deal_id", d.id);
    await svc.from("deals").delete().eq("id", d.id);
  }
  const { data: props } = await svc.from("properties").select("id").eq("reference", REF);
  for (const p of props ?? []) {
    await svc.from("tasks").delete().eq("property_id", p.id);
    await svc.from("properties").delete().eq("id", p.id);
  }
  await svc.from("contacts").delete().eq("first_name", "E2EWonBuyer");
  const { data: agentProfile } = await svc
    .from("profiles")
    .select("id")
    .eq("email", AGENT_EMAIL)
    .maybeSingle();
  if (agentProfile) await svc.auth.admin.deleteUser(agentProfile.id);
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("Mark won confirms the accepted price, stamps it, and prompts the listing flip", async ({
  page,
}) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { orgId } = await fixtureProfile(svc);

  const { data: agentUser, error: agentErr } = await svc.auth.admin.createUser({
    email: AGENT_EMAIL,
    password: "deal-close-agent-pw-1",
    email_confirm: true,
  });
  expect(agentErr).toBeNull();
  const agentId = agentUser!.user!.id;
  const { error: agentProfErr } = await svc.from("profiles").insert({
    id: agentId,
    org_id: orgId,
    role: "agent",
    full_name: "Deal Close Agent",
    email: AGENT_EMAIL,
  });
  expect(agentProfErr).toBeNull();

  const { data: stage } = await svc
    .from("deal_stages")
    .select("id")
    .eq("org_id", orgId)
    .eq("deal_type", "sale")
    .order("sort_order")
    .limit(1)
    .single();

  const { data: prop } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference: REF,
      property_type: "apartment",
      status: "available",
      asking_price: 300000,
    })
    .select("id")
    .single();
  const { data: buyer } = await svc
    .from("contacts")
    .insert({ org_id: orgId, first_name: "E2EWonBuyer" })
    .select("id")
    .single();
  const { data: deal } = await svc
    .from("deals")
    .insert({
      org_id: orgId,
      deal_type: "sale",
      stage_id: stage!.id,
      title: DEAL_TITLE,
      agent_id: agentId,
      property_id: prop!.id,
      buyer_contact_id: buyer!.id,
      expected_value: 999999, // deliberately stale — the confirmed price must win
    })
    .select("id")
    .single();
  const { error: offerErr } = await svc.from("offers").insert({
    org_id: orgId,
    deal_id: deal!.id,
    contact_id: buyer!.id,
    amount: 250000,
    status: "accepted",
    decided_at: new Date().toISOString(),
  });
  expect(offerErr).toBeNull();

  try {
    await page.goto(`/deals/${deal!.id}`, { waitUntil: "networkidle" });

    await page.getByRole("button", { name: /mark won/i }).click();
    const dialog = page.getByRole("dialog");
    // WF-2: prefilled from the accepted offer, editable
    await expect(dialog.getByLabel(/final value/i)).toHaveValue("250000");
    await dialog.getByRole("button", { name: /mark won/i }).click();

    // the dialog closes ONLY on success — wait for that before touching the
    // database, or the assert races the server action (it did, first run:
    // the dialog's own "Final value" label satisfied a bare text assert)
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: opTimeout(20_000) });
    // the closed banner replaces the action bar and carries the price
    await expect(page.getByText(/final value/i)).toBeVisible({ timeout: opTimeout(15_000) });

    // ---------- the database agrees ----------
    const { data: closed } = await svc
      .from("deals")
      .select("status, final_value")
      .eq("id", deal!.id)
      .single();
    expect(closed!.status).toBe("won");
    expect(Number(closed!.final_value)).toBe(250000);

    const { data: wonEvents } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", deal!.id)
      .eq("event_type", "won");
    expect(wonEvents).toHaveLength(1);
    expect(Number((wonEvents![0].payload as { final_value?: number }).final_value)).toBe(250000);

    // DB-01: the listing still reads available → the prompt task, never a flip
    const { data: still } = await svc
      .from("properties")
      .select("status")
      .eq("id", prop!.id)
      .single();
    expect(still!.status, "the sweep must ASK — the status is the desk's call").toBe("available");
    const { data: prompts } = await svc
      .from("tasks")
      .select("id, assignee_id, is_done")
      .eq("property_id", prop!.id)
      .eq("kind", "listing_status_check");
    expect(prompts, "one open prompt task").toHaveLength(1);
    expect(prompts![0].is_done).toBe(false);
    expect(
      prompts![0].assignee_id,
      "assigned to the DEAL'S AGENT, not the admin who clicked",
    ).toBe(agentId);

    // ---------- obeying the prompt completes it (2026-09-01 review) ----------
    // The task asks for a status update; making that exact update must close
    // it — an open task that survives being obeyed teaches the desk to
    // ignore tasks.
    await page.goto(`/properties/${prop!.id}`, { waitUntil: "networkidle" });
    // the details form lives behind its tab — Overview is the landing tab
    await page.getByRole("tab", { name: /^details$/i }).click();
    await page.getByLabel(/^status$/i).click();
    await page.getByRole("option", { name: /^sold$/i }).click();
    await page
      .locator("form")
      .filter({ has: page.getByLabel(/^status$/i) })
      .getByRole("button", { name: /^save$/i })
      .click();
    await expect(page.getByText(/^saved$/i).first()).toBeVisible({
      timeout: opTimeout(15_000),
    });

    await expect
      .poll(
        async () => {
          const { data: after } = await svc
            .from("tasks")
            .select("is_done")
            .eq("property_id", prop!.id)
            .eq("kind", "listing_status_check");
          return after?.every((t) => t.is_done) && after.length === 1;
        },
        { timeout: opTimeout(15_000) },
      )
      .toBe(true);

    const { data: supersededEvents } = await svc
      .from("events")
      .select("payload")
      .eq("event_type", "superseded")
      .eq("entity_id", prompts![0].id);
    expect(supersededEvents, "the completion is evented with its reason").toHaveLength(1);
    expect(
      (supersededEvents![0].payload as { reason?: string }).reason,
      "the reason states what the predicate proved",
    ).toContain("sold");
  } finally {
    await removeFixture(svc);
  }
});
