import { expect, type Page, type ConsoleMessage, type Response } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Local Supabase seed admin (see docs/07_SEED_DATA.sql). */
export const ADMIN_EMAIL = process.env.E2E_EMAIL ?? "admin@gnk.local";
export const ADMIN_PASSWORD = process.env.E2E_PASSWORD ?? "admin1234";

/** Every sidebar module from the audit brief, in sidebar order. */
export const MODULES = [
  { name: "Dashboard", path: "/dashboard", heading: "Dashboard" },
  { name: "Leads", path: "/leads", heading: "Leads" },
  { name: "Pipeline", path: "/pipeline", heading: "Pipeline" },
  { name: "Properties", path: "/properties", heading: "Properties" },
  { name: "Contacts", path: "/contacts", heading: "Contacts" },
  { name: "Viewings", path: "/viewings", heading: "Viewings" },
  { name: "Tasks", path: "/tasks", heading: "Tasks" },
  { name: "Keys", path: "/keys", heading: "Keys" },
  { name: "Proposals", path: "/share-links", heading: "Proposals" },
  { name: "Reports", path: "/reports", heading: "Reports" },
  { name: "Calculators", path: "/calculators", heading: "Calculators" },
  { name: "Settings", path: "/settings", heading: "Settings" },
] as const;

/**
 * Console noise that is not an application defect:
 *  - Next.js dev-only hydration/HMR chatter and the devtools banner
 *  - favicon 404 in the dev server
 *  - Sentry no-op warnings when no DSN is configured (see .env.example)
 */
const IGNORED_CONSOLE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /favicon\.ico/i,
  /Sentry Logger/i,
  /was preloaded using link preload/i,
];

export interface PageProblems {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
}

/**
 * Attaches listeners that record console errors, uncaught exceptions, failed
 * requests and 4xx/5xx responses for the lifetime of the page. Call BEFORE
 * navigating. Returns the live-updating record.
 */
export function watchForProblems(page: Page): PageProblems {
  const problems: PageProblems = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    badResponses: [],
  };

  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    problems.consoleErrors.push(text);
  });

  page.on("pageerror", (err) => {
    problems.pageErrors.push(`${err.name}: ${err.message}`);
  });

  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText ?? "unknown";
    // Aborted navigations/prefetches are normal during client-side routing.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(failure)) return;
    problems.failedRequests.push(`${req.method()} ${req.url()} — ${failure}`);
  });

  page.on("response", (res: Response) => {
    const status = res.status();
    if (status < 400) return;
    const url = res.url();
    if (/favicon\.ico/.test(url)) return;
    problems.badResponses.push(`${status} ${res.request().method()} ${url}`);
  });

  return problems;
}

/** Fails the test with the collected detail rather than a bare boolean. */
export function assertNoProblems(problems: PageProblems, context: string) {
  expect(problems.pageErrors, `${context}: uncaught exceptions`).toEqual([]);
  expect(problems.badResponses, `${context}: 4xx/5xx responses`).toEqual([]);
  expect(problems.failedRequests, `${context}: failed network requests`).toEqual([]);
  expect(problems.consoleErrors, `${context}: console errors`).toEqual([]);
}

/**
 * Guards against the classic broken-layout symptom: content wider than the
 * viewport, i.e. the page scrolls sideways. Allows 1px for sub-pixel rounding.
 */
export async function assertNoHorizontalOverflow(page: Page, context: string) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth - overflow.clientWidth,
    `${context}: page scrolls horizontally (${overflow.scrollWidth}px content in ${overflow.clientWidth}px viewport)`,
  ).toBeLessThanOrEqual(1);
}

/** Asserts the app shell rendered rather than an error boundary / blank page. */
export async function assertShellRendered(page: Page) {
  await expect(page.locator("main")).toBeVisible();
  const body = (await page.locator("body").innerText()).trim();
  expect(body.length, "page body is empty").toBeGreaterThan(20);
  // T5.7 error boundaries render this copy; a module smoke test must not hit it.
  await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
}

export async function login(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
}

/** Unique suffix so audit fixtures are always identifiable and never collide. */
export const runTag = () => `qa-${Date.now().toString(36)}`;

/* ------------------------------------------------------------------ *
 * Seeding a fixture the UI would need a whole wizard to make.
 *
 * This lives here because it was already copied into `nudges.spec.ts` and
 * `csp.spec.ts`, and `performance.spec.ts` needed a third — the same "fifth
 * copy of the arithmetic" this repo refused for pagination. Local-only by
 * construction: `isLocal()` gates every caller, because the service key does
 * not exist against a deployed base URL.
 * ------------------------------------------------------------------ */

export const baseUrl = () => process.env.E2E_BASE_URL ?? "http://localhost:3000";

/** Seeding is only possible against the local stack; deployed runs self-skip. */
export const isLocal = () => /localhost|127\.0\.0\.1/.test(baseUrl());

/**
 * Local Supabase service key — the standard demo key printed by
 * `supabase status`. Not a secret, and it only ever reaches 127.0.0.1.
 */
export const LOCAL_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

export function serviceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
    LOCAL_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** The profile the local dev app signs in as — its id doubles as an agent id. */
export async function fixtureProfile(
  svc: SupabaseClient,
): Promise<{ id: string; orgId: string }> {
  const { data: profile } = await svc
    .from("profiles")
    .select("id, org_id")
    .eq("email", ADMIN_EMAIL)
    .single();
  expect(profile, `no profile for ${ADMIN_EMAIL} — is the local stack seeded?`).not.toBeNull();
  return { id: profile!.id, orgId: profile!.org_id };
}
