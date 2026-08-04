/**
 * Buyer proposal magic links (IMPROVEMENTS B3, migration 0023).
 *
 * Doc 01 §4 forbids buyer logins **ever**; §0.1 names the sanctioned
 * replacement — "no-login magic-link proposal pages (tokenized URL, expiry
 * date, per-open view tracking)". Everything here serves that and no more.
 *
 * The token is a bearer credential: whoever holds the URL sees the proposal.
 * That is the point (a buyer must not need an account), and it is why the
 * token is generated with a CSPRNG, never stored, and always revocable.
 *
 * **THIS MODULE MUST STAY FREE OF `node:*` IMPORTS.** `share-links-client.tsx`
 * is a client component and imports the constants and pure helpers below, so
 * anything Node-only here lands in the browser bundle. Token minting and
 * hashing therefore live in `share-links-token.ts`, which is `server-only`;
 * see that file's header for the CSP violation this caused.
 */

/** Matches a viewing-decision cycle. The agent may shorten or extend. */
export const DEFAULT_EXPIRY_DAYS = 14;
export const MAX_EXPIRY_DAYS = 90;

export const SHARE_LOCALES = ["en", "el", "ru"] as const;
export type ShareLocale = (typeof SHARE_LOCALES)[number];

/**
 * A token that could not have come from `generateShareToken` is rejected before
 * it reaches the database — a cheap miss costs no round trip. Deliberately not
 * an "is this valid" check: it only rules out shapes we never mint.
 */
export function isWellFormedShareToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export type ShareLinkState = "live" | "expired" | "revoked";

/**
 * Revoked beats expired: an agent who revoked a link wants to see that they
 * revoked it, not that it later lapsed. Both are dead to a visitor, and the
 * public page renders them identically.
 */
export function shareLinkState(
  link: { expires_at: string | Date; revoked_at: string | Date | null },
  now: Date = new Date(),
): ShareLinkState {
  if (link.revoked_at) return "revoked";
  const expires =
    typeof link.expires_at === "string" ? new Date(link.expires_at) : link.expires_at;
  return expires.getTime() > now.getTime() ? "live" : "expired";
}

/** Days remaining, floored at 0. Used for the "expires in N days" hint. */
export function daysUntilExpiry(expiresAt: string | Date, now: Date = new Date()): number {
  const expires = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  return Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / 86_400_000));
}

/** `expires_at` for a link created now with `days` of life. */
export function expiryFromNow(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

export function shareLinkPath(token: string): string {
  return `/p/${token}`;
}

/* ------------------------------------------------------------------ */
/* The shape `resolve_share_link` returns. Mirrors the allowlist in     */
/* migration 0023 — if these disagree, the SQL wins: it is the actual   */
/* exposure boundary and this is only how TypeScript reads it.          */
/* ------------------------------------------------------------------ */

export interface ProposalMedia {
  card: string | null;
  full: string | null;
  alt: string | null;
}

export interface ProposalProperty {
  reference: string;
  property_type: string;
  transaction_type: string;
  title: string | null;
  short_description: string | null;
  public_description: string | null;
  currency: string;
  asking_price: number | null;
  rent_price_month: number | null;
  covered_area_sqm: number | null;
  plot_area_sqm: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  parking_spaces: number | null;
  year_built: number | null;
  energy_class: string | null;
  features: string[];
  district: string | null;
  area: string | null;
  media: ProposalMedia[];
}

export interface Proposal {
  title: string | null;
  message: string | null;
  locale: ShareLocale;
  expires_at: string;
  /** how many were curated — may exceed `properties.length` if some archived */
  property_count: number;
  properties: ProposalProperty[];
  agent: { name: string; email: string; phone: string | null } | null;
  org: { name: string } | null;
}

/**
 * How many curated properties are no longer shown. A property archived after
 * the link was made drops out rather than 404-ing the whole proposal, so the
 * page owes the reader an honest note instead of silently showing fewer.
 */
export function withheldCount(proposal: Proposal): number {
  return Math.max(0, proposal.property_count - proposal.properties.length);
}
