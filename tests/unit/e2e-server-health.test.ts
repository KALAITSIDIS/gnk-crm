import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertServingCurrentBuild,
  extractScriptSrcs,
  staleServerReport,
  StaleServerError,
  type ChunkProbe,
} from "../e2e/server-health";

/**
 * The E2E stale-server guard, exercised through its FAILING path.
 *
 * `tests/e2e/server-health.ts` protects the suite from the 2026-08-11 incident
 * (`docs/DECISIONS.md` `T-e2e-cold-server`): a leftover `next start` serving
 * manifests cached at boot, against a `.next` that had since been rebuilt, so 6
 * of 22 chunks answered `500 text/plain` and nothing on any page hydrated.
 *
 * The guard was proven by hand against a real stale server before it shipped —
 * built, started `next start -p 3401`, rebuilt underneath it, watched 2 of 16
 * chunks turn into `500 text/plain` including the Turbopack runtime, and watched
 * the guard fail. **These tests exist so nobody has to redo that.** A guard whose
 * failure path is only ever exercised by hand is one refactor away from silently
 * passing forever, and this repo's standard is that a guard nobody has watched
 * fail is not a guard (`T-aal2-rls` proved two of them by breaking them).
 *
 * The chunk names below are the real ones from that reproduction, not invented.
 */

const STALE_CHUNK = "/_next/static/chunks/3l_bz1ut923fg.js";
const STALE_RUNTIME = "/_next/static/chunks/turbopack-1qu1bx-0d_5wm.js";
const LIVE_CHUNK = "/_next/static/chunks/1gdpaddb8g4_s.js";

/** Shaped like what `next start` actually emits: nonce before src, no quotes fuss. */
const HTML = `<!DOCTYPE html><html><body><script src="${LIVE_CHUNK}" async></script>`
  + `<script nonce="6b0c0871" src="${STALE_CHUNK}" async></script>`
  + `<script src="${STALE_RUNTIME}" async></script></body></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch that serves HTML for pages and looks each chunk up in `disk`. */
function fakeServer(html: string, disk: Record<string, { status: number; type: string }>) {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(input.toString());
    if (!url.pathname.startsWith("/_next/")) {
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    const hit = disk[url.pathname];
    if (!hit) throw new Error(`test bug: unmapped chunk ${url.pathname}`);
    return new Response("", { status: hit.status, headers: { "content-type": hit.type } });
  });
}

const JS = { status: 200, type: "application/javascript; charset=UTF-8" };
/** Exactly what the real stale server answered — status AND content-type. */
const GONE = { status: 500, type: "text/plain" };

describe("extractScriptSrcs", () => {
  it("takes src regardless of attribute order or quote style", () => {
    expect(
      extractScriptSrcs(
        `<script src="/a.js"></script><script nonce="x" src='/b.js' defer></script>`,
      ),
    ).toEqual(["/a.js", "/b.js"]);
  });

  it("leaves percent-encoded dev chunk names untouched", () => {
    // `next dev` really serves these (measured 2026-08-11). Re-encoding them
    // turns a working URL into a 404 and the guard would cry wolf.
    const dev = `<script src="/_next/static/chunks/node_modules_%40sentry_core_build_esm_0rdh97r._.js"></script>`
      + `<script src="/_next/static/chunks/%5Bturbopack%5D_browser_dev_hmr-client_hmr-client_ts_0_7kopu._.js"></script>`;
    expect(extractScriptSrcs(dev)).toEqual([
      "/_next/static/chunks/node_modules_%40sentry_core_build_esm_0rdh97r._.js",
      "/_next/static/chunks/%5Bturbopack%5D_browser_dev_hmr-client_hmr-client_ts_0_7kopu._.js",
    ]);
  });

  it("decodes &amp; but not percent escapes", () => {
    expect(extractScriptSrcs(`<script src="/c.js?a=1&amp;b=2"></script>`)).toEqual([
      "/c.js?a=1&b=2",
    ]);
  });

  it("ignores inline scripts and finds nothing in script-free HTML", () => {
    expect(extractScriptSrcs(`<script>console.log(1)</script><p>hi</p>`)).toEqual([]);
  });
});

describe("assertServingCurrentBuild — stale server", () => {
  it("fails when chunks the page asks for are 500 text/plain", async () => {
    vi.stubGlobal(
      "fetch",
      fakeServer(HTML, { [LIVE_CHUNK]: JS, [STALE_CHUNK]: GONE, [STALE_RUNTIME]: GONE }),
    );

    await expect(assertServingCurrentBuild("http://localhost:3000")).rejects.toThrow(
      StaleServerError,
    );
  });

  it("fails on a 200 that is not JavaScript — the content-type is half the tell", async () => {
    // A server can answer 200 with an HTML error page. Status alone would pass it.
    vi.stubGlobal(
      "fetch",
      fakeServer(HTML, {
        [LIVE_CHUNK]: JS,
        [STALE_CHUNK]: JS,
        [STALE_RUNTIME]: { status: 200, type: "text/html; charset=utf-8" },
      }),
    );

    await expect(assertServingCurrentBuild("http://localhost:3000")).rejects.toThrow(
      /turbopack/i,
    );
  });

  it("fails when the page ships no chunks at all", async () => {
    vi.stubGlobal("fetch", fakeServer(`<!DOCTYPE html><html><body>ok</body></html>`, {}));
    await expect(assertServingCurrentBuild("http://localhost:3000")).rejects.toThrow(
      /no <script src> at all/,
    );
  });

  it("fails when the probe page is not 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 502 })),
    );
    await expect(assertServingCurrentBuild("http://localhost:3000")).rejects.toThrow(
      /answered HTTP 502/,
    );
  });
});

describe("assertServingCurrentBuild — healthy server", () => {
  it("passes when every chunk is 200 JavaScript, and says which server it trusted", async () => {
    vi.stubGlobal(
      "fetch",
      fakeServer(HTML, { [LIVE_CHUNK]: JS, [STALE_CHUNK]: JS, [STALE_RUNTIME]: JS }),
    );

    const summary = await assertServingCurrentBuild("http://localhost:3000");
    expect(summary).toContain("serves its own build: 3 of 3");
  });

  it("accepts text/javascript too", async () => {
    const t = { status: 200, type: "text/javascript" };
    vi.stubGlobal("fetch", fakeServer(HTML, { [LIVE_CHUNK]: t, [STALE_CHUNK]: t, [STALE_RUNTIME]: t }));
    await expect(assertServingCurrentBuild("http://localhost:3000")).resolves.toContain("3 of 3");
  });
});

/**
 * The message is as much the deliverable as the check — the original cost an A/B
 * bisect across two branches and a wrongly accused migration. These assertions
 * are the contract: cause named, fix given, wrong turn closed.
 */
describe("staleServerReport", () => {
  const bad: ChunkProbe[] = [
    { src: STALE_CHUNK, status: 500, contentType: "text/plain" },
    { src: STALE_RUNTIME, status: 500, contentType: "text/plain" },
  ];
  const report = staleServerReport({
    baseURL: "http://localhost:3000",
    probePath: "/login",
    total: 16,
    bad,
    buildId: "nP3MjJdsu0Ji8eOQKUorb",
    buildIdInHtml: false,
  });

  it("counts the damage and shows status plus content-type per chunk", () => {
    expect(report).toContain("of the 16 <script src> chunks /login asks for itself");
    expect(report).toContain("2 did not come back as JavaScript");
    expect(report).toContain(`500 text/plain  ${STALE_CHUNK}`);
  });

  it("names the cause rather than describing the symptom", () => {
    expect(report).toMatch(/a `next start` left over from a production check/);
    expect(report).toMatch(/caches its build manifests at boot/);
  });

  it("calls out the Turbopack runtime, which is why the symptom is total", () => {
    expect(report).toContain("TURBOPACK RUNTIME");
  });

  it("gives a runnable way to find and kill the process on the right port", () => {
    expect(report).toContain("Get-NetTCPConnection -State Listen -LocalPort 3000");
    expect(report).toContain("Stop-Process -Id <pid> -Force");
    expect(report).toContain("lsof -i :3000");
    expect(report).toContain("npm run dev");
  });

  it("closes the wrong turn: deleting reuseExistingServer breaks CI", () => {
    expect(report).toContain("NOT THE FIX");
    expect(report).toContain("reuseExistingServer: true");
    expect(report).toContain("ci.yml");
  });

  it("points at the write-ups instead of restating them", () => {
    expect(report).toContain("T-e2e-cold-server");
    expect(report).toContain("HANDOFF §7");
  });

  it("qualifies the BUILD_ID signal, because next dev never emits one", () => {
    // Absence of BUILD_ID in the HTML is TRUE of a healthy dev server too
    // (measured 2026-08-11: 0 occurrences on :3400). If the message did not say
    // so, the next reader would promote it to a criterion and fail every local
    // run — which is exactly what T-e2e-cold-server §1 invites.
    expect(report).toMatch(/healthy `next dev` server never mentions it either/);
    expect(report).toContain("Absence alone proves nothing");
  });

  it("does not read a small chunk delta as reassurance", () => {
    // The stale-server proof moved only 2 of 61 chunk filenames, and one was the
    // Turbopack runtime. Blast radius is not proportional to build delta.
    const present = staleServerReport({
      baseURL: "http://localhost:3000",
      probePath: "/login",
      total: 16,
      bad,
      buildId: "nP3MjJdsu0Ji8eOQKUorb",
      buildIdInHtml: true,
    });
    expect(present).toContain("DOES mention it");
    expect(present).toMatch(/do not read "only a few moved" as "mostly fine"/);
  });

  it("uses the port from the base URL, not a hardcoded 3000", () => {
    const other = staleServerReport({
      baseURL: "http://127.0.0.1:3401",
      probePath: "/login",
      total: 16,
      bad,
      buildId: null,
      buildIdInHtml: false,
    });
    expect(other).toContain("-LocalPort 3401");
    expect(other).toContain("lsof -i :3401");
    expect(other).toContain("no build to compare against");
  });
});
