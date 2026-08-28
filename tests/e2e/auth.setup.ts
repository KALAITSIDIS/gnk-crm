import { test as setup, expect, type Page } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  LOCAL_ANON_KEY,
  LOCAL_SUPABASE_URL,
  MODULES,
  baseUrl,
  fixtureProfile,
  isLocal,
  login,
  serviceClient,
} from "./helpers";
import { createClient } from "@supabase/supabase-js";
import { MFA_REQUIRED } from "@/lib/constants/mfa";
import { clearFactors, enrolAndVerify } from "@/lib/testing/mfa";
import { assertServingCurrentBuild } from "./server-health";

const AUTH_FILE = "tests/.auth/admin.json";

/**
 * SERIAL, so a failed precondition skips what follows instead of merely being
 * recorded next to it.
 *
 * Without this, Playwright treats the two setup tests as independent: on the
 * stale server used to prove the guard (2026-08-11) the guard failed in 268ms and
 * `authenticate as admin` then ran anyway and **PASSED in 18.6s**, warming 27
 * routes on a server whose build did not exist. It passed because logging in is a
 * server-action form POST and a redirect — neither needs a hydrated page. That is
 * worth knowing on its own: **the auth step cannot detect this fault**, which is
 * why the guard is a separate test above it rather than an assertion inside it.
 *
 * Serial mode re-runs the whole group on retry. That costs 0.3s here (the guard)
 * and is not a concern; `retries` is only 1, and only in CI.
 */
setup.describe.configure({ mode: "serial" });

/**
 * FIRST, before anything else in the run: is the server on the base URL serving
 * the build that is on disk?
 *
 * `playwright.config.ts` has `reuseExistingServer: true`, and Playwright only
 * checks that *something* answers the base URL. On 2026-08-11 that something was
 * a `next start` left from the previous evening's production check, serving
 * manifests it had cached at boot against a `.next` that had since been rebuilt.
 * Six of 22 chunks 500'd as `text/plain`, the Turbopack runtime among them, so
 * nothing hydrated and `mfa.spec.ts` was reported as a broken 2FA enrolment
 * flow. Enrolment was fine. Mechanism and cost in `docs/DECISIONS.md`
 * `T-e2e-cold-server`; the check itself is in `server-health.ts`.
 *
 * WHY IT LIVES HERE, declared above the auth step. `setup` is already a
 * dependency of both `desktop` and `mobile`, so a failure here skips all 177
 * tests instead of letting them produce ~177 misleading results — and Playwright
 * runs the tests in a file in declaration order under `fullyParallel: false`, so
 * being first is enough. Before `login()` matters too: on a non-hydrating server
 * the login submit itself does nothing, and "could not log in" is exactly the
 * kind of plausible-but-wrong symptom this guard exists to pre-empt. No config
 * change was needed to place it, which is worth something on a file that changed
 * four times on 2026-08-11.
 *
 * UNLIKE `warmRoutes` BELOW, THIS ONE IS ALLOWED TO FAIL THE RUN. Warm-up is an
 * optimisation and swallows its errors; this is a correctness precondition. A
 * suite that cannot say which server it tested has not tested anything.
 *
 * Deployed targets are exempt: `isLocal()` is false there, the base URL serves a
 * prebuilt app nobody is rebuilding underneath, and there is no local `.next` to
 * compare against. Note that CI is NOT exempt — it is 127.0.0.1 — and that is
 * deliberate: CI serves `next start`, which is the exact process type that goes
 * stale, and the guard is written to be dev/prod-agnostic for that reason.
 */
setup("server is serving the build on disk", async () => {
  setup.skip(!isLocal(), "deployed target: no local build to have gone stale");
  // Seconds warm; the ceiling only matters if a cold `next dev` has to compile
  // /login first (measured 5.7s warm, and route compiles reach 44s cold).
  setup.setTimeout(180_000);
  console.log(await assertServingCurrentBuild(baseUrl()));
});

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
/**
 * WITH MANDATORY 2FA ON, LOGGING IN IS NO LONGER JUST A PASSWORD.
 *
 * `MFA_REQUIRED` makes the proxy send a factor-less session to /security, so the
 * seed admin — who has never had a factor — would never reach the Dashboard,
 * and this step is a `dependency` of every project. That is the measured "all
 * 204 E2E tests fall" half of the flip.
 *
 * So the harness enrols one, for real, every run.
 *
 * WHY IT CLEARS FIRST. `enroll()` returns the shared secret exactly once. A run
 * that enrolled and stopped there would meet, on the next run, a user owing a
 * factor whose secret nobody kept — an unanswerable challenge, and a harness
 * locked out of its own fixture. Unenrolling from the user's own session needs
 * aal2, which needs that same secret, so the escape has to come from outside:
 * the service role deletes the factors before anything else happens.
 *
 * This is not a bypass. The account genuinely carries a verified TOTP factor
 * and this step genuinely answers a challenge on /login/verify, through the
 * app's own page — so under mandatory mode the enrolment and challenge flows
 * are exercised on every single run rather than only by `mfa.spec.ts`.
 */
async function ensureSeedAdminFactor(): Promise<string | undefined> {
  if (!MFA_REQUIRED) return undefined;
  if (!isLocal()) {
    throw new Error(
      "MFA_REQUIRED is on and the target is deployed: the harness will not touch " +
        "factors on a real project. Run E2E against a local stack.",
    );
  }

  const svc = serviceClient();
  const { id } = await fixtureProfile(svc);
  const removed = await clearFactors(svc, id);

  const user = createClient(LOCAL_SUPABASE_URL, LOCAL_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await user.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (error) throw new Error(`seed admin sign-in for enrolment: ${error.message}`);

  const factor = await enrolAndVerify(user);
  console.log(
    `[mfa] seed admin: ${removed} old factor(s) removed, fresh TOTP factor enrolled for this run`,
  );
  return factor.secret;
}

setup("authenticate as admin", async ({ page }) => {
  // Cold, this test logs in AND compiles the whole route surface below.
  setup.setTimeout(900_000);

  const totpSecret = await ensureSeedAdminFactor();
  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD, totpSecret);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });

  // After the session is stored, so a warm-up problem can never be mistaken for
  // a credential problem. Deployed targets serve a prebuilt app — nothing to do.
  if (isLocal()) await warmRoutes(page);
});
