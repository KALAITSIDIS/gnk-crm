import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * Entity-linked quick tasks (audit WF-5), end to end.
 *
 * The action's verify-then-insert is app logic a form exercises; this spec
 * proves the surface: the "Add task" dialog on a property page creates a task
 * that carries the property link, and the /tasks list renders that link — a
 * human follow-up that no longer detaches from the record it concerns.
 */

const REF = "E2ETASK01";
const TASK_TITLE = "E2E call the owner about the roof";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  await svc.from("tasks").delete().eq("title", TASK_TITLE);
  await svc.from("properties").delete().eq("reference", REF);
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("Add task on a property page links the task and the list shows it", async ({ page }) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { orgId } = await fixtureProfile(svc);

  const { data: prop } = await svc
    .from("properties")
    .insert({ org_id: orgId, reference: REF, property_type: "apartment", status: "available" })
    .select("id")
    .single();

  try {
    await page.goto(`/properties/${prop!.id}`, { waitUntil: "networkidle" });

    await page.getByRole("button", { name: /add task/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^task$/i).fill(TASK_TITLE);
    await dialog.getByRole("button", { name: /add task/i }).click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: opTimeout(15_000) });

    // ---------- the link landed ----------
    const { data: tasks } = await svc
      .from("tasks")
      .select("id, property_id, kind")
      .eq("title", TASK_TITLE);
    expect(tasks).toHaveLength(1);
    expect(tasks![0].property_id, "the task carries the record it concerns").toBe(prop!.id);
    expect(tasks![0].kind, "a human task has no kind — it must not read as auto").toBeNull();

    const { data: events } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", tasks![0].id)
      .eq("event_type", "created");
    expect(events).toHaveLength(1);
    expect((events![0].payload as { property_id?: string }).property_id).toBe(prop!.id);

    // ---------- and renders on /tasks as a link, not a floating title ----------
    await page.goto("/tasks", { waitUntil: "networkidle" });
    const row = page.locator("li", { hasText: TASK_TITLE });
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: REF })).toBeVisible();
  } finally {
    await removeFixture(svc);
  }
});
