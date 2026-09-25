import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * What the Won / Lost dialogs tell the user, for every answer `close_deal`
 * (0117) can give (T-atomic-deal-close). A close revalidates the deal page,
 * and the page renders these dialogs only while the deal is OPEN — so the
 * dialog is unmounted by the very refresh that carries the answer. Before
 * 0117 the dialogs reported through an effect that therefore never ran: the
 * success toast never showed. Every message below is asserted as it reaches
 * the layout's toaster, which survives the unmount.
 *
 * A colleague's close that committed first is simulated with a service-role
 * write (the maintenance path the 0117 guard deliberately does not bind), made
 * AFTER this page was drawn with the deal open. A follow-up failure after the
 * commit is a real database refusal: a BEFORE INSERT trigger on `events`
 * scoped to this spec's property, removed in `finally`.
 */

const TITLE = "E2E close-outcomes fixture deal";
const REF = "E2ECLOSE01";
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: deals } = await svc.from("deals").select("id").eq("title", TITLE);
  for (const d of deals ?? []) {
    await svc.from("tasks").delete().eq("deal_id", d.id);
    await svc.from("offers").delete().eq("deal_id", d.id);
    await svc.from("deals").delete().eq("id", d.id);
  }
  const { data: props } = await svc.from("properties").select("id").eq("reference", REF);
  for (const p of props ?? []) {
    await svc.from("tasks").delete().eq("property_id", p.id);
    await svc.from("reservations").delete().eq("property_id", p.id);
    await svc.from("properties").delete().eq("id", p.id);
  }
}

async function seedDeal(svc: SupabaseClient, opts: { withProperty?: boolean } = {}) {
  const { id: adminId, orgId } = await fixtureProfile(svc);
  const { data: stage } = await svc
    .from("deal_stages")
    .select("id")
    .eq("org_id", orgId)
    .eq("deal_type", "sale")
    .order("sort_order")
    .limit(1)
    .single();
  let propertyId: string | null = null;
  if (opts.withProperty) {
    const { data: prop, error } = await svc
      .from("properties")
      .insert({ org_id: orgId, reference: REF, property_type: "apartment", status: "available", asking_price: 300000 })
      .select("id")
      .single();
    expect(error, "seeding the property").toBeNull();
    propertyId = prop!.id;
  }
  const { data: deal, error: dealErr } = await svc
    .from("deals")
    .insert({
      org_id: orgId,
      deal_type: "sale",
      stage_id: stage!.id,
      title: TITLE,
      agent_id: adminId,
      created_by: adminId,
      property_id: propertyId,
      expected_value: 300000,
    })
    .select("id")
    .single();
  expect(dealErr, "seeding the deal").toBeNull();
  const { error: offerErr } = await svc.from("offers").insert({
    org_id: orgId,
    deal_id: deal!.id,
    amount: 300000,
    status: "accepted",
    decided_at: new Date().toISOString(),
  });
  expect(offerErr, "seeding the accepted offer").toBeNull();
  return { dealId: deal!.id as string, propertyId };
}

const toast = (page: Page, text: RegExp) => page.locator("[data-sonner-toast]").filter({ hasText: text });

async function markWon(page: Page) {
  await page.getByRole("button", { name: /mark won/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(/final value/i)).toHaveValue("300000");
  await dialog.getByRole("button", { name: /mark won/i }).click();
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("a close is announced — the toast shows although the refresh unmounts the dialog", async ({ page }) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { dealId } = await seedDeal(svc);
  try {
    await page.goto(`/deals/${dealId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /mark lost/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#lost_reason").fill("E2E buyer withdrew");
    await dialog.getByRole("button", { name: /^mark lost$/i }).click();

    await expect(toast(page, /^Deal marked lost$/)).toBeVisible({ timeout: opTimeout(20_000) });
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText(/E2E buyer withdrew/)).toBeVisible({ timeout: opTimeout(15_000) });

    const { data: row } = await svc.from("deals").select("status").eq("id", dealId).single();
    expect(row!.status).toBe("lost");
    const { data: lost } = await svc.from("events").select("id").eq("entity_id", dealId).eq("event_type", "lost");
    expect(lost).toHaveLength(1);
  } finally {
    await removeFixture(svc);
  }
});

test("a colleague's Lost that committed first: Won is refused, said, and the page shows what stands", async ({
  page,
}) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { dealId } = await seedDeal(svc);
  try {
    await page.goto(`/deals/${dealId}`, { waitUntil: "networkidle" });
    // …and after this page was drawn with the deal open, it is closed elsewhere
    const now = new Date().toISOString();
    const { error } = await svc
      .from("deals")
      .update({ status: "lost", lost_at: now, lost_reason: "E2E closed by a colleague" })
      .eq("id", dealId);
    expect(error).toBeNull();

    await markWon(page);
    const refusal = toast(page, /^This deal was already marked lost — it was not marked won\.$/);
    await expect(refusal).toBeVisible({ timeout: opTimeout(20_000) });
    // it arrived with a refresh that removed the dialog: it waits to be dismissed
    await expect(refusal.getByRole("button", { name: /close/i })).toBeVisible();
    // the refusal refreshed the page: it now shows the outcome that stands
    await expect(page.getByText(/E2E closed by a colleague/)).toBeVisible({ timeout: opTimeout(15_000) });

    const { data: row } = await svc.from("deals").select("status, won_at, final_value").eq("id", dealId).single();
    expect(row).toMatchObject({ status: "lost", won_at: null, final_value: null });
    const { data: won } = await svc.from("events").select("id").eq("entity_id", dealId).in("event_type", ["won", "won_override"]);
    expect(won, "the refused Won wrote nothing").toHaveLength(0);
  } finally {
    await removeFixture(svc);
  }
});

test("a Won that already landed is not announced as a fresh success", async ({ page }) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { dealId } = await seedDeal(svc);
  try {
    await page.goto(`/deals/${dealId}`, { waitUntil: "networkidle" });
    const now = new Date().toISOString();
    await svc.from("deals").update({ status: "won", won_at: now, final_value: 300000 }).eq("id", dealId);

    await markWon(page);
    const repeat = toast(page, /^This deal was already marked won — nothing was changed\./);
    await expect(repeat).toBeVisible({ timeout: opTimeout(20_000) });
    await expect(repeat.getByRole("button", { name: /close/i })).toBeVisible();
    await expect(toast(page, /^Deal marked won$/)).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeHidden();
    const { data: won } = await svc.from("events").select("id").eq("entity_id", dealId).eq("event_type", "won");
    expect(won, "a repeat writes no event").toHaveLength(0);
  } finally {
    await removeFixture(svc);
  }
});

test("a follow-up that fails AFTER the close commits: the deal is won, and the caveat stays until dismissed", async ({
  page,
}) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { dealId, propertyId } = await seedDeal(svc, { withProperty: true });
  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  const fn = `zz_e2e_close_fail_${Date.now().toString(36)}`;
  try {
    // refuse ONE event — this property's followup_task_created — in the database
    expect(propertyId).toMatch(/^[0-9a-f-]{36}$/);
    await pg.query(
      `create function public.${fn}() returns trigger language plpgsql as $f$
       begin
         if new.entity_id = '${propertyId}'::uuid and new.event_type = 'followup_task_created' then
           raise exception 'injected failure';
         end if;
         return new;
       end $f$`,
    );
    await pg.query(`revoke all on function public.${fn}() from public, anon, authenticated, service_role`);
    await pg.query(`create trigger ${fn} before insert on public.events for each row execute function public.${fn}()`);

    await page.goto(`/deals/${dealId}`, { waitUntil: "networkidle" });
    await markWon(page);

    const caveat = toast(page, /^Deal marked won\. .*timeline entry could not be recorded/);
    await expect(caveat).toBeVisible({ timeout: opTimeout(20_000) });
    // it waits for the user: a close button, no timer (the dialog that could
    // have held the message is gone). Sonner's default lifetime is 4000 ms and
    // it pauses while the pointer is over the toaster, so move the pointer away
    // and let the lifetime pass — a UI duration, not a race.
    await expect(caveat.getByRole("button", { name: /close/i })).toBeVisible();
    await expect(toast(page, /^Deal marked won$/)).toHaveCount(0);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(5_000);
    await expect(caveat, "no timer: it is still there after the default lifetime").toBeVisible();
    await caveat.getByRole("button", { name: /close/i }).click();
    await expect(caveat).toHaveCount(0);

    const { data: row } = await svc.from("deals").select("status").eq("id", dealId).single();
    expect(row!.status, "the close committed").toBe("won");
    const { data: task } = await svc
      .from("tasks")
      .select("id")
      .eq("property_id", propertyId!)
      .eq("kind", "listing_status_check");
    expect(task, "the reminder exists — only its timeline line is missing").toHaveLength(1);
  } finally {
    await pg.query(`drop trigger if exists ${fn} on public.events`).catch(() => undefined);
    await pg.query(`drop function if exists public.${fn}()`).catch(() => undefined);
    await pg.end();
    await removeFixture(svc);
  }
});

test("a Won whose request never comes back says what to check, and keeps saying it", async ({ page }) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { dealId } = await seedDeal(svc);
  try {
    await page.goto(`/deals/${dealId}`, { waitUntil: "networkidle" });
    // the server action's POST fails in the network — exactly what the browser
    // sees when the function dies (a timeout, a crash): no answer at all
    await page.route(
      (url) => url.pathname === `/deals/${dealId}`,
      (route) =>
        route.request().method() === "POST" && route.request().headers()["next-action"]
          ? route.abort("failed")
          : route.continue(),
    );
    await markWon(page);
    const unknown = toast(page, /^Could not confirm whether the deal was closed — .*reminders may not have been created\.$/);
    await expect(unknown).toBeVisible({ timeout: opTimeout(20_000) });
    await expect(unknown.getByRole("button", { name: /close/i })).toBeVisible();
    await page.unroute((url) => url.pathname === `/deals/${dealId}`);

    // here the request never left the browser, so nothing was written
    const { data: row } = await svc.from("deals").select("status").eq("id", dealId).single();
    expect(row!.status).toBe("open");
    const { data: won } = await svc.from("events").select("id").eq("entity_id", dealId).eq("event_type", "won");
    expect(won).toHaveLength(0);
  } finally {
    await removeFixture(svc);
  }
});
