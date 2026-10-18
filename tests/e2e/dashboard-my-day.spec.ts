import { expect, test } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNoHorizontalOverflow,
  assertNoProblems,
  fixtureProfile,
  isLocal,
  runTag,
  serviceClient,
  watchForProblems,
} from "./helpers";

/**
 * The admin dashboard's My day, Team and split feed (A01), as the seeded admin
 * sees them. The component-level rules (exact counts, links per kind, RLS) are
 * pinned against a real database by supabase/tests/dashboard-my-day.test.ts;
 * this spec proves the running page:
 *
 *  - the sections come in a fixed order: My day, then Team, then the KPIs;
 *  - Team's overdue badge equals the database's count for the same rule, and an
 *    unassigned overdue task is listed as "Unassigned" and opens its record;
 *  - an area change lands under "Settings & admin changes", never in "Latest
 *    sales activity";
 *  - the page does not scroll sideways at 380px.
 *
 * Seeds through the service role in the local seeded org; local only. The task
 * is deleted afterwards. The event cannot be (events are append-only), so it is
 * a synthetic area name nobody will mistake for a real one.
 */

const TAG = runTag();
const TASK_TITLE = `E2E team overdue ${TAG}`;
const AREA = `E2E Area ${TAG}`;

async function removeFixture(svc: SupabaseClient): Promise<void> {
  await svc.from("tasks").delete().like("title", "E2E team overdue %");
}

test.describe("dashboard: My day, Team and the split feed (A01)", () => {
  test.beforeEach(async () => {
    test.skip(!isLocal(), "seeds a task and an event — local only, never production");
    await removeFixture(serviceClient());
  });

  test.afterEach(async () => {
    if (!isLocal()) return;
    await removeFixture(serviceClient());
  });

  test("My day, then Team, then the admin KPIs", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    const h2 = await page.getByRole("heading", { level: 2 }).allInnerTexts();
    const at = (re: RegExp) => h2.findIndex((t) => re.test(t));
    expect(at(/^My day$/), JSON.stringify(h2)).toBeGreaterThanOrEqual(0);
    expect(at(/^Team$/)).toBeGreaterThan(at(/^My day$/));
    expect(at(/^Pipeline by stage/)).toBeGreaterThan(at(/^Team$/));
    // the four My day cards are under the My day heading
    const myDay = page.getByRole("region", { name: "My day" });
    for (const name of [/^Today's viewings/, /^Tasks due today & overdue/, /^My open leads/, /^Hot buyers idle/]) {
      await expect(myDay.getByRole("heading", { level: 3, name })).toHaveCount(1);
    }
    assertNoProblems(problems, "dashboard sections");
  });

  test("Team's overdue badge is the database's count, and an unassigned task opens its record", async ({ page }) => {
    const svc = serviceClient();
    const { id: adminId, orgId } = await fixtureProfile(svc);
    const { data: contact } = await svc
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .limit(1)
      .maybeSingle();
    test.skip(!contact, "no contact in the local database to link the task to");
    // nobody's task, four years late: first in the oldest-first list
    const { error } = await svc.from("tasks").insert({
      org_id: orgId,
      title: TASK_TITLE,
      due_at: new Date(Date.now() - 4 * 365 * 86_400_000).toISOString(),
      assignee_id: null,
      contact_id: contact!.id,
    });
    expect(error).toBeNull();

    const { count, error: countErr } = await svc
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("is_done", false)
      .lt("due_at", new Date().toISOString())
      .or(`assignee_id.is.null,assignee_id.neq.${adminId}`);
    expect(countErr).toBeNull();

    await page.goto("/dashboard", { waitUntil: "networkidle" });
    const team = page.getByRole("region", { name: "Team" });
    const heading = team.getByRole("heading", { level: 3, name: /^Overdue across the team/ });
    await expect(heading).toHaveText(new RegExp(`^Overdue across the team\\s*${count}$`));
    const row = team.getByRole("link").filter({ hasText: TASK_TITLE });
    await expect(row).toHaveAttribute("href", `/contacts/${contact!.id}`);
    await expect(row).toContainText("Unassigned");
  });

  test("an area change shows under Settings & admin changes, not in the sales feed", async ({ page }) => {
    const svc = serviceClient();
    const { orgId } = await fixtureProfile(svc);
    // the event addArea writes (lib/actions/settings.ts), written directly so
    // no real area is created
    const { error } = await svc.from("events").insert({
      org_id: orgId,
      actor_id: null,
      entity_type: "config",
      entity_id: null,
      event_type: "locations_updated",
      payload: { action: "add_area", name: AREA },
    });
    expect(error).toBeNull();

    await page.goto("/dashboard", { waitUntil: "networkidle" });
    const card = (name: RegExp) =>
      page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name }) });
    await expect(card(/^Settings & admin changes$/).getByText(`Area added — ${AREA}`)).toBeVisible();
    await expect(card(/^Latest sales activity$/)).not.toContainText(AREA);
  });

  test("the admin dashboard does not scroll sideways at 380px", async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await expect(page.getByRole("region", { name: "My day" })).toBeVisible();
    await assertNoHorizontalOverflow(page, "dashboard at 380px");
  });
});
