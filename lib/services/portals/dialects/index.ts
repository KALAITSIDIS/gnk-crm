import type { FeedListing } from "@/lib/services/portals/feed-listing";
import type { Dialect } from "@/lib/services/portals/registry";
import { kyero, KYERO_CURRENCIES, KYERO_TYPES } from "./kyero";

/**
 * A dialect is a pure function from listings to a document. This interface is
 * the seam the spec names: a push adapter (not planned) would implement a
 * sibling interface reading the same `FeedListing`.
 */
export interface DialectRenderer {
  render(listings: readonly FeedListing[], settings: Record<string, string>): string;
  /** what a DISABLED portal's URL answers: valid, and empty, so the portal clears its copy */
  empty(): string;
  contentType: string;
}

/** `null` = no renderer yet (spec pending). The registry's `spec` field and this table must agree — eligibility.test pins it. */
export const DIALECT_RENDERERS: Record<Dialect, DialectRenderer | null> = {
  kyero,
  rera: null,
  trovit: null,
  bazaraki: null,
  prian: null,
};

/** CRM `property_type` → the dialect's type value. A type absent here is ineligible for that dialect. */
export const DIALECT_TYPE_MAPS: Record<Dialect, Readonly<Record<string, string>>> = {
  kyero: KYERO_TYPES,
  rera: {},
  trovit: {},
  bazaraki: {},
  prian: {},
};

/** Currencies the dialect can express; `null` = any. */
export const DIALECT_CURRENCIES: Record<Dialect, readonly string[] | null> = {
  kyero: KYERO_CURRENCIES,
  rera: ["EUR"],
  trovit: null,
  bazaraki: null,
  prian: null,
};
