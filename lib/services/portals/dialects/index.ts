import type { Dialect } from "@/lib/services/portals/registry";
import { kyero, KYERO_CURRENCIES, KYERO_TYPES } from "./kyero";
import type { DialectRenderer } from "./types";

export type { DialectRenderer } from "./types";

/**
 * Tables keyed by dialect, deliberately NOT fields on the renderer: eligibility
 * must answer for dialects that have no renderer yet (`DIALECT_CURRENCIES.rera`
 * exists while `DIALECT_RENDERERS.rera` is null), and `Record<Dialect, …>` makes
 * a missing entry a compile error.
 */

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
