/**
 * Where the properties list remembers the last list URL a person settled on, so
 * a record page's "Properties" link returns to the same view, page and filters
 * instead of the bare list (review 2026-10-18, A03).
 *
 * Per tab (`sessionStorage`), never persisted across sessions or shared. Only a
 * value that starts with `/properties` is ever written or followed; anything
 * else falls back to the bare list. The sidebar's Properties link stays bare on
 * purpose: a silently restored filter is the trap `filters.tsx` warns about.
 */
export const PROPERTIES_LIST_CONTEXT_KEY = "gnk:properties:last";

/** True for a value this app wrote: a same-origin path on the properties list or its map. */
export function isPropertiesListPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "/properties" ||
      value.startsWith("/properties?") ||
      value === "/properties/map" ||
      value.startsWith("/properties/map?"))
  );
}
