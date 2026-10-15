import { z } from "zod";

/**
 * The one shape check for an id that arrives as text — a URL segment, a
 * search parameter, a server action's argument — before it reaches a query
 * (T-malformed-ids). PostgREST answers a malformed uuid with 22P02, which a
 * page turned into its error boundary and an action into Postgres' own words.
 * A value that fails here names no row: a page answers 404, a list filter is
 * dropped as if absent, an action refuses in its own return shape.
 *
 * z.guid(), NEVER z.uuid(): the strict check enforces RFC version and variant
 * bits that Postgres ignores, and refuses the hosted organisation id
 * (00000000-0000-0000-0000-000000000001) and every seed and fixture id
 * (DECISIONS 2026-07-11 · T3.2; T-external-audit-2026-10-14, item 4). guid's
 * 8-4-4-4-12 hex shape is stricter than Postgres' uuid input (which also
 * reads braces and bare hex), so a value that passes cannot raise 22P02; no
 * URL or form of ours writes the other spellings.
 */
const guid = z.guid();

export function isGuid(value: unknown): value is string {
  return guid.safeParse(value).success;
}

/** The id, or null when it is not one — for a filter that must drop it. */
export function guidOrNull(value: unknown): string | null {
  return isGuid(value) ? value : null;
}
