import { test as setup, expect, type Page } from "@playwright/test";
import { MODULES, fixtureProfile, isLocal, login, serviceClient } from "./helpers";

const AUTH_FILE = "tests/.auth/admin.json";

/**
 * Compile every route the suite touches, once, before any timed test runs.
 *
 * WHY THIS EXISTS. A local run means `next dev`, and `next dev` compiles a route
 * the first time something asks for it — charging that cost to whichever test
 * happens to ask first. Measured on a cold server 2026-08-11, from the dev
 * server's own log:
 *
 *   GET /login/verify        43s   (next.js: 43s, application-code: 328ms)
 *   GET /viewings/<id>/sign  44s
 *   GET /viewings/<id>     31.2s
 *   GET /contacts/export   28.8s
 *
 * Three separate specs failed on that and none of them had a defect:
 * `csp.spec.ts` timed out on two cold navigations and reported
 * `net::ERR_ABORTED; maybe frame was detached?`, `mfa.spec.ts` watched `/login`
 * for 30s because the post-login redirect to `/login/verify` was still
 * compiling, and `slip-pdf-hash.spec.ts` gave up waiting for a slip row while
 * the signing route compiled. Each one reads like a product bug and is not one.
 *
 * Raising timeouts alone does NOT fix this: twelve budgets are hardcoded inside
 * the specs, out of reach of `playwright.config.ts`. Paying the compile cost
 * here is what makes those numbers adequate again. It is not extra work either
 * — the suite compiles these routes regardless; this only moves the cost out of
 * a test that is being timed.
 *
 * NEVER FAILS THE RUN. Warm-up is an optimisation, so a failure here must not
 * take 175 tests with it: every request is caught, and anything slow or broken
 * is printed instead of thrown. `playwright.config.ts` keeps its scaled local
 * budgets as the backstop.
 *
 * CI does not need this. It builds and serves `next start`
 * (.github/workflows/ci.yml), so every route is already compiled and these 27
 * requests just return quickly. The `isLocal()` gate cannot tell the two apart
 * — CI is also 127.0.0.1 — so the cost there is a handful of warm GETs, which
 * is cheaper than teaching the suite to detect a dev server.
 *
 * `page.request` rather than `page.goto`: the expensive half is the server-side
 * compile (43s of `next.js` against 328ms of application code), which a plain
 * GET triggers just as well — and it avoids driving the browser into the
 * `/export` routes, which answer with a file download.
 *
 * KNOWN GAP: `/login/verify` is reachable only when the session actually owes a
 * factor. The seed admin has none during setup, so `proxy.ts` correctly
 * redirects and that route may stay uncompiled — which is precisely the 43s
 * `mfa.spec.ts` trips over, and why the scaled `expect` budget in the config is
 * load-bearing rather than belt-and-braces.
 */
async function warmRoutes(page: Page): Promise<void> {
  // Explicit `string[]`: MODULES is `as const`, so mapping it yields a union of
  // literal paths that nothing else can be pushed onto.
  const paths: string[] = MODULES.map((m) => m.path);

  // Routes the module list does not cover, gathered from the specs themselves.
  paths.push(
    "/security",
    "/login/verify",
    "/route-sheet",
    "/properties/new",
    "/contacts/new",
    "/settings/retention",
    "/settings/users",
    "/reports/commission-evidence",
    "/properties/export",
    "/contacts/export",
    "/pipeline/export",
  );

  // Dynamic routes need a real id, and they are the slowest ones to compile.
  // Paths whose id is not in the admin's org: they still compile, but the app
  // answers 404, so the report can say so rather than look like a defect.
  const compiledVia404 = new Set<string>();

  try {
    const svc = serviceClient();
    const { orgId } = await fixtureProfile(svc);

    /**
     * Prefer a record in the signed-in admin's own org — that renders a real
     * page, which is unambiguously a compile.
     *
     * Fall back to ANY record when the org has none. A 404 still compiles the
     * route on the way to deciding it is a 404 (measured: 14.6–27.8s of compile
     * before the 404 came back), and these are the two most expensive routes in
     * the suite — `/viewings/<id>` at 31.2s and `/viewings/<id>/sign` at 44s.
     * Warming them imperfectly beats leaving them cold: `/sign` going cold is
     * what broke `slip-pdf-hash.spec.ts`, whose 30s wait is hardcoded and so
     * cannot be rescued by the config.
     *
     * The fallback is the NORMAL path for viewings against local seed data,
     * which has none in the admin's org (checked 2026-08-11: 4 properties,
     * 4 contacts, 0 viewings). Scoping strictly would have regressed the exact
     * tests this warm-up exists to fix.
     */
    const pick = async (table: string): Promise<{ id: string; scoped: boolean } | null> => {
      const scoped = await svc.from(table).select("id").eq("org_id", orgId).limit(1);
      const scopedId = scoped.data?.[0]?.id as string | undefined;
      if (scopedId) return { id: scopedId, scoped: true };

      const anyRow = await svc.from(table).select("id").limit(1);
      const anyId = anyRow.data?.[0]?.id as string | undefined;
      return anyId ? { id: anyId, scoped: false } : null;
    };

    const [property, contact, viewing] = await Promise.all([
      pick("properties"),
      pick("contacts"),
      pick("viewings"),
    ]);

    const add = (path: string, scoped: boolean) => {
      paths.push(path);
      if (!scoped) compiledVia404.add(path);
    };

    if (property) add(`/properties/${property.id}`, property.scoped);
    if (contact) add(`/contacts/${contact.id}`, contact.scoped);
    if (viewing) {
      add(`/viewings/${viewing.id}`, viewing.scoped);
      add(`/viewings/${viewing.id}/sign`, viewing.scoped);
    }
  } catch (err) {
    console.log(`[warm-up] could not resolve record ids: ${(err as Error).message}`);
  }

  const notable: string[] = [];
  for (const path of paths) {
    const startedAt = Date.now();
    try {
      // Generous per-request ceiling: 44s was the worst measured compile, and
      // compile time is not stable run to run.
      const res = await page.request.get(path, { timeout: 180_000, maxRedirects: 5 });
      const seconds = (Date.now() - startedAt) / 1000;
      const took = `${seconds.toFixed(1)}s`;
      if (res.status() === 404 && compiledVia404.has(path)) {
        // Expected: no such record in this org. The compile still happened,
        // which is the only thing this function is here for.
        notable.push(`${path} — ${took} (compiled; 404, no record in admin's org)`);
      } else if (!res.ok()) {
        notable.push(`${path} — HTTP ${res.status()} after ${took}`);
      } else if (seconds > 5) {
        notable.push(`${path} — ${took}`);
      }
    } catch (err) {
      notable.push(`${path} — ${(err as Error).message.split("\n")[0]}`);
    }
  }

  console.log(
    notable.length
      ? `[warm-up] ${paths.length} routes compiled; first-compile cost paid here:\n  ${notable.join("\n  ")}`
      : `[warm-up] ${paths.length} routes already warm`,
  );
}

/**
 * Logs in once and stores the Supabase session cookies for every other
 * project to reuse. Runs as a Playwright `dependency`, so a credential
 * problem fails here with a clear message instead of failing 40 specs.
 */
setup("authenticate as admin", async ({ page }) => {
  // Cold, this test logs in AND compiles the whole route surface below.
  setup.setTimeout(900_000);

  await login(page);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });

  // After the session is stored, so a warm-up problem can never be mistaken for
  // a credential problem. Deployed targets serve a prebuilt app — nothing to do.
  if (isLocal()) await warmRoutes(page);
});
