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

  const { data: res } = await svc
    .from("reservations")
    .select("id")
    .eq("property_id", prop!.id)
    .single();

  /*
   * A live-hold prompt (0089) already open on this hold. Converting it is
   * exactly the ask being obeyed, so the prompt must close — a prompt that
   * survives being obeyed teaches the desk to ignore prompts, which is the
   * failure `completeListingStatusChecks` exists to avoid and which raising a
   * second kind could easily have reintroduced.
   */
  const { data: holdPrompt, error: holdTaskErr } = await svc
    .from("tasks")
    .insert({
      org_id: orgId,
      title: `Deal won — settle the hold on ${REF}`,
      property_id: prop!.id,
      reservation_id: res!.id,
      kind: "reservation_still_live",
      assignee_id: profileId,
      is_done: false,
    })
    .select("id")
    .single();
  expect(holdTaskErr, "seeding the live-hold prompt").toBeNull();

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

    /*
     * WAIT FOR THE ACTION TO FINISH, NOT FOR ITS FIRST WRITE.
     *
     * The poll above proves the reservation transition committed — and that is
     * the FIRST of this action's writes. It then reads the property, reads the
     * open tasks, inserts the prompt and writes that prompt's event: four more
     * round trips. Asserting on the task straight after the status poll raced
     * them and lost on roughly a third of CI runs (first-attempt failure in 3
     * of 8 sampled runs, 2026-09-07, passing on retry — which is worse than
     * failing outright, because a suite that goes green on retry teaches the
     * desk to ignore red).
     *
     * So each assertion waits for the thing it asserts. That also makes the
     * "never auto-flipped" check below SOUND: read mid-action, it would have
     * passed over a flip written a moment later — a test that cannot fail for
     * the reason it exists. deal-close.spec gets this for free by waiting on
     * its dialog to close, which only happens once the action has returned;
     * this path has no dialog.
     */
    const promptTasks = async () => {
      const { data } = await svc
        .from("tasks")
        .select("id, assignee_id, is_done, reservation_id, due_at")
        .eq("property_id", prop!.id)
        .eq("kind", "listing_status_check");
      return data ?? [];
    };
    await expect
      .poll(async () => (await promptTasks()).length, { timeout: opTimeout(15_000) })
      .toBe(1);

    // the raise is evented — the action's last write before it returns
    const raiseEvents = async () => {
      const { data } = await svc
        .from("events")
        .select("payload")
        .eq("entity_id", prop!.id)
        .eq("event_type", "followup_task_created");
      return (data ?? []).filter(
        (e) => (e.payload as { kind?: string }).kind === "listing_status_check",
      );
    };
    await expect
      .poll(async () => (await raiseEvents()).length, { timeout: opTimeout(15_000) })
      .toBe(1);

    // NOW the action has demonstrably finished, so this reads the status it
    // left behind: the desk's call, never auto-flipped.
    const { data: still } = await svc
      .from("properties")
      .select("status")
      .eq("id", prop!.id)
      .single();
    expect(still!.status, "the convert must ASK, not flip").toBe("reserved");

    // one open prompt, linked to the reservation, assigned to the closer
    // (no linked deal in this fixture — the deal.agent_id path is pinned by
    // deal-close.spec)
    const prompts = await promptTasks();
    expect(prompts[0].is_done).toBe(false);

    /*
     * A PROMPT MUST NOT BE BORN OVERDUE.
     *
     * The task list marks a row overdue when `due_at < now`
     * (app/(app)/tasks/page.tsx), so a prompt stamped with the instant it was
     * raised renders red on the very next paint — before the desk has had any
     * chance to act. Red that arrives with the task teaches the desk to ignore
     * red, which is the one thing the colour is for.
     *
     * The repo's own convention (lib/actions/tasks.ts) is Cyprus end-of-day:
     * "due today" stays black until the working day actually ends.
     */
    expect(prompts[0].due_at, "the prompt carries a due date at all").not.toBeNull();
    expect(
      new Date(prompts[0].due_at as string).getTime(),
      "due later today, not the moment it was raised",
    ).toBeGreaterThan(Date.now());
    expect(prompts[0].reservation_id, "linked to the reservation").not.toBeNull();
    expect(prompts[0].assignee_id, "no linked deal → assigned to the closer").toBe(profileId);

    // ---------- and the hold prompt closed, because it was obeyed ----------
    await expect
      .poll(
        async () => {
          const { data } = await svc
            .from("tasks")
            .select("is_done")
            .eq("id", holdPrompt!.id)
            .single();
          return data?.is_done;
        },
        { timeout: opTimeout(15_000) },
      )
      .toBe(true);

    const { data: supersede } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", holdPrompt!.id)
      .eq("event_type", "superseded");
    expect(supersede, "closing it is a state change, so it owes an event").toHaveLength(1);
    expect((supersede![0].payload as { reason?: string }).reason).toMatch(/converted/i);
  } finally {
    await removeFixture(svc);
  }
});
