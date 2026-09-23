import { test, expect } from "@playwright/test";
import { assertNoProblems, fixtureProfile, isLocal, opTimeout, runTag, serviceClient, watchForProblems } from "./helpers";

/**
 * An ERASED contact stays archived (T-refuse-unarchive-erased), end to end in
 * the running app.
 *
 * GDPR erasure keeps the name, e-mail and phone (identity is retained for
 * AML) and parks the contact as archived. Unarchiving it used to put that
 * identity back into use — the phone/e-mail slot under the partial unique
 * indexes, the duplicate check, the contact picker. Now the contact page
 * offers no Unarchive on an erased contact, and `unarchiveContact` refuses
 * one whatever the page showed.
 *
 * The first test is the control: an archived contact that was NOT erased
 * still unarchives through the same button, so the others cannot pass by the
 * button having vanished for everyone — and it runs the action's new
 * `erased_at is null` condition against the real database.
 *
 * Local only: the contacts are seeded through the service client, as erasure
 * would leave them, and removed afterwards (events stay — the chain is
 * append-only).
 */
const svc = serviceClient();
const made: string[] = [];

const ERASED_SENTENCE = "This contact's personal data was erased under GDPR Article 17 — it stays archived.";

test.beforeEach(async () => {
  test.skip(!isLocal(), "write flows are local-only — never run against production data");
});

test.afterAll(async () => {
  if (!isLocal() || made.length === 0) return;
  const removed = await svc.from("contacts").delete({ count: "exact" }).in("id", made);
  expect(removed.error, `fixture delete: ${removed.error?.message}`).toBeNull();
});

async function archivedContact(last: string, over: Record<string, unknown> = {}) {
  const { orgId } = await fixtureProfile(svc);
  const { data, error } = await svc
    .from("contacts")
    .insert({ org_id: orgId, contact_kind: "person", first_name: "Unarchive", last_name: last, is_archived: true, ...over })
    .select("id")
    .single();
  if (error) throw new Error(`seeding a contact: ${error.message}`);
  made.push(data.id);
  return data.id as string;
}

async function contactRow(id: string) {
  const { data, error } = await svc.from("contacts").select("is_archived, erased_at").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data;
}

async function unarchivedEvents(id: string) {
  const { data, error } = await svc
    .from("events")
    .select("id")
    .eq("entity_type", "contact")
    .eq("entity_id", id)
    .eq("event_type", "unarchived");
  if (error) throw new Error(error.message);
  return data;
}

test("an archived contact that was not erased still unarchives — the control", async ({ page }) => {
  const id = await archivedContact(`Control-${runTag()}`);
  const problems = watchForProblems(page);
  await page.goto(`/contacts/${id}`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Unarchive", exact: true }).click();
  await expect(page.locator("[data-sonner-toast]", { hasText: "Contact unarchived" })).toBeVisible({
    timeout: opTimeout(20_000),
  });
  expect((await contactRow(id)).is_archived).toBe(false);
  expect(await unarchivedEvents(id), "one event for the unarchive that happened").toHaveLength(1);
  // the page redraws with the contact active again
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible({ timeout: opTimeout(20_000) });
  assertNoProblems(problems, "contact detail (unarchive)");
});

test("an erased contact offers no Unarchive", async ({ page }) => {
  const id = await archivedContact(`Erased-${runTag()}`, { erased_at: new Date().toISOString() });
  const problems = watchForProblems(page);
  await page.goto(`/contacts/${id}`, { waitUntil: "networkidle" });

  // the page is the erased one, fully drawn, before absence is asserted
  await expect(page.getByText("Personal data erased under GDPR Article 17")).toBeVisible();
  await expect(page.getByRole("button", { name: "Unarchive", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
  assertNoProblems(problems, "contact detail (erased)");
});

test("an erasure landing after the page was drawn is refused, not undone", async ({ page }) => {
  const id = await archivedContact(`Raced-${runTag()}`);
  const problems = watchForProblems(page);
  await page.goto(`/contacts/${id}`, { waitUntil: "networkidle" });
  const unarchive = page.getByRole("button", { name: "Unarchive", exact: true });
  await expect(unarchive).toBeVisible();

  // meanwhile, an admin erases it (the page still shows Unarchive)
  const { error } = await svc.from("contacts").update({ erased_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);

  await unarchive.click();
  await expect(page.locator("[data-sonner-toast]", { hasText: ERASED_SENTENCE })).toBeVisible({
    timeout: opTimeout(20_000),
  });
  const row = await contactRow(id);
  expect(row.is_archived, "the erased contact stays archived").toBe(true);
  expect(row.erased_at).not.toBeNull();
  expect(await unarchivedEvents(id), "a refused unarchive logs nothing").toEqual([]);
  assertNoProblems(problems, "contact detail (erased meanwhile)");
});
