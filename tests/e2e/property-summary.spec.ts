import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { assertNoHorizontalOverflow, fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * A08 PR 3 — the property page's summary strip, in a real browser.
 *
 * Price, availability, owner, responsible agent, next action, mandate and
 * "Outstanding" sit under the reference, without opening a tab:
 *   - the owner is a link to the contact; the next action is the open task
 *     (the harness signs in as the admin, so "Next task", not "Your next
 *     task" — supabase/tests/property-summary.test.ts proves the agent's);
 *   - "Outstanding" is a count that links to the readiness panel and works
 *     from the keyboard: Enter on it, then Tab, lands inside the panel;
 *   - the human title is in the h1 beside the reference; the badges say
 *     "Status:" / "Visibility:" / "Mandate:" to a screen reader;
 *   - the browser-tab title is the reference only — no title, no owner name;
 *   - one "Add task" on the page, in the Next action cell;
 *   - two columns at 390px (the mobile project), four at 1280; no sideways
 *     scroll in either.
 *
 * Runs under both projects. Seeded through the service role with a fresh
 * reference per run (the two projects may run side by side), deleted at the
 * end with its task, mandate and owner contact.
 */
const svc = (): SupabaseClient => serviceClient();
const isPhone = (width: number) => width < 768;

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

async function seed(admin: SupabaseClient, orgId: string, agentId: string) {
  const tag = randomBytes(3).toString("hex");
  const ownerName = `E2E summary owner ${tag}`;
  const { data: owner, error: ownerErr } = await admin
    .from("contacts")
    .insert({ org_id: orgId, first_name: ownerName })
    .select("id")
    .single();
  expect(ownerErr, ownerErr?.message).toBeNull();
  const title = `E2E summary flat ${tag}`;
  const { data, error } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-SUM-${tag}`,
      kind: "standalone" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      visibility: "public" as const,
      published_at: new Date().toISOString(),
      title: { en: title },
      asking_price: 265000,
      assigned_agent_id: agentId,
      owner_contact_id: owner!.id,
    })
    .select("id, reference")
    .single();
  expect(error, error?.message).toBeNull();
  const { error: mandateErr } = await admin.from("mandates").insert({
    org_id: orgId,
    property_id: data!.id,
    type: "exclusive" as const,
    status: "active" as const,
    expiry_date: "2099-01-12",
  });
  expect(mandateErr, mandateErr?.message).toBeNull();
  const taskTitle = `E2E summary task ${tag}`;
  const { error: taskErr } = await admin.from("tasks").insert({
    org_id: orgId,
    property_id: data!.id,
    title: taskTitle,
    due_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    assignee_id: agentId,
    created_by: agentId,
  });
  expect(taskErr, taskErr?.message).toBeNull();
  return { ...data!, title, taskTitle, ownerId: owner!.id, ownerName };
}

test("the summary strip: price, availability, owner, agent, next task, mandate and Outstanding — by keyboard, at both widths", async ({
  page,
}, testInfo) => {
  const admin = svc();
  const { id: agentId, orgId } = await fixtureProfile(admin);
  const listing = await seed(admin, orgId, agentId);

  try {
    await page.goto(`/properties/${listing.id}`, { waitUntil: "networkidle" });

    // the tab title: the reference, and nothing a shared device should keep in its history
    await expect(page).toHaveTitle(new RegExp(`^${listing.reference}(\\s|$)`));
    const tabTitle = await page.title();
    expect(tabTitle).not.toContain(listing.title);
    expect(tabTitle).not.toContain(listing.ownerName);

    // the header: the human title beside the reference, the badges named
    await expect(page.locator("h1")).toHaveText(`${listing.reference} ${listing.title}`);
    const header = page.locator("h1").locator("..");
    await expect(header).toContainText("Mandate: Exclusive");
    await expect(header).toContainText("Status: Available");
    await expect(header).toContainText("Visibility: Public");

    const strip = page.getByRole("region", { name: "Summary" });
    await expect(strip).toBeVisible();
    const cell = (name: string) => strip.locator(`[data-summary="${name}"] dd`);
    await expect(cell("price")).toHaveText("€265.000");
    await expect(cell("availability")).toHaveText("Available · on the website");
    await expect(cell("party").getByRole("link", { name: listing.ownerName })).toHaveAttribute(
      "href",
      `/contacts/${listing.ownerId}`,
    );
    await expect(cell("agent")).not.toHaveText(/Not assigned|not visible/);
    await expect(cell("next")).toContainText(`Next task: ${listing.taskTitle} · due `);
    await expect(cell("mandate")).toHaveText("Exclusive · expires 12 Jan 2099");

    // one Add task on the page, beside the next action
    await expect(page.getByRole("button", { name: /add task/i })).toHaveCount(1);
    await expect(cell("next").getByRole("button", { name: /add task/i })).toBeVisible();

    // Outstanding: a count linked to the readiness panel, followed from the keyboard
    const outstanding = cell("outstanding").getByRole("link", { name: /^\d+ items? — see Listing readiness$/ });
    await outstanding.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#listing-readiness$/);
    const panel = page.getByRole("region", { name: "Listing readiness" });
    await expect(panel).toBeInViewport();
    await page.keyboard.press("Tab");
    expect(
      await panel.evaluate((el) => el.contains(document.activeElement)),
      "the next Tab after the link lands inside the readiness panel",
    ).toBe(true);
    // the items are the panel's — the strip only counts them
    await expect(panel).toContainText("cover photo");
    await expect(strip).not.toContainText("cover photo");

    // layout: two columns on a phone, four at desktop width; never a sideways scroll
    const phone = isPhone(testInfo.project.use.viewport?.width ?? 1280);
    const boxes = await Promise.all(
      ["price", "availability", "party", "agent"].map((n) => strip.locator(`[data-summary="${n}"]`).boundingBox()),
    );
    const [price, availability, party, agent] = boxes.map((b) => b!);
    expect(availability.y, "price and availability share the first row").toBeCloseTo(price.y, 0);
    expect(availability.x).toBeGreaterThan(price.x);
    if (phone) {
      expect(party.y, "the third cell starts the second row on a phone").toBeGreaterThan(price.y);
      expect(party.x).toBeCloseTo(price.x, 0);
    } else {
      expect(agent.y, "four cells in the first row at desktop width").toBeCloseTo(price.y, 0);
    }
    await assertNoHorizontalOverflow(page, `property page with the summary strip (${phone ? "phone" : "desktop"})`);
  } finally {
    await admin.from("tasks").delete().eq("property_id", listing.id);
    await admin.from("mandates").delete().eq("property_id", listing.id);
    await admin.from("properties").delete().eq("id", listing.id);
    await admin.from("contacts").delete().eq("id", listing.ownerId);
  }
});
