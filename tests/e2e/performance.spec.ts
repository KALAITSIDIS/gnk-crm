import { test, expect, type Page } from "@playwright/test";

/**
 * Performance measurement (audit brief Phase 4).
 *
 * Uses the browser's own Web Vitals instrumentation rather than Lighthouse:
 * every heavy page in this app is behind auth, and driving Lighthouse through
 * a logged-in session on the CLIENT'S PRODUCTION deployment would mean
 * handling production credentials. This runs the same metrics against the
 * local stack, is re-runnable in CI, and never touches live data.
 *
 * Thresholds are deliberately generous — they exist to catch a REGRESSION
 * (a page that suddenly doubles in weight), not to certify a Lighthouse score.
 */

interface Vitals {
  lcp: number;
  cls: number;
  longTasks: number;
  domContentLoaded: number;
  transferBytes: number;
  requests: number;
}

async function measure(page: Page, path: string): Promise<Vitals> {
  let transferBytes = 0;
  let requests = 0;
  page.on("response", (res) => {
    requests++;
    const len = Number(res.headers()["content-length"] ?? 0);
    if (Number.isFinite(len)) transferBytes += len;
  });

  await page.goto(path, { waitUntil: "networkidle" });

  return page.evaluate(async () => {
    /**
     * LCP / CLS / longtask entries are NOT retrievable via
     * getEntriesByType after the fact — they only reach a PerformanceObserver,
     * and only one created with `buffered: true` sees the ones already
     * emitted. Collect them that way, then wait a beat for stragglers.
     */
    const collect = (type: string): Promise<PerformanceEntry[]> =>
      new Promise((resolve) => {
        const seen: PerformanceEntry[] = [];
        try {
          const obs = new PerformanceObserver((list) => seen.push(...list.getEntries()));
          obs.observe({ type, buffered: true });
          setTimeout(() => {
            obs.disconnect();
            resolve(seen);
          }, 600);
        } catch {
          resolve([]); // entry type unsupported in this browser
        }
      });

    const [lcpEntries, shiftEntries, taskEntries] = await Promise.all([
      collect("largest-contentful-paint"),
      collect("layout-shift"),
      collect("longtask"),
    ]);

    const lcp = lcpEntries.length ? lcpEntries[lcpEntries.length - 1].startTime : 0;
    const cls = shiftEntries
      .filter((e) => !(e as unknown as { hadRecentInput: boolean }).hadRecentInput)
      .reduce((sum, e) => sum + (e as unknown as { value: number }).value, 0);
    const longTasks = taskEntries.length;
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;

    return {
      lcp,
      cls,
      longTasks,
      domContentLoaded: nav?.domContentLoadedEventEnd ?? 0,
      transferBytes: 0,
      requests: 0,
    };
  }).then((v) => ({ ...v, transferBytes, requests }));
}

// The three heaviest screens named in the audit brief.
const HEAVY_PAGES = [
  { name: "Dashboard", path: "/dashboard" },
  { name: "Properties", path: "/properties" },
  { name: "Reports", path: "/reports" },
];

test.describe("page weight and Web Vitals", () => {
  for (const { name, path } of HEAVY_PAGES) {
    test(`${name} — vitals within regression budget`, async ({ page }) => {
      const v = await measure(page, path);

      console.log(
        `[perf] ${name}: LCP=${Math.round(v.lcp)}ms CLS=${v.cls.toFixed(3)} ` +
          `longTasks=${v.longTasks} DCL=${Math.round(v.domContentLoaded)}ms ` +
          `transfer=${(v.transferBytes / 1024).toFixed(0)}KB reqs=${v.requests}`,
      );

      // CLS is the one metric a dev server does not distort — hold it tight.
      expect(v.cls, `${name}: layout shifts (CLS)`).toBeLessThan(0.1);
      // Generous ceiling: dev-mode LCP includes on-demand compilation.
      expect(v.lcp, `${name}: LCP regression`).toBeLessThan(15_000);
    });
  }
});

test.describe("scale safeguards", () => {
  test("Properties list paginates rather than rendering every row", async ({ page }) => {
    await page.goto("/properties", { waitUntil: "networkidle" });
    const rowCount = await page.locator("main a[href^='/properties/']").count();
    // PROPERTIES_PAGE_SIZE caps the page; the list must never dump the table.
    expect(rowCount, "properties list rendered an unbounded number of rows").toBeLessThan(100);
  });

  test("Contacts list paginates", async ({ page }) => {
    await page.goto("/contacts", { waitUntil: "networkidle" });
    const rowCount = await page.locator("main a[href^='/contacts/']").count();
    expect(rowCount, "contacts list rendered an unbounded number of rows").toBeLessThan(100);
  });

  /**
   * FINDING PERF-2 (fixed 2026-07-22). /leads, /tasks and /keys applied a hard
   * .limit() with no pagination and no disclosure, while their headers showed
   * EXACT counts — past the cap the header and the visible rows silently
   * disagreed and the remainder was unreachable. They now page.
   */
  test("[PERF-2] list screens state their range and total", async ({ page }) => {
    for (const path of ["/leads", "/tasks", "/keys"]) {
      await page.goto(path, { waitUntil: "networkidle" });
      const text = await page.locator("main").innerText();

      // The Pager renders nothing at all when the list is genuinely empty —
      // "Showing 0–0 of 0" would be noise, and an empty state already says it.
      // On a freshly reset database every list is empty, so assert the
      // disclosure only when there is something to disclose.
      const hasRows = (await page.locator("main li, main tbody tr").count()) > 0;
      if (!hasRows) {
        expect(text, `${path} is empty but shows no empty state`).toMatch(
          /no |none|nothing|inbox zero/i,
        );
        continue;
      }

      // "Showing 1–25 of 437 leads" — the disclosure half of the fix.
      expect(text, `${path} does not disclose its range and total`).toMatch(
        /showing\s+\d+[–-]\d+\s+of\s+\d+/i,
      );
    }
  });

  test("[PERF-2] a page beyond the end is an empty page, not a crash", async ({ page }) => {
    for (const path of ["/leads", "/tasks", "/keys"]) {
      const response = await page.goto(`${path}?page=9999`, { waitUntil: "networkidle" });
      expect(response?.status(), `${path}?page=9999 status`).toBeLessThan(400);
      // must render the shell + an empty-page message, never the error boundary
      await expect(page.locator("main")).toBeVisible();
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
      await expect(page.getByText(/nothing on this page|none on this page/i).first()).toBeVisible();
    }
  });

  test("[PERF-2] a junk ?page= degrades to page 1 rather than throwing", async ({ page }) => {
    for (const junk of ["abc", "-1", "0", ""]) {
      const response = await page.goto(`/leads?page=${junk}`, { waitUntil: "networkidle" });
      expect(response?.status(), `?page=${junk} status`).toBeLessThan(400);
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    }
  });

  test("[PERF-2] paging preserves the active filter", async ({ page }) => {
    await page.goto("/leads?status=all", { waitUntil: "networkidle" });
    const next = page.getByRole("link", { name: /next/i });
    if ((await next.count()) === 0) {
      test.skip(true, "seed has fewer leads than one page — nothing to page through");
    }
    await next.first().click();
    await page.waitForURL(/page=2/);
    expect(page.url(), "the status filter was dropped when paging").toContain("status=all");
  });

  test("[PERF-2] the keys filter searches the whole register, not just the page", async ({
    page,
  }) => {
    // The filter moved from client useState into the URL for exactly this
    // reason; a client-side filter over a paged array searches one page only.
    await page.goto("/keys", { waitUntil: "networkidle" });
    await expect(page.getByLabel(/search keys/i)).toBeVisible();
    await page.getByLabel(/search keys/i).fill("zzz-no-such-key-zzz");
    await page.waitForURL(/q=zzz/, { timeout: 10_000 });
    await expect(page.getByText(/no keys match/i)).toBeVisible();
  });

  test("[PERF-2] the viewings calendar bounds its window and discloses truncation", async ({
    page,
  }) => {
    await page.goto("/viewings", { waitUntil: "networkidle" });
    const text = await page.locator("main").innerText();
    // Either it fits the window (no banner) or it says what it is hiding.
    if (/showing the first/i.test(text)) {
      expect(text).toMatch(/not on this calendar/i);
    }
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  });
});
