/**
 * The property page's tabs, by id — what `?tab=` may name (F03).
 *
 * They lived as a constant inside app/(app)/properties/[id]/page.tsx, which
 * nothing else can import (a page file may export only what Next allows). The
 * worklist and the readiness panel now link INTO a tab — "fix it here" — so
 * the ids have one home, and a link can only name a tab that exists.
 *
 * Pure, no I/O.
 */

/** The tabs, in the order the page renders them. */
export const PROPERTY_TABS = [
  "overview",
  "details",
  "legal",
  "marketing",
  "media",
  "mandate",
  "documents",
  "reservation",
  "buyers",
  "activity",
] as const;

export type PropertyTab = (typeof PROPERTY_TABS)[number];

/** The words on each tab, for text that names one ("Fixed on the Legal tab"). */
export const PROPERTY_TAB_LABELS: Record<PropertyTab, string> = {
  overview: "Overview",
  details: "Details",
  legal: "Legal",
  marketing: "Marketing",
  media: "Media",
  mandate: "Mandate & Keys",
  documents: "Documents",
  reservation: "Reservation",
  buyers: "Matching buyers",
  activity: "Activity",
};

export function isPropertyTab(value: unknown): value is PropertyTab {
  return typeof value === "string" && (PROPERTY_TABS as readonly string[]).includes(value);
}

/** `?tab=` as the page reads it: a known tab, else Overview. */
export function propertyTabFrom(value: unknown): PropertyTab {
  return isPropertyTab(value) ? value : "overview";
}

/** A link that opens a property on one of its tabs. */
export function propertyTabHref(propertyId: string, tab: PropertyTab): string {
  return `/properties/${propertyId}?tab=${tab}`;
}
