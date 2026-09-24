import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * T-event-typed-text-shape, end to end: typed text stays on the ROW, the hash
 * chain gets ids, and the screens still say what happened.
 *
 * Driven through the real forms as the seed admin, then checked twice — the
 * event row as stored (service client), and the page as rendered:
 *
 * - a property document's upload and deletion events name it by id; the
 *   Activity tab labels the live document with its CURRENT title, read from the
 *   row, and a deleted one reads "Document deleted" with its name nowhere;
 * - ticking a task done and reopening it logs `{}`; the admin dashboard's feed
 *   still says which task, as a labelled current title;
 * - marking a deal lost stores the typed reason on the deal, which the page
 *   header prints; the event carries none, and the Activity line is "Marked
 *   lost" alone;
 * - closing a lead as lost does the same (T-lead-lost-reason-shape): the inbox
 *   prints the reason from the lead, the event is `{}`, and the admin feed's
 *   line is "Marked lost" alone.
 *
 * What an agent may NOT see (an admin_only document, a colleague's task) is
 * measured against the real policies in supabase/tests/event-context.test.ts —
 * every e2e signs in as the seed admin.
 */

const REF = "E2ETYPED01";
const DEAL_TITLE = "E2E typed-text lost deal";
// synthetic, and distinctive enough that a leak shows wherever it lands
const DOC_TITLE = "E2E Kyriakou title deed scan";
const FILE_NAME = "E2E Kyriakou deed 99111222.pdf";
const TASK_TITLE = "E2E call Kyriakoula Palaiopoulou about the deposit";
const REASON = "E2E Eleni Charalambous bought her cousin's villa instead";
const LEAD_MESSAGE = "E2E typed-text lead — asking about a two-bed";
const LEAD_REASON = "E2E Andreas Kyprianou went with his brother-in-law";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  await svc.from("tasks").delete().eq("title", TASK_TITLE);
  await svc.from("leads").delete().eq("message", LEAD_MESSAGE);
  const { data: deals } = await svc.from("deals").select("id").eq("title", DEAL_TITLE);
  for (const d of deals ?? []) {
    await svc.from("tasks").delete().eq("deal_id", d.id);
    await svc.from("deals").delete().eq("id", d.id);
  }
  const { data: props } = await svc.from("properties").select("id").eq("reference", REF);
  for (const p of props ?? []) {
    const { data: docs } = await svc
      .from("documents")
      .select("id, storage_path")
      .eq("entity_type", "property")
      .eq("entity_id", p.id);
    const paths = (docs ?? []).map((d) => d.storage_path as string).filter(Boolean);
    if (paths.length) await svc.storage.from("documents").remove(paths);
    await svc.from("documents").delete().eq("entity_type", "property").eq("entity_id", p.id);
    await svc.from("tasks").delete().eq("property_id", p.id);
    await svc.from("properties").delete().eq("id", p.id);
  }
}

/** the events of one entity and type, newest first */
async function eventsOf(svc: SupabaseClient, entityId: string, eventType: string) {
  const { data } = await svc
    .from("events")
    .select("payload")
    .eq("entity_id", entityId)
    .eq("event_type", eventType)
    .order("occurred_at", { ascending: false });
  return (data ?? []).map((r) => r.payload as Record<string, unknown>);
}

async function openTab(page: Page, name: RegExp) {
  await page.getByRole("tab", { name }).click();
  await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("a property document's events carry its id, and the timeline names it from the row", async ({ page }) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { orgId } = await fixtureProfile(svc);
  const { data: prop } = await svc
    .from("properties")
    .insert({ org_id: orgId, reference: REF, property_type: "apartment", status: "available" })
    .select("id")
    .single();
  const propertyId = prop!.id as string;

  try {
    // ---------- upload through the Documents tab ----------
    await page.goto(`/properties/${propertyId}`, { waitUntil: "networkidle" });
    await openTab(page, /^Documents/);
    const panel = page.getByRole("tabpanel");
    await panel.locator("#doc_title").fill(DOC_TITLE);
    await panel.locator("#doc_file").setInputFiles({
      name: FILE_NAME,
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n% e2e typed-text fixture\n"),
    });
    await panel.getByRole("button", { name: /upload/i }).click();
    await expect(panel.getByText(DOC_TITLE, { exact: true })).toBeVisible({ timeout: opTimeout(15_000) });

    // the ROW keeps the title; the EVENT names the document by id
    const { data: docRow } = await svc
      .from("documents")
      .select("id, title, doc_type, visibility")
      .eq("entity_type", "property")
      .eq("entity_id", propertyId)
      .single();
    expect(docRow!.title).toBe(DOC_TITLE);
    await expect.poll(async () => (await eventsOf(svc, propertyId, "document_uploaded")).length).toBe(1);
    const [uploaded] = await eventsOf(svc, propertyId, "document_uploaded");
    expect(uploaded).toEqual({ document_id: docRow!.id, doc_type: docRow!.doc_type, visibility: docRow!.visibility });
    expect(JSON.stringify(uploaded)).not.toMatch(/Kyriakou|99111222|\.pdf/);

    // the Activity tab still says which document — labelled as its CURRENT title
    await page.reload({ waitUntil: "networkidle" });
    await openTab(page, /^Activity$/);
    const upLine = page.getByRole("tabpanel").locator("li", { hasText: "Document uploaded" });
    await expect(upLine).toHaveCount(1);
    await expect(upLine).toContainText(`current title: ${DOC_TITLE}`);

    // ---------- delete it ----------
    await openTab(page, /^Documents/);
    page.once("dialog", (d) => void d.accept());
    await page
      .getByRole("tabpanel")
      .locator("li", { hasText: DOC_TITLE })
      .getByTitle("Delete document")
      .click();
    await expect.poll(async () => (await eventsOf(svc, propertyId, "document_deleted")).length, {
      timeout: opTimeout(15_000),
    }).toBe(1);
    const [deleted] = await eventsOf(svc, propertyId, "document_deleted");
    expect(deleted).toEqual({ document_id: docRow!.id, doc_type: docRow!.doc_type, visibility: docRow!.visibility });

    // no row, no name: both lines are neutral and the title is nowhere on the timeline
    await page.reload({ waitUntil: "networkidle" });
    await openTab(page, /^Activity$/);
    const timeline = page.getByRole("tabpanel");
    await expect(timeline.locator("li", { hasText: "Document deleted" })).toHaveCount(1);
    await expect(timeline.locator("li", { hasText: "Document uploaded" })).toHaveCount(1);
    await expect(timeline).not.toContainText("Kyriakou");
    await expect(timeline).not.toContainText("current title");
  } finally {
    await removeFixture(svc);
  }
});

test("ticking a task logs `{}`, and the admin feed still names it from the row", async ({ page }) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { id: adminId, orgId } = await fixtureProfile(svc);
  const { data: task } = await svc
    .from("tasks")
    .insert({
      org_id: orgId,
      title: TASK_TITLE,
      assignee_id: adminId,
      created_by: adminId,
      // a year overdue, so it is first on /tasks page 1 (due_at asc, 25 a page)
      // whatever else the local database holds — nudges.spec.ts does the same
      due_at: new Date(Date.now() - 365 * 86_400_000).toISOString(),
    })
    .select("id")
    .single();
  const taskId = task!.id as string;

  try {
    await page.goto("/tasks", { waitUntil: "networkidle" });
    await page.getByRole("checkbox", { name: `Complete: ${TASK_TITLE}` }).click();
    await expect.poll(async () => (await eventsOf(svc, taskId, "completed")).length, {
      timeout: opTimeout(15_000),
    }).toBe(1);
    expect(await eventsOf(svc, taskId, "completed")).toEqual([{}]);
    const { data: row } = await svc.from("tasks").select("is_done, title").eq("id", taskId).single();
    expect(row).toEqual({ is_done: true, title: TASK_TITLE });

    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await expect(
      page.locator("li", { hasText: "Task completed" }).filter({ hasText: `current title: ${TASK_TITLE}` }),
    ).toHaveCount(1);

    // reopen from the done list
    await page.goto("/tasks", { waitUntil: "networkidle" });
    await page.getByRole("checkbox", { name: `Reopen: ${TASK_TITLE}` }).click();
    await expect.poll(async () => (await eventsOf(svc, taskId, "reopened")).length, {
      timeout: opTimeout(15_000),
    }).toBe(1);
    expect(await eventsOf(svc, taskId, "reopened")).toEqual([{}]);

    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await expect(
      page.locator("li", { hasText: "Task reopened" }).filter({ hasText: `current title: ${TASK_TITLE}` }),
    ).toHaveCount(1);
  } finally {
    await removeFixture(svc);
  }
});

test("marking a deal lost keeps the reason on the deal; the event and the Activity line carry none", async ({ page }) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { id: adminId, orgId } = await fixtureProfile(svc);
  const { data: stage } = await svc
    .from("deal_stages")
    .select("id")
    .eq("org_id", orgId)
    .eq("deal_type", "sale")
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("sort_order")
    .limit(1)
    .single();
  const { data: deal } = await svc
    .from("deals")
    .insert({ org_id: orgId, deal_type: "sale", stage_id: stage!.id, title: DEAL_TITLE, agent_id: adminId })
    .select("id")
    .single();
  const dealId = deal!.id as string;

  try {
    await page.goto(`/deals/${dealId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /mark lost/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#lost_reason").fill(REASON);
    await dialog.getByRole("button", { name: /^mark lost$/i }).click();
    // the dialog closes when the action has returned — every write is done
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: opTimeout(15_000) });

    const { data: row } = await svc.from("deals").select("status, lost_reason").eq("id", dealId).single();
    expect(row).toEqual({ status: "lost", lost_reason: REASON });
    const lost = await eventsOf(svc, dealId, "lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]).not.toHaveProperty("reason");
    expect(JSON.stringify(lost[0])).not.toMatch(/Eleni|Charalambous|cousin/);

    // the page still says why — from the ROW — and the Activity line does not
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByText(REASON).first()).toBeVisible();
    const activity = page.locator("section", { has: page.getByRole("heading", { name: "Activity" }) });
    await expect(activity.locator("li", { hasText: "Marked lost" })).toHaveCount(1);
    await expect(activity).not.toContainText("Eleni");
  } finally {
    await removeFixture(svc);
  }
});

test("closing a lead as lost keeps the reason on the lead; the event and the admin feed line carry none", async ({ page }) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { orgId } = await fixtureProfile(svc);
  // a phone lead, so no website-enquiry cron (alerts, SLA tasks) touches it
  const { data: lead } = await svc
    .from("leads")
    .insert({ org_id: orgId, source: "phone", status: "new", received_at: new Date().toISOString(), message: LEAD_MESSAGE })
    .select("id")
    .single();
  const leadId = lead!.id as string;

  try {
    await page.goto("/leads", { waitUntil: "networkidle" });
    const row = page.locator("li", { hasText: LEAD_MESSAGE });
    await expect(row).toBeVisible({ timeout: opTimeout(30_000) });
    await row.getByRole("button", { name: /^close$/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/reason/i).fill(LEAD_REASON);
    await dialog.getByRole("button", { name: /^mark lost$/i }).click();
    // the dialog closes when the action has returned — every write is done
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: opTimeout(15_000) });

    const { data: rowNow } = await svc.from("leads").select("status, lost_reason").eq("id", leadId).single();
    expect(rowNow).toEqual({ status: "lost", lost_reason: LEAD_REASON });
    expect(await eventsOf(svc, leadId, "lost")).toEqual([{}]);

    // the inbox's closed scope prints the CURRENT reason, from the lead
    await page.goto("/leads?status=lost", { waitUntil: "networkidle" });
    await expect(page.locator("li", { hasText: LEAD_MESSAGE })).toContainText(`Reason: ${LEAD_REASON}`);

    // the admin feed says it was lost, and nothing of why
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await expect(page.locator("li", { hasText: "Marked lost" }).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Kyprianou");
  } finally {
    await removeFixture(svc);
  }
});
