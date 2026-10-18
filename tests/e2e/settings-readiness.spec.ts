import { test, expect } from "@playwright/test";
import {
  assertNoHorizontalOverflow,
  assertNoProblems,
  assertShellRendered,
  isLocal,
  serviceClient,
  watchForProblems,
} from "./helpers";

/**
 * Settings → Overview: activation readiness (A07, /settings — was a redirect
 * to /settings/organization).
 *
 * The rows' rules and the no-env-value guarantee are pinned by
 * lib/services/activation-readiness.test.ts and
 * tests/unit/settings-overview-page.test.ts (sentinel values through the real
 * page). This spec covers what only the running app can prove: the page
 * renders at both widths with every row, the provider's answer has streamed
 * in, nothing on it can be submitted, the nav marks Overview current, and a
 * row's link reaches its settings page.
 *
 * Runs in the desktop AND mobile projects. The first test only reads; the
 * second sets lead_routing off and puts it back — local only.
 */

const ROW_IDS = [
  "lead-routing",
  "lead-escalation",
  "desk-alert",
  "sending-domain",
  "visitor-ack",
  "site-refresh",
  "portals",
  "logo",
  "watermark",
];

/** Values that must never reach the page, when the test process happens to hold them. */
const ENV_VALUES = [
  "RESEND_API_KEY",
  "CRON_SECRET",
  "IP_HASH_SALT",
  "ENQUIRY_FORWARD_KEY",
  "SITE_REVALIDATE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
]
  .map((name) => process.env[name])
  .concat((process.env.ENQUIRY_ALERT_TO ?? "").split(",").map((s) => s.trim()))
  .filter((v): v is string => typeof v === "string" && v.length >= 6);

test.describe("Settings → Overview (activation readiness)", () => {
  test("renders every row, read-only, with no environment value", async ({ page }) => {
    const problems = watchForProblems(page);
    const response = await page.goto("/settings", { waitUntil: "networkidle" });
    expect(response?.status()).toBeLessThan(400);
    expect(new URL(page.url()).pathname, "/settings no longer redirects").toBe("/settings");
    await assertShellRendered(page);

    const overview = page.getByTestId("settings-readiness");
    await expect(overview.getByRole("heading", { name: "Activation readiness" })).toBeVisible();
    for (const id of ROW_IDS) await expect(overview.getByTestId(`readiness-${id}`), id).toBeVisible();
    // the provider's answer has replaced the Suspense fallback
    await expect(overview.locator('[data-state="checking"]')).toHaveCount(0);

    await expect(
      page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Overview" }),
    ).toHaveAttribute("aria-current", "page");

    // nothing on the page can switch anything on
    await expect(overview.locator("form, button, input, select, textarea")).toHaveCount(0);

    await expect(overview.getByTestId("readiness-portals")).toContainText("RERA.cy and Thribee");
    await expect(overview.getByTestId("readiness-portals").getByRole("link", { name: /Open Portals/ })).toHaveAttribute(
      "href",
      "/settings/portals",
    );

    if (isLocal()) {
      // the local stack and CI set no ENQUIRY_ALERT_TO: the desk alert cannot be armed
      await expect(overview.getByTestId("readiness-desk-alert").getByTestId("readiness-pill")).toHaveText(
        "Needs setup outside the CRM",
      );
    }

    // the technical details list names, never values
    await overview.getByTestId("readiness-technical").locator("summary").click();
    await expect(overview.getByTestId("readiness-env-RESEND_API_KEY")).toBeVisible();
    const text = await overview.innerText();
    expect(text).not.toMatch(/\bre_[A-Za-z0-9]{8,}/);
    const html = await page.content();
    for (const value of ENV_VALUES) expect(html.includes(value), "an environment value reached the page").toBe(false);

    await assertNoHorizontalOverflow(page, "settings overview");
    assertNoProblems(problems, "settings overview");
  });

  test("Lead routing off reads Off with the admin's next step, and its link reaches Lead routing", async ({ page }) => {
    test.skip(!isLocal(), "sets cyprus_config.lead_routing — local only, never production");
    const svc = serviceClient();
    const { data: before } = await svc.from("cyprus_config").select("value").eq("key", "lead_routing").maybeSingle();
    await svc.from("cyprus_config").update({ value: { mode: "off", agents: [] } }).eq("key", "lead_routing");
    try {
      await page.goto("/settings", { waitUntil: "networkidle" });
      const row = page.getByTestId("readiness-lead-routing");
      await expect(row).toHaveAttribute("data-state", "off");
      await expect(row.getByTestId("readiness-pill")).toHaveText("Off");
      await expect(row).toContainText("Next step — Admin, in the CRM");
      await row.getByRole("link", { name: /Open Lead routing/ }).click();
      await expect(page).toHaveURL(/\/settings\/lead-routing$/);
    } finally {
      if (before) await svc.from("cyprus_config").update({ value: before.value }).eq("key", "lead_routing");
    }
  });
});
