import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL, assertNoProblems, watchForProblems } from "./helpers";

/**
 * Automated follow-up nudges (IMPROVEMENTS B7).
 *
 * The rules themselves are pinned by RLS test 24 against a real database
 * (cycle keying, EOD stamps, the assignee fallback, supersede-on-change). This
 * spec covers only what the running app can prove: that a nudge the cron
 * created actually REACHES the agent — it renders on /tasks, is marked as
 * system-generated, and links to the deal it is nagging about. A nudge nobody
 * can see is the exact failure mode 0012's NULL-assignee bug produced.
 *
 * It also pins the retirement of the old "Viewings awaiting feedback" virtual
 * section, which viewing_feedback nudges replaced.
 *
 * The key below is the standard local-stack demo service key printed by
 * `supabase status`; it is not a secret and only ever reaches 127.0.0.1. The
 * spec is skipped unless the target is localhost, and it removes its own
 * fixture afterwards.
 */
const LOCAL_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const DEAL_TITLE = "E2E nudge fixture deal";

function serviceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
    LOCAL_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** Tasks first (they FK the deal), then the deal. Events stay — append-only. */
async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: deals } = await svc.from("deals").select("id").eq("title", DEAL_TITLE);
  for (const d of deals ?? []) {
    await svc.from("tasks").delete().eq("deal_id", d.id);
    await svc.from("deals").delete().eq("id", d.id);
  }
}

test.describe("Follow-up nudges", () => {
  test.beforeEach(async ({ baseURL }) => {
    test.skip(
      !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
      "seeds a deal and runs the cron job — local only, never production",
    );
    await removeFixture(serviceClient()); // self-heal after a crashed run
  });

  test.afterEach(async ({ baseURL }) => {
    if (!/localhost|127\.0\.0\.1/.test(baseURL ?? "")) return;
    await removeFixture(serviceClient());
  });

  test("a cron-created no-contact nudge reaches the agent's task list", async ({ page }) => {
    const svc = serviceClient();

    const { data: profile } = await svc
      .from("profiles")
      .select("id, org_id")
      .eq("email", ADMIN_EMAIL)
      .single();
    expect(profile, `no profile for ${ADMIN_EMAIL} — is the local stack seeded?`).not.toBeNull();

    const { data: stage } = await svc
      .from("deal_stages")
      .select("id")
      .eq("org_id", profile!.org_id)
      .eq("deal_type", "sale")
      .order("sort_order")
      .limit(1)
      .single();
    expect(stage, "the seeded org has no sale pipeline").not.toBeNull();

    // Silent for 60 days, so the nudge is comfortably the most overdue task on
    // page 1 whatever else the local database happens to hold.
    const { data: deal, error: dealErr } = await svc
      .from("deals")
      .insert({
        org_id: profile!.org_id,
        deal_type: "sale",
        stage_id: stage!.id,
        title: DEAL_TITLE,
        agent_id: profile!.id,
        created_by: profile!.id,
        last_activity_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      })
      .select("id")
      .single();
    expect(dealErr).toBeNull();

    // exactly what pg_cron runs at 03:15, scoped to this org
    const { error: rpcErr } = await svc.rpc("create_followup_nudges", { p_org: profile!.org_id });
    expect(rpcErr).toBeNull();

    const problems = watchForProblems(page);
    await page.goto("/tasks", { waitUntil: "networkidle" });

    const row = page.getByRole("listitem").filter({ hasText: `No contact in 14 days: ${DEAL_TITLE}` });
    await expect(row).toHaveCount(1);
    // marked as system-generated rather than something the user typed
    await expect(row.getByText("auto")).toBeVisible();
    // and actionable in one click — a nudge you cannot act on gets ignored
    await expect(row.getByRole("link", { name: "Deal" })).toHaveAttribute(
      "href",
      `/deals/${deal!.id}`,
    );
    // 46 days past its due date, so it belongs to Overdue, not Upcoming.
    // Matched on the heading, not on exact text: the <h2> also carries a count
    // badge, so its text is "Overdue" + a number.
    const overdue = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /^Overdue/ }) });
    await expect(overdue.getByText(`No contact in 14 days: ${DEAL_TITLE}`)).toBeVisible();

    assertNoProblems(problems, "tasks with a follow-up nudge");
  });

  test("the old virtual 'viewings awaiting feedback' section is gone", async ({ page }) => {
    // Replaced by viewing_feedback nudges, which are real task rows: they carry
    // a 48-hour threshold, a due date, an assignee and an event trail that a
    // live query never could.
    await page.goto("/tasks", { waitUntil: "networkidle" });
    await expect(page.getByText(/viewings awaiting feedback/i)).toHaveCount(0);

    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await expect(page.getByText(/awaiting your feedback/i)).toHaveCount(0);
  });
});
