import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * The kanban's stage move, end to end (T-authentic-stage-movement, migration
 * 0131). Since 0131 the deal's `stage_changed` is written by the database from
 * the row change (deals_stage_changed_event), not by move_deal_to_stage, and a
 * session may no longer write one itself. This drives the real board — the
 * keyboard path dnd-kit's KeyboardSensor gives every user (Space picks up,
 * → hops one column, Space drops) — as the seed admin, then checks the row,
 * the ONE event the move recorded, the board after a reload, and the deal's
 * Activity line, which reads that event.
 *
 * The board had no end-to-end move before this file (tests/README.md listed
 * drag-and-drop as not covered).
 */

const DEAL_TITLE = "E2E kanban stage move";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  // the deal only — its events stay: the chain is append-only, and they are
  // written in the live window (never back-dated into the seeded org)
  const { data: deals } = await svc.from("deals").select("id").eq("title", DEAL_TITLE);
  for (const d of deals ?? []) {
    await svc.from("tasks").delete().eq("deal_id", d.id);
    await svc.from("deals").delete().eq("id", d.id);
  }
}

test.beforeEach(({}, testInfo) => {
  test.skip(!isLocal(), "seeds and deletes a deal through the service client — local only");
  // playwright.config.ts: the mobile run is a layout check, not a second write pass
  test.skip(testInfo.project.name === "mobile", "a write pass — the desktop project runs it");
});

test("a keyboard drag one column right moves the deal and records exactly one stage_changed, shown on its timeline", async ({ page }) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { id: adminId, orgId } = await fixtureProfile(svc);
  const { data: stages } = await svc
    .from("deal_stages")
    .select("id, name, sort_order")
    .eq("org_id", orgId)
    .eq("deal_type", "sale")
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("sort_order")
    .limit(2);
  expect(stages, "the seeded org needs two open sale stages").toHaveLength(2);
  const [from, to] = stages! as Array<{ id: string; name: string }>;
  const { data: deal, error } = await svc
    .from("deals")
    .insert({ org_id: orgId, deal_type: "sale", stage_id: from.id, title: DEAL_TITLE, agent_id: adminId, created_by: adminId })
    .select("id")
    .single();
  expect(error).toBeNull();
  const dealId = deal!.id as string;

  const movesOf = async () => {
    const { data } = await svc
      .from("events")
      .select("actor_id, org_id, payload")
      .eq("entity_type", "deal")
      .eq("entity_id", dealId)
      .eq("event_type", "stage_changed")
      .order("id");
    return data ?? [];
  };

  try {
    await page.goto("/pipeline?type=sale", { waitUntil: "networkidle" });
    const board = page.getByTestId("kanban-board");
    const cardIn = (stageId: string) =>
      page.locator(`section[data-stage-id="${stageId}"] li`, { hasText: DEAL_TITLE });
    await expect(cardIn(from.id)).toHaveCount(1);

    // dnd-kit's draggable wrapper carries role="button" (its `attributes`).
    // Each key waits for the board's own screen-reader announcement (kanban.tsx
    // `announcements`): KeyboardSensor attaches its keydown listener in a
    // setTimeout after the pick-up, so a key pressed at once is lost — the
    // first run of this spec dropped the card back where it was. A pick-up
    // announces "Picked up …" and, at once, "… is over the <its own> stage."
    // (the live region keeps the last), which says the drag is live.
    const live = page.locator('[id^="DndLiveRegion-"]');
    const handle = cardIn(from.id).locator('[role="button"]').first();
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(live).toHaveText(`${DEAL_TITLE} is over the ${from.name} stage.`);
    await page.keyboard.press("ArrowRight");
    await expect(live).toHaveText(`${DEAL_TITLE} is over the ${to.name} stage.`);
    await page.keyboard.press("Space");
    await expect(live).toHaveText(`${DEAL_TITLE} was dropped on the ${to.name} stage.`);

    // the move is done when the row has moved AND the board's transition has
    // settled (the action returned) — not at the first write
    await expect
      .poll(async () => (await svc.from("deals").select("stage_id").eq("id", dealId).single()).data?.stage_id, {
        timeout: opTimeout(15_000),
      })
      .toBe(to.id);
    await expect(board).not.toHaveClass(/pointer-events-none/, { timeout: opTimeout(15_000) });

    expect(await movesOf(), "one movement, from the stage actually left, by the signed-in user").toEqual([
      {
        actor_id: adminId,
        org_id: orgId,
        payload: { from: from.name, to: to.name, from_stage_id: from.id, to_stage_id: to.id },
      },
    ]);

    // picking it up and dropping it where it is never reaches the server (the
    // board's onDragEnd returns first) — the database-side no-op and retry are
    // pinned by supabase/tests/stage-movement-authentic.test.ts
    await page.reload({ waitUntil: "networkidle" });
    await expect(cardIn(to.id)).toHaveCount(1);
    await expect(cardIn(from.id)).toHaveCount(0);
    await cardIn(to.id).locator('[role="button"]').first().focus();
    await page.keyboard.press("Space");
    await expect(live).toHaveText(`${DEAL_TITLE} is over the ${to.name} stage.`);
    await page.keyboard.press("Space");
    await expect(live).toHaveText(`${DEAL_TITLE} was dropped on the ${to.name} stage.`);
    await expect(board).not.toHaveClass(/pointer-events-none/, { timeout: opTimeout(15_000) });
    expect(await movesOf(), "the board does not call the server for a drop onto its own column").toHaveLength(1);

    // the deal's Activity reads the event the database wrote
    await page.goto(`/deals/${dealId}`, { waitUntil: "networkidle" });
    const activity = page.locator("section", { has: page.getByRole("heading", { name: "Activity" }) });
    await expect(activity.locator("li", { hasText: `Stage ${from.name} → ${to.name}` })).toHaveCount(1);
  } finally {
    await removeFixture(svc);
  }
});
