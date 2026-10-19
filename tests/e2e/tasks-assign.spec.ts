import { expect, test } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { addDayKey } from "@/lib/services/calendar-window";
import { zonedParts, zonedWallClockToUtc } from "@/lib/utils/tz";
import {
  assertNoHorizontalOverflow,
  assertNoProblems,
  fixtureProfile,
  isLocal,
  opTimeout,
  runTag,
  serviceClient,
  watchForProblems,
} from "./helpers";

/**
 * Tasks for a colleague (A02), as the seeded admin uses them:
 *
 *  - the quick add's "More" adds a time and a colleague; the Delegated view
 *    lists the task with the colleague's name and the time; the `created`
 *    line carries the assignee id and the instant, never the title;
 *  - the edit dialog moves the time, and an `updated` line records it;
 *  - the Delegated CSV holds the row and names the colleague;
 *  - Team lists it; a system task offers reassign only (no date to edit);
 *  - the page does not scroll sideways at 380px with the views and More open.
 *
 * Who may do what against real RLS, the refusals and the due windows are
 * pinned by supabase/tests/task-assign.test.ts; the action's events by
 * lib/actions/tasks-assign.test.ts. Seeds a colleague (an auth user and an
 * agent profile) and tasks through the service role; local only. The tasks and
 * the colleague are deleted afterwards; the events cannot be (append-only), and
 * carry ids only.
 */

const TAG = runTag();
const TITLE = `E2E call the owner ${TAG}`;
const NUDGE = `E2E renewal nudge ${TAG}`;

let colleagueId = "";
let colleagueName = "";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  await svc.from("tasks").delete().like("title", "E2E call the owner %");
  await svc.from("tasks").delete().like("title", "E2E renewal nudge %");
}

/** Tomorrow's Cyprus day, and an instant on it — the form takes Cyprus wall-clock time. */
const tomorrowKey = () => addDayKey(zonedParts(new Date()).dayKey, 1);
const cyprusAt = (key: string, time: string) => zonedWallClockToUtc(`${key}T${time}`).toISOString();

test.describe("tasks for a colleague (A02)", () => {
  test.beforeAll(async () => {
    if (!isLocal()) return;
    const svc = serviceClient();
    await removeFixture(svc);
    const { orgId } = await fixtureProfile(svc);
    const email = `e2e-colleague-${TAG}@gnk.local`;
    const { data: created, error } = await svc.auth.admin.createUser({
      email,
      password: `pw-${Math.random().toString(36).slice(2)}`,
      email_confirm: true,
    });
    expect(error, `creating the colleague: ${error?.message}`).toBeNull();
    colleagueId = created!.user!.id;
    colleagueName = `E2E Colleague ${TAG}`;
    const { error: profErr } = await svc.from("profiles").insert({
      id: colleagueId,
      org_id: orgId,
      role: "agent",
      full_name: colleagueName,
      email,
      is_active: true,
    });
    expect(profErr, `creating the colleague's profile: ${profErr?.message}`).toBeNull();
  });

  test.afterAll(async () => {
    if (!isLocal()) return;
    const svc = serviceClient();
    await removeFixture(svc);
    // deleting the auth user cascades the profile
    if (colleagueId) await svc.auth.admin.deleteUser(colleagueId);
  });

  test.beforeEach(() => {
    test.skip(!isLocal(), "seeds a colleague and tasks — local only, never production");
  });

  test("add for a colleague with a time, see it delegated, move the time, export it", async ({ page }) => {
    const svc = serviceClient();
    const problems = watchForProblems(page);
    const tomorrow = tomorrowKey();

    await page.goto("/tasks", { waitUntil: "networkidle" });
    await page.getByPlaceholder(/quick task/i).fill(TITLE);
    await page.getByLabel(/due date/i).fill(tomorrow);
    await page.getByText(/^More — time, assign to$/).click();
    await page.getByLabel(/^due time$/i).fill("10:30");
    await page.getByLabel(/^assign to$/i).selectOption(colleagueId);
    await page.getByRole("button", { name: /add|create/i }).first().click();
    await expect(page.getByText("Task added")).toBeVisible({ timeout: opTimeout(15_000) });

    // ---------- the row and its line ----------
    const { data: rows } = await svc.from("tasks").select("id, assignee_id, due_at, kind").eq("title", TITLE);
    expect(rows).toHaveLength(1);
    const task = rows![0]!;
    expect(task.assignee_id).toBe(colleagueId);
    expect(new Date(task.due_at!).toISOString()).toBe(cyprusAt(tomorrow, "10:30"));
    const { data: created } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", task.id)
      .eq("event_type", "created");
    expect(created).toHaveLength(1);
    expect(created![0]!.payload).toEqual({ due_at: cyprusAt(tomorrow, "10:30"), assignee_id: colleagueId });

    // ---------- Mine no longer holds it; Delegated does, with the name and the time ----------
    await expect(page.locator("li", { hasText: TITLE })).toHaveCount(0);
    const views = page.getByRole("navigation", { name: "Task views" });
    await views.getByRole("link", { name: "Delegated", exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\?scope=delegated$/);
    const row = page.locator("li", { hasText: TITLE });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`For ${colleagueName}`);
    await expect(row).toContainText("10:30");

    // ---------- an admin may edit it: move it to 11:00 ----------
    await row.getByRole("button", { name: `Edit: ${TITLE}` }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^due time$/i).fill("11:00");
    await dialog.getByRole("button", { name: /^save$/i }).click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: opTimeout(15_000) });
    await expect(page.locator("li", { hasText: TITLE })).toContainText("11:00", { timeout: opTimeout(15_000) });
    const { data: updated } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", task.id)
      .eq("event_type", "updated");
    expect(updated).toHaveLength(1);
    expect(updated![0]!.payload).toEqual({
      changed: { due_at: { from: cyprusAt(tomorrow, "10:30"), to: cyprusAt(tomorrow, "11:00") } },
    });

    // ---------- the Delegated CSV is this view, and names the colleague ----------
    const res = await page.request.get("/tasks/export?scope=delegated");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"] ?? "").toMatch(/filename="delegated-tasks-\d{4}-\d{2}-\d{2}\.csv"/);
    const csv = (await res.text()).replace(/^﻿/, "");
    expect(csv).toMatch(/^Title,Status,Due,Done at,Property,Auto,Created,Assignee\r\n/);
    const line = csv.split("\r\n").find((l) => l.startsWith(TITLE));
    expect(line, "the delegated task is in the delegated export").toBeDefined();
    expect(line!.endsWith(`,${colleagueName}`)).toBe(true);

    // ---------- Team lists it ----------
    await views.getByRole("link", { name: "Team", exact: true }).click();
    await expect(page).toHaveURL(/\/tasks\?scope=team$/);
    await expect(page.locator("li", { hasText: TITLE })).toBeVisible();

    assertNoProblems(problems, "tasks for a colleague");
  });

  test("a system task offers reassign only — its rule owns the date", async ({ page }) => {
    const svc = serviceClient();
    const { id: adminId, orgId } = await fixtureProfile(svc);
    const { error } = await svc.from("tasks").insert({
      org_id: orgId,
      title: NUDGE,
      assignee_id: adminId,
      kind: "deal_no_contact",
      due_at: cyprusAt(tomorrowKey(), "23:59"),
    });
    expect(error, `seeding the nudge: ${error?.message}`).toBeNull();

    await page.goto("/tasks", { waitUntil: "networkidle" });
    const row = page.locator("li", { hasText: NUDGE });
    await row.getByRole("button", { name: `Edit: ${NUDGE}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/its rule sets the title and the due date/i);
    await expect(dialog.getByLabel(/^due date$/i)).toHaveCount(0);
    await expect(dialog.getByLabel(/^task$/i)).toHaveCount(0);
    await expect(dialog.getByLabel(/^assign to$/i)).toBeVisible();
  });

  test("380px: the views and the More fields do not widen the page", async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    await page.goto("/tasks?scope=team&due=week", { waitUntil: "networkidle" });
    await page.getByText(/^More — time, assign to$/).click();
    await assertNoHorizontalOverflow(page, "/tasks at 380px");
  });
});
