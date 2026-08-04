import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Token minting and hashing for buyer proposal links (IMPROVEMENTS B3).
 *
 * SPLIT OUT OF `share-links.ts` on 2026-08-04, and the `server-only` import is
 * the point of the file.
 *
 * `share-links-client.tsx` is a client component and imports constants and pure
 * helpers (`SHARE_LOCALES`, `daysUntilExpiry`, `shareLinkState`, …) from
 * `share-links.ts`. While these two functions lived there too, that single
 * import dragged **`node:crypto` into the browser bundle**, where the bundler
 * polyfills it — `vm-browserify`, `function-bind`, `is-generator-function` — and
 * those shims call the `Function` constructor. The result was a real
 * `script-src / blockedURI: "eval"` violation on `/share-links`: the Proposals
 * page would have BROKEN the day the CSP was enforced.
 *
 * It was invisible for six days because it only reproduces against a
 * **production build** (`next dev` ships `'unsafe-eval'` by design, see
 * `lib/services/csp.ts`), and Playwright did not run in CI. Found 2026-08-04 by
 * the new `e2e` job on its very first run.
 *
 * `import "server-only"` makes a repeat a BUILD ERROR rather than a silent
 * regression — the same guard `lib/supabase/admin.ts` uses.
 */

/** 32 bytes = 256 bits. Guessing one is infeasible; see the design's §5. */
export const SHARE_TOKEN_BYTES = 32;

/**
 * URL-safe, no padding — it goes in a path segment and gets pasted into
 * WhatsApp, where `+` and `/` would be mangled.
 */
export function generateShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

/**
 * Only the HASH is stored (migration 0023). A database leak therefore yields no
 * working links — the same reasoning as password hashing. Lookup by hash stays
 * a single indexed equality probe.
 */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
