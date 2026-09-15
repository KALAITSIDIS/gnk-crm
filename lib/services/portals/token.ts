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
 * `server-only` for the reason share-links-token.ts gives: a client
 * component importing this would drag `node:crypto` into the browser bundle,
 * and the polyfill's `Function` constructor is a CSP `eval` violation.
 */

/** 32 bytes as 64 hex — the route's path check and 0097's CHECK are this shape. */
export function mintPortalToken(): string {
  return randomBytes(32).toString("hex");
}

/** Lowercase hex SHA-256: what the row holds, and what every lookup compares. */
export function hashPortalToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
