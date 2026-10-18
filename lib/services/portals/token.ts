import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Portal feed tokens (0097, integrations audit 2026-09-15, INT-10).
 *
 * Share links have stored only `sha256(token)` since 0023; the portal feed
 * stored its token in clear for one day short of a milestone, so every dump,
 * backup and service-role read of `portal_connections` held a live feed URL
 * — and with it the exact coordinates of every listing selected for that
 * portal. Now the app mints the token, the row holds its digest, and the
 * plaintext exists only in the action's return value, shown once.
 *
 * WHO HASHES WHAT (0150/0151, T-portal-feed-integrity). 0097's readers took
 * the DIGEST, which made the stored digest itself the credential. The readers
 * now take the token and hash it in SQL —
 * `encode(pg_catalog.sha256(convert_to(token, 'UTF8')), 'hex')` — so this
 * function's job is the WRITE side (the digest an enable or Regenerate
 * stores) and the actions' read-back of an unconfirmed write. The two must
 * agree byte for byte: 0150's postflight and portal-feed-integrity.test.ts
 * pin one token's digest on both sides.
 *
 * `server-only` for the reason share-links-token.ts gives: a client
 * component importing this would drag `node:crypto` into the browser bundle,
 * and the polyfill's `Function` constructor is a CSP `eval` violation.
 */

/** 32 bytes as 64 hex — the route's path check and 0097's CHECK are this shape. */
export function mintPortalToken(): string {
  return randomBytes(32).toString("hex");
}

/** Lowercase hex SHA-256 of the token's UTF-8 text: what the row holds, and what 0150's SQL computes from a token. */
export function hashPortalToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
