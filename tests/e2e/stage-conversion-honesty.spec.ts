import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The stage-conversion report, in the browser, when its window holds a
 * malformed `stage_changed` (T-stage-conversion-malformed, migration 0130).
 *
 * Before 0130 one such event made the RPC raise 22P02: the page painted
 * "Nothing in this window." and the CSV export answered 500. Now the valid
 * movement still reports, the malformed one is counted out loud, and a window
 * holding ONLY malformed movements says so instead of looking empty.
 *
 * Fixture: three events written by the service role (the only writer that may
 * set occurred_at since 0128) into two consecutive days of 2003 picked per
 * run, so no other data shares the window. They are left in place — chain
 * events are never deleted (a gap breaks verify_events_chain).
 */
test.skip(!isLocal(), "writes fixture events through the local service role");

const DAY0 = Date.UTC(2003, 0, 1);
const offset = Math.floor(Date.now() / 60_000) % 2900; // a fresh pair of days per run
const dayKey = (n: number) => new Date(DAY0 + n * 86_400_000).toISOString().slice(0, 10);
const MIXED = dayKey(offset);
const ONLY_BAD = dayKey(offset + 1);
const noonUtc = (key: string) => `${key}T12:00:00Z`;

test.beforeAll(async () => {
  const svc = serviceClient();
  const { id: adminId, orgId } = await fixtureProfile(svc);
  const { data: stages } = await svc
    .from("deal_stages")
    .select("id, name, sort_order")
    .eq("org_id", orgId)
    .eq("deal_type", "sale")
    .order("sort_order")
    .limit(2);
  expect(stages?.length, "the seeded org has a sale pipeline").toBe(2);
  const [from, to] = stages!;
  const base = { org_id: orgId, actor_id: adminId, entity_type: "deal", event_type: "stage_changed" };
  const { error } = await svc.from("events").insert([
    // MIXED day: one valid movement and one whose to_stage_id is not a uuid
    {
      ...base,
      entity_id: randomUUID(),
      occurred_at: noonUtc(MIXED),
      payload: { from: from.name, to: to.name, from_stage_id: from.id, to_stage_id: to.id },
    },
    {
      ...base,
      entity_id: randomUUID(),
      occurred_at: noonUtc(MIXED),
      payload: { from: from.name, to: to.name, from_stage_id: from.id, to_stage_id: "x" },
    },
    // ONLY_BAD day: a single movement with a numeric from_stage_id
    {
      ...base,
      entity_id: randomUUID(),
      occurred_at: noonUtc(ONLY_BAD),
      payload: { from: from.name, to: to.name, from_stage_id: 42, to_stage_id: to.id },
    },
  ]);
  expect(error, JSON.stringify(error)).toBeNull();
  stageName = to.name;
});

let stageName = "";

const stageSection = (page: Page) =>
  page.locator("section", { has: page.getByRole("heading", { name: "Stage conversion" }) });

test("a window with a malformed move still reports its valid one, and says what it left out", async ({ page }) => {
  await page.goto(`/reports/performance?from=${MIXED}&to=${MIXED}`);
  const section = stageSection(page);
  await expect(section.getByRole("cell", { name: stageName, exact: true })).toBeVisible();
  const warning = section.getByTestId("stage-conversion-excluded");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("1 stage change in this window has an unreadable stage reference");
  await expect(section.getByText("Nothing in this window.")).toHaveCount(0);
  await expect(section.getByTestId("stage-conversion-error")).toHaveCount(0);
  // the other reports render alongside it
  await expect(page.getByRole("heading", { name: "Agent performance" })).toBeVisible();

  // the CSV still exports, stating the exclusion on its row
  const href = await section.getByRole("link", { name: "Export CSV" }).getAttribute("href");
  expect(href).toContain("report=stage_conversion");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  const [header, row] = (await res.text()).replace(/^﻿/, "").split("\r\n");
  expect(header.endsWith(",From,To,Malformed moves excluded")).toBe(true);
  expect(row.startsWith(`${stageName},1,0,0.0%,`)).toBe(true);
  expect(row.endsWith(`,${MIXED},${MIXED},1`)).toBe(true);
});

test("a window holding only malformed moves is not shown as empty, and its export is refused", async ({ page }) => {
  await page.goto(`/reports/performance?from=${ONLY_BAD}&to=${ONLY_BAD}`);
  const section = stageSection(page);
  const warning = section.getByTestId("stage-conversion-all-excluded");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("The only stage change in this window has an unreadable stage reference");
  await expect(section.getByText("Nothing in this window.")).toHaveCount(0);
  await expect(section.getByRole("table")).toHaveCount(0);
  await expect(section.getByRole("link", { name: "Export CSV" })).toHaveCount(0);

  const res = await page.request.get(
    `/reports/performance/export?from=${ONLY_BAD}&to=${ONLY_BAD}&report=stage_conversion`,
  );
  expect(res.status()).toBe(422);
  expect(((await res.json()) as { error: string }).error).toMatch(/all 1 stage change/);
});
