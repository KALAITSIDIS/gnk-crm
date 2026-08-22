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

/* ------------------------------------------------------------------ */
/* Availability links (migration 0041).                                 */
/*                                                                      */
/* A second `kind` on the same machinery: the link names ONE property —  */
/* a project or a phase — and the resolver returns every unit beneath    */
/* it. Same rule as above: the SQL is the exposure boundary, these       */
/* interfaces are only how TypeScript reads it.                         */
/* ------------------------------------------------------------------ */

/** A project sells over months, not over a viewing cycle. */
export const AVAILABILITY_EXPIRY_DAYS = 30;

/**
 * Status display order for the matrix summary. `draft` is absent because the
 * resolver never emits it — an unfinished record is not inventory.
 *
 * Deliberately a local literal rather than an import of `PROPERTY_STATUSES`:
 * that module pulls zod in, and this one is imported by the PUBLIC page, which
 * has no business shipping the validator layer to a buyer's phone. A literal
 * can drift from the enum, so a unit test asserts it does not — the same guard
 * `UNIT_PARENT_SELECT` carries, for the same reason.
 */
export const AVAILABILITY_STATUS_ORDER = [
  "available",
  "reserved",
  "under_offer",
  "sold",
  "rented",
  "withdrawn",
] as const;

export interface AvailabilityUnit {
  reference: string;
  unit_number: string | null;
  block: string | null;
  floor_number: number | null;
  property_type: string;
  bedrooms: number | null;
  bathrooms: number | null;
  covered_area_sqm: number | null;
  veranda_sqm: number | null;
  /** THE field this kind exists to show. Proposals still do not carry it. */
  status: string;
  /** the live asking price, or the pinned version's — never a mix. See `price_source`. */
  price: number | null;
  /** null when the unit hangs directly off the named project */
  phase_reference: string | null;
}

export interface AvailabilityPhase {
  reference: string;
  title: string | null;
  status: string;
  /** a phase's OWN date, severed from the project at creation (BACKLOG 11) */
  delivery_date: string | null;
  construction_status: string | null;
}

export interface AvailabilityProject {
  reference: string;
  /** `project` or `phase` — a link may name either */
  kind: string;
  title: string | null;
  short_description: string | null;
  public_description: string | null;
  property_type: string;
  currency: string;
  energy_class: string | null;
  features: string[];
  delivery_date: string | null;
  construction_status: string | null;
  district: string | null;
  area: string | null;
}

export interface Availability {
  /** The discriminator. Proposals deliberately carry NO `kind` — see 0041. */
  kind: "availability";
  title: string | null;
  message: string | null;
  locale: ShareLocale;
  expires_at: string;
  project: AvailabilityProject;
  phases: AvailabilityPhase[];
  units: AvailabilityUnit[];
  unit_count: number;
  available_count: number;
  /**
   * Units the PINNED version omits. Forced to 0 in live mode by the resolver:
   * a unit with no asking price is "on application", not a shortfall, and
   * counting it put a sentence about a price list on a page that had none.
   */
  unpriced_count: number;
  price_source: "live" | "price_list";
  price_list: { version: number; effective_date: string } | null;
  agent: { name: string; email: string; phone: string | null } | null;
  org: { name: string } | null;
}

/** What `resolve_share_link` can return, for either kind. */
export type ResolvedShareLink = Proposal | Availability;

/**
 * The dispatch. 0041 puts `kind` on the availability payload ONLY, so that the
 * proposal payload — and RLS test 25, which pins its exact key set — did not
 * have to change when the boundary moved for the other kind.
 */
export function isAvailability(resolved: ResolvedShareLink): resolved is Availability {
  return (resolved as Availability).kind === "availability";
}

export interface AvailabilityGroup {
  /** null = units hanging directly off the named project */
  phase: AvailabilityPhase | null;
  units: AvailabilityUnit[];
  availableCount: number;
}

/**
 * Units grouped by the phase they belong to, direct children first.
 *
 * Grouping is not decoration. A phase carries its OWN delivery date, severed
 * from its project at creation, so a flat table would put a 2028 and a 2029
 * handover in one list with nothing to tell them apart — a wrong date in front
 * of the person deciding whether to sell the units.
 *
 * A phase the payload describes but that holds no units stays out: somebody
 * reading availability wants inventory, not an empty heading. A phase a unit
 * names but the payload does not describe still gets a group, keyed by its
 * reference with empty metadata — dropping the units would be worse than
 * showing them under a bare heading.
 */
export function groupUnitsByPhase(availability: Availability): AvailabilityGroup[] {
  const meta = new Map(availability.phases.map((p) => [p.reference, p]));
  const buckets = new Map<string | null, AvailabilityUnit[]>();

  for (const unit of availability.units) {
    const key = unit.phase_reference;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(unit);
    else buckets.set(key, [unit]);
  }

  // Direct units first, then phases by reference. Stated explicitly rather than
  // relying on insertion order, so the page does not silently depend on how the
  // resolver happened to sort.
  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === null) return -1;
    if (b === null) return 1;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const units = buckets.get(key)!;
    return {
      phase:
        key === null
          ? null
          : (meta.get(key) ?? {
              reference: key,
              title: null,
              status: "",
              delivery_date: null,
              construction_status: null,
            }),
      units,
      availableCount: units.filter((u) => u.status === "available").length,
    };
  });
}

/**
 * Counts per status in display order, omitting statuses with no units. This is
 * the headline the link exists to say out loud: "40 available · 12 sold".
 *
 * A status the enum grew and `AVAILABILITY_STATUS_ORDER` has not is appended
 * rather than dropped — an unstyled label is a smaller lie than a missing unit.
 */
export function statusSummary(units: AvailabilityUnit[]): { status: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const unit of units) counts.set(unit.status, (counts.get(unit.status) ?? 0) + 1);

  const known = AVAILABILITY_STATUS_ORDER.filter((s) => counts.has(s)).map((s) => ({
    status: s as string,
    count: counts.get(s)!,
  }));
  const unknown = [...counts.entries()]
    .filter(([status]) => !(AVAILABILITY_STATUS_ORDER as readonly string[]).includes(status))
    .map(([status, count]) => ({ status, count }));

  return [...known, ...unknown];
}
