import { createHash } from "node:crypto";

/**
 * The public feed's ETag: `W/"<snapshot>-<body>"`.
 *
 * `body` is sha256 over the exact bytes the response carries, and it is the
 * validator. It cannot disagree with the body by construction: an edited alt,
 * a renamed area, a withdrawn listing all change the bytes, whether or not any
 * SQL-side hash saw the change coming — 0086 and DECISIONS T-deferred-sweep
 * each found one it had not. The page (limit, offset) is inside the bytes, so
 * two offsets of one feed never share a validator.
 *
 * `snapshot` is `public_listings_etag`, a name for the feed AS A WHOLE, kept
 * for one reader: gnk-web fetches pages one request at a time and compares
 * this segment across them to notice the feed moving underneath the read
 * (lib/crm.ts readAllPages). A per-page digest cannot serve that — two pages
 * of one snapshot have two bodies. It is not consulted for freshness.
 *
 * Weak (`W/`) because the platform may re-encode the bytes on the wire.
 *
 * Apart from public-listings.ts for the reason ip-hash.ts is apart from
 * caller-ip.ts: this is the only import of `node:crypto` on the feed's path,
 * and the file that owns it must never be reachable from a client component
 * (DECISIONS T-share-links-eval).
 */
export function feedEtag(snapshot: string, body: string): string {
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 32);
  return `W/"${snapshot}-${digest}"`;
}
