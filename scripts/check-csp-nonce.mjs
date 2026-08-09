#!/usr/bin/env node
/**
 * Fail if a served page advertises a CSP nonce that its script tags do not carry.
 *
 * WHY THIS EXISTS, and why `check-static-routes.mjs` was not enough:
 *
 * That guard checks the BUILD — that no nonce-dependent route was prerendered.
 * It passed. The build is correct: `next start` against this very build serves
 * /login with 22 script tags and 22 nonces.
 *
 * Production served the same build with **22 script tags and ZERO nonces**
 * (measured 2026-08-09). The response header advertised
 * `script-src 'self' 'nonce-…' 'strict-dynamic'` while the RSC payload carried
 * `"nonce":"$undefined"` on every script — Next never saw the request-side
 * `Content-Security-Policy` header that `proxy.ts` sets, so it stamped nothing.
 * The difference is the deployment platform, not the code, which is exactly the
 * class of defect no build check and no local test can see.
 *
 * Under `'strict-dynamic'` — where the browser IGNORES `'self'` — an ENFORCED
 * policy would refuse every script on the page. Today the policy is
 * Report-Only, so the only visible effect is the CSP reports in Sentry.
 *
 * So: check the thing itself, against a running deployment.
 *
 *   node scripts/check-csp-nonce.mjs https://gnk-crm.vercel.app/login
 *
 * Any unauthenticated HTML route works; /login and /offline are the obvious
 * ones. /offline is EXPECTED to fail — it is force-static on purpose (B8) and
 * can never carry a nonce.
 */

/** Pull the nonce a policy advertises, or undefined. Mirrors Next's own parse. */
export function nonceFromPolicy(policy) {
  if (typeof policy !== "string") return undefined;
  const directive = policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));
  if (!directive) return undefined;
  for (const source of directive.split(/\s+/).slice(1)) {
    const match = source.match(/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Split a document's script tags into those carrying `nonce` and those not.
 * Counts the OPENING tags only — a nonce on the closing tag is not a thing.
 */
export function auditScriptTags(html, nonce) {
  const tags = html.match(/<script\b[^>]*>/gi) ?? [];
  const nonced = tags.filter((t) => new RegExp(`nonce=["']?${nonce}\\b`).test(t));
  return { total: tags.length, nonced: nonced.length, bare: tags.length - nonced.length };
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: node scripts/check-csp-nonce.mjs <url>");
    process.exit(2);
  }

  const res = await fetch(url, { redirect: "manual", headers: { accept: "text/html" } });
  const policy =
    res.headers.get("content-security-policy-report-only") ??
    res.headers.get("content-security-policy");
  const html = await res.text();

  const nonce = nonceFromPolicy(policy);
  if (!nonce) {
    console.error(
      `check-csp-nonce: ${url} (HTTP ${res.status}) advertises NO nonce in script-src.\n` +
        `Policy seen: ${policy ?? "(no CSP header at all)"}\n`,
    );
    // exitCode, not exit(): calling process.exit() while fetch's sockets are
    // still open trips a libuv assertion on Windows and reports 127 instead of
    // 1. Setting the code and returning lets Node close down and exit 1.
    process.exitCode = 1;
    return;
  }

  const { total, nonced, bare } = auditScriptTags(html, nonce);
  if (total === 0) {
    console.error(`check-csp-nonce: ${url} served no script tags — nothing to check.\n`);
    // exitCode, not exit(): calling process.exit() while fetch's sockets are
    // still open trips a libuv assertion on Windows and reports 127 instead of
    // 1. Setting the code and returning lets Node close down and exit 1.
    process.exitCode = 1;
    return;
  }
  if (bare > 0) {
    console.error(
      `\ncheck-csp-nonce: ${url} (HTTP ${res.status})\n\n` +
        `    header advertises: 'nonce-${nonce}'\n` +
        `    script tags:       ${total}\n` +
        `    carrying it:       ${nonced}\n` +
        `    carrying NOTHING:  ${bare}\n\n` +
        `The response promises a nonce its own scripts do not have. Under\n` +
        `'strict-dynamic' the browser ignores 'self', so ENFORCING this policy\n` +
        `would refuse ${bare} of ${total} scripts and the page would not hydrate.\n\n` +
        `This is not a build problem — check-static-routes covers that, and a\n` +
        `local \`next start\` of the same build stamps every nonce correctly.\n` +
        `It means the request-side Content-Security-Policy header that proxy.ts\n` +
        `sets is not reaching the renderer on this deployment.\n`,
    );
    // exitCode, not exit(): calling process.exit() while fetch's sockets are
    // still open trips a libuv assertion on Windows and reports 127 instead of
    // 1. Setting the code and returning lets Node close down and exit 1.
    process.exitCode = 1;
    return;
  }

  console.log(`check-csp-nonce: ok — ${url} stamped 'nonce-${nonce}' on all ${total} script tags.`);
}

if (process.argv[1] && process.argv[1].endsWith("check-csp-nonce.mjs")) main();
