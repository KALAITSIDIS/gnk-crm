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

const APP_DIR = ".next/server/app";

/**
 * Routes that are allowed to be static, each for a stated reason. Anything else
 * appearing here is a page that silently lost its nonce.
 *
 *   offline       — force-static ON PURPOSE (B8): a PWA fallback must be
 *                   precacheable and must not need the server, so it can never
 *                   carry a per-request nonce. Consequence, accepted: under
 *                   enforcement it renders but does not hydrate.
 *   _not-found /
 *   _global-error — Next internals; no interactive surface worth a nonce.
 *   index         — `/` only ever redirects (proxy.ts), so its scripts never run.
 */
export const ALLOWED_STATIC = new Set(["offline", "_not-found", "_global-error", "index"]);

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

  const unexpected = findUnexpectedStatic(readdirSync(APP_DIR));
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
