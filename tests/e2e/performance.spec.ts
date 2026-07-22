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
   * FINDING PERF-2: /leads, /viewings, /tasks and /keys apply a hard .limit()
   * (100 / 500 / 200 / 300) with NO pagination and NO "showing X of Y" notice,
   * while their headers show EXACT counts. Past the cap the header and the
   * visible rows silently disagree — the same class of defect as the
   * 2026-07-21 list-scope fix, but triggered by volume instead of status.
   *
   * This test documents the current ceiling. It passes today because the seed
   * is small; it is here so the assertion exists when the desk grows.
   */
  test("[PERF-2] capped lists disclose their cap or stay under it", async ({ page }) => {
    const capped = [
      { path: "/leads", cap: 100 },
      { path: "/viewings", cap: 500 },
      { path: "/tasks", cap: 200 },
      { path: "/keys", cap: 300 },
    ];

    for (const { path, cap } of capped) {
      await page.goto(path, { waitUntil: "networkidle" });
      const text = await page.locator("main").innerText();
      const rows = await page.locator("main li, main tr").count();

      if (rows >= cap) {
        // At the cap the UI MUST say so, otherwise records are invisible.
        expect(
          text,
          `${path} is at its ${cap}-row cap with no pagination or disclosure`,
        ).toMatch(/showing|page \d|more|next/i);
      }
    }
  });
});
