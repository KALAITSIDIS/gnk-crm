#!/usr/bin/env node
/**
 * Fail the build if a route that needs a CSP nonce was statically prerendered.
 *
 * WHY THIS EXISTS AS A BUILD CHECK and not a test:
 *
 * `proxy.ts` mints a fresh nonce per request and Next stamps it onto the script
 * tags — but only for DYNAMICALLY rendered pages. A statically prerendered page
 * is rendered at build time, long before any request, so its tags carry no
 * nonce while the response header still advertises one. Under
 * `script-src 'nonce-…' 'strict-dynamic'` — where `'strict-dynamic'` makes the
 * browser IGNORE `'self'` — every script on that page is refused.
 *
 * Measured on production 2026-08-09: `/login` served **26 script tags and zero
 * nonces**. Enforcing the policy would have left the login page as dead HTML.
 *
 * Neither existing suite can catch it:
 *   - the E2E suite runs against `npm run dev`, where EVERY page is rendered
 *     per request and therefore nonced — it passes no matter what;
 *   - `csp.spec.ts` collects `securitypolicyviolation` events, and under
 *     Report-Only the browser blocks nothing, so a page whose scripts would all
 *     be refused still sweeps clean. Its 22/22 and 27/27 runs were true and
 *     silent about this;
 *   - unit tests run BEFORE `npm run build` in CI, so `.next` is not there yet.
 *
 * The only place the property is observable is the build output. So: an
 * allowlist, checked against what was actually prerendered.
 */
import { readdirSync, existsSync } from "node:fs";
import { sep } from "node:path";

const APP_DIR = ".next/server/app";

/**
 * Routes that are allowed to be static, each for a stated reason. Anything else
 * appearing here is a page that silently lost its nonce.
 *
 *   _not-found /
 *   _global-error — Next internals; no interactive surface worth a nonce.
 *   index         — `/` only ever redirects (proxy.ts), so its scripts never run.
 *
 * `offline` WAS on this list until 2026-08-11, on the stated grounds that a PWA
 * fallback must be precacheable and must not need the server, accepting that it
 * "renders but does not hydrate". Removed, because that phrase understates it:
 * not hydrating means every script on the page is REFUSED — ~20 violations, and
 * ~20 CSP reports, for anyone who reaches it. `app/offline/page.tsx` is now
 * `force-dynamic` and explains why the precache argument never actually required
 * static rendering. Do not re-add it without reading that comment.
 *
 * The removal was ALSO expected to stop a chrome-headless-shell `SIGSEGV` in CI.
 * It did not — see HANDOFF §6. That does not affect this entry: a page whose
 * scripts are all refused belongs off the allowlist either way.
 */
export const ALLOWED_STATIC = new Set(["_not-found", "_global-error", "index"]);

/**
 * Every prerendered .html under `dir`, as POSIX-relative paths.
 *
 * MUST be recursive. This read was `readdirSync(APP_DIR)` until 2026-08-09,
 * which only ever saw the TOP LEVEL: a prerendered `/settings/organization`
 * lands at `.next/server/app/settings/organization.html`, so the read returned
 * the directory `settings` — filtered out for not ending in .html — and the
 * route was invisible. The guard therefore covered `/login` (top-level, the
 * case it was written for) and silently nothing else. The unit tests did not
 * catch it because they hand `findUnexpectedStatic` nested paths directly,
 * which the caller could not produce.
 */
export function listPrerenderedHtml(dir) {
  return readdirSync(dir, { recursive: true })
    .map((f) => f.split(sep).join("/")) // Windows readdir yields backslashes
    .filter((f) => f.endsWith(".html"));
}

/** Pure: which prerendered pages are not on the allowlist. */
export function findUnexpectedStatic(htmlFiles, allowed = ALLOWED_STATIC) {
  return htmlFiles
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.replace(/\.html$/, ""))
    .filter((route) => !allowed.has(route))
    .sort();
}

function main() {
  if (!existsSync(APP_DIR)) {
    console.error(`check-static-routes: ${APP_DIR} not found — run \`npm run build\` first.`);
    process.exit(2);
  }

  const unexpected = findUnexpectedStatic(listPrerenderedHtml(APP_DIR));
  if (unexpected.length === 0) {
    console.log("check-static-routes: ok — no nonce-dependent route was prerendered.");
    return;
  }

  console.error(
    `\ncheck-static-routes: ${unexpected.length} route(s) were STATICALLY PRERENDERED and will\n` +
      `carry no CSP nonce:\n\n` +
      unexpected.map((r) => `    /${r === "index" ? "" : r}`).join("\n") +
      `\n\nA prerendered page is built before the request nonce exists, so under an\n` +
      `enforced 'strict-dynamic' policy every script on it is refused — the page\n` +
      `renders as dead HTML. This is what happened to /login (IMPROVEMENTS C1).\n\n` +
      `Fix: add \`export const dynamic = "force-dynamic";\` to the page.\n` +
      `If the route genuinely must stay static, add it to ALLOWED_STATIC in this\n` +
      `script WITH the reason and the hydration consequence written down.\n`,
  );
  process.exit(1);
}

// Only run when invoked directly, so the pure half stays importable by tests.
if (process.argv[1] && process.argv[1].endsWith("check-static-routes.mjs")) main();
