import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * Admin surface for tasks nobody can see (BACKLOG T-audit-tasks).
 *
 * The bug is an ABSENCE — rows that exist and appear on no list — so the only
 * honest test seeds both invisibilities and checks they surface, then checks
 * the reassign actually moves them somewhere visible.
 *
 * The unassigned case earns its own assertions: reassigning it is the path that
 * a bare `.neq("assignee_id", to)` precondition silently refuses, because
 * `NULL <> 'uuid'` is NULL and PostgREST drops the row. That is a bug you cannot
 * see from the outside — the action returns "not reassigned" and the row stays
 * stranded — so it is pinned here rather than left to a reviewer.
 */

const TITLE_PREFIX = "STRANDED-FIXTURE";

test.describe("Stranded tasks", () => {
  test.skip(!isLocal(), "seeding needs the local service key");

  let adminId = "";
  let orgId = "";
  let ghostId = "";

  test.beforeAll(async () => {
    const svc = serviceClient();
    const { data: admin } = await svc
      .from("profiles")
      .select("id, org_id")
      .eq("email", ADMIN_EMAIL)
      .single();
    adminId = admin!.id;
    orgId = admin!.org_id;

    // A deactivated colleague to strand a task on. `profiles.id` is a FK onto
    // `auth.users`, so this needs a real auth user rather than a bare profile
    // row — a first draft skipped that, the upsert failed, and the FK violation
    // surfaced two steps later as a confusing task-insert error.
    const email = `departed-${Date.now().toString(36)}@gnk.local`;
    const { data: created, error: userErr } = await svc.auth.admin.createUser({
      email,
      password: `pw-${Math.random().toString(36).slice(2)}`,
      email_confirm: true,
    });
    expect(userErr, `creating the fixture auth user: ${userErr?.message}`).toBeNull();
    ghostId = created!.user!.id;

    const { error: profErr } = await svc.from("profiles").insert({
      id: ghostId,
      org_id: orgId,
      role: "agent",
      full_name: "Departed Colleague",
      email,
      is_active: false,
    });
    expect(profErr, `creating the deactivated profile: ${profErr?.message}`).toBeNull();
  });

  test.afterAll(async () => {
    const svc = serviceClient();
    await svc.from("tasks").delete().like("title", `${TITLE_PREFIX}%`);
    // Deleting the auth user cascades the profile (profiles_id_fkey ON DELETE
    // CASCADE), so this cannot leave a half-removed colleague behind.
    if (ghostId) await svc.auth.admin.deleteUser(ghostId);
  });

  test("surfaces both invisibilities and reassigns them to an active user", async ({ page }) => {
    const svc = serviceClient();
    const tag = Date.now().toString(36);
    const heldTitle = `${TITLE_PREFIX} held ${tag}`;
    const orphanTitle = `${TITLE_PREFIX} orphan ${tag}`;

    const { error: seedErr } = await svc.from("tasks").insert([
      { org_id: orgId, title: heldTitle, assignee_id: ghostId, is_done: false },
      { org_id: orgId, title: orphanTitle, assignee_id: null, is_done: false },
    ]);
    expect(seedErr, `seeding tasks: ${seedErr?.message}`).toBeNull();

    await page.goto("/tasks");

    // Both are invisible to every assignee-scoped list, and both must appear here.
    const panel = page.getByRole("heading", { name: /needs an owner/i });
    await expect(panel).toBeVisible();
    // `exact` matters: the accessible label on each row select also contains the
    // title ("Reassign <title> to"), so a loose match is ambiguous.
    await expect(page.getByText(heldTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(orphanTitle, { exact: true })).toBeVisible();

    // The deactivated one names who held it; the orphan says so plainly.
    await expect(page.getByText(/Held by Departed Colleague \(deactivated\)/)).toBeVisible();
    await expect(page.getByText(/^Unassigned/).first()).toBeVisible();

    // Reassign the ORPHAN first — the NULL-assignee path.
    const orphanRow = page.locator("li").filter({ hasText: orphanTitle });
    await orphanRow.getByLabel(new RegExp(`Reassign ${orphanTitle}`, "i")).selectOption(adminId);
    await orphanRow.getByRole("button", { name: /^reassign$/i }).click();

    await expect
      .poll(
        async () => {
          const { data } = await svc
            .from("tasks")
            .select("assignee_id")
            .eq("title", orphanTitle)
            .single();
          return data?.assignee_id ?? null;
        },
        { timeout: opTimeout(20_000), message: "the unassigned task was never reassigned" },
      )
      .toBe(adminId);

    // It left the PANEL — scoped, not page-wide. A page-wide count of 0 fails
    // for the best possible reason: the task is now on the admin's own list,
    // which is precisely the invisibility being fixed. Assert both halves.
    const panelSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /needs an owner/i }) });
    await expect(panelSection.getByText(orphanTitle, { exact: true })).toHaveCount(0);
    await expect(page.getByText(orphanTitle, { exact: true })).toBeVisible();

    // The reassignment is on the record, using the existing `assigned` event.
    const { data: taskRow } = await svc.from("tasks").select("id").eq("title", orphanTitle).single();
    const { data: events } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", taskRow!.id)
      .eq("event_type", "assigned");
    expect(events?.length, "one assigned event").toBe(1);
    expect((events![0].payload as { to_id?: string }).to_id).toBe(adminId);

    // The deactivated-assignee one still needs an owner and is still in the panel.
    await expect(panelSection.getByText(heldTitle, { exact: true })).toBeVisible();
  });

  /*
   * NOT tested here: that an agent cannot see or reassign these.
   *
   * A first draft asserted it, but the desktop project runs from a single admin
   * storageState, so the test could only ever have shown the ADMIN's view while
   * claiming to check the agent's — a name that overstates its assertion is
   * worse than no test. The property is real and already owned where it belongs:
   * RLS test 17 pins that an unrelated agent selects 0 rows for someone else's
   * task, and `reassignTask` re-checks `role !== "admin"` in the action on top of
   * `tasks_update`'s own admin clause.
   */
});
