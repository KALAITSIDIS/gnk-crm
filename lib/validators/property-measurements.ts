/**
 * The measurement rules for a property's areas and floors — ONE definition
 * (audit 2026-09-23, property validation; the 2026-09-15 data-integrity
 * audit's LST-07).
 *
 * Reproduced against a321de5: the details form accepted floor 9 of a 3-floor
 * building and a 0 m² covered or plot area, while the create wizard refused a
 * 0 m² area — so the same fact was valid or invalid depending on which form
 * typed it, and the CSV importer accepted all of it. The rules are:
 *
 * - AREAS. `covered_area_sqm` and `plot_area_sqm`, when known, are positive AS
 *   STORED. Unknown or not applicable (a flat has no plot of its own; land has
 *   no covered area) is null, never 0. The columns are numeric(10,2) and
 *   numeric(12,2), which round 0.004 to 0.00, so "positive" means at least
 *   MIN_AREA_SQM — `.positive()` alone let a value through that was stored as
 *   zero.
 * - FLOORS. The ground floor is 0 (the unit generator's convention, pinned by
 *   unit-generator.test.ts) and a basement is negative. When BOTH are known,
 *   `floor_number <= total_floors`. Whether `total_floors` counts the ground
 *   storey is recorded nowhere, so the rule refuses only what no reading of
 *   it admits — floor N+1 of N — and accepts the top floor either way
 *   (production holds a 2-of-2 row, 2026-09-23).
 *
 * Deliberately NOT here: bedrooms, bathrooms, parking, veranda, roof garden
 * and basement areas — zero is a real answer for every one of them (a studio,
 * no parking, no veranda).
 *
 * Pure and dependency-free: the Zod schemas, the server actions, the unit
 * writer and the CSV importer (plain Node) all import it, and migration 0113's
 * CHECK constraints say the same thing for every other write path —
 * supabase/tests/property-measurements.test.ts asserts, case by case, that
 * the database refuses a row exactly when this module does.
 */

/** The smallest area numeric(p,2) stores as positive: 0.004 rounds to 0.00. */
export const MIN_AREA_SQM = 0.01;

export const AREA_FIELDS = ["covered_area_sqm", "plot_area_sqm"] as const;
export const FLOOR_FIELDS = ["floor_number", "total_floors"] as const;
/** Exactly the columns 0113 constrains on `properties`. */
export const MEASUREMENT_FIELDS = [...AREA_FIELDS, ...FLOOR_FIELDS] as const;

export type AreaField = (typeof AREA_FIELDS)[number];
export type MeasurementField = (typeof MEASUREMENT_FIELDS)[number];

/** How a message names each area — the words on the forms. */
export const AREA_LABELS: Record<AreaField, string> = {
  covered_area_sqm: "Covered area",
  plot_area_sqm: "Plot area",
};

/** null/undefined/"" are unknown; anything else is read as a number (form and CSV values arrive as text). */
function known(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return Number(value);
}

/** Why a known area cannot be stored, or null when it can (or is unknown). */
export function areaProblem(label: string, value: unknown): string | null {
  const n = known(value);
  if (n === null) return null;
  if (!Number.isFinite(n)) return `${label} must be a number.`;
  if (n <= 0) {
    return `${label} must be greater than 0 m² — leave it blank if it is not known or does not apply.`;
  }
  if (n < MIN_AREA_SQM) {
    return `${label} must be at least ${MIN_AREA_SQM} m² — areas are kept to two decimal places.`;
  }
  return null;
}

/** Why a floor cannot sit in a building of that height, or null (including when either is unknown). */
export function floorProblem(floor: unknown, total: unknown): string | null {
  const f = known(floor);
  const t = known(total);
  if (f === null || t === null) return null;
  if (f > t) {
    return (
      `Floor ${f} is above the building's total floors (${t}). The ground floor is 0 and ` +
      `basements are negative — correct one of the two, or leave it blank if it is not known.`
    );
  }
  return null;
}

export interface MeasurementProblem {
  field: MeasurementField;
  message: string;
}

/**
 * The first rule a row breaks, checked on the row AS IT WILL BE STORED. A
 * caller writing only some of these columns passes the stored row overlaid
 * with its changes — the floor rule relates two columns, and checking only
 * the one being sent would let it pair with a stored value it never saw.
 */
export function measurementProblem(
  row: Partial<Record<MeasurementField, unknown>>,
): MeasurementProblem | null {
  for (const field of AREA_FIELDS) {
    const message = areaProblem(AREA_LABELS[field], row[field]);
    if (message) return { field, message };
  }
  const message = floorProblem(row.floor_number, row.total_floors);
  return message ? { field: "floor_number", message } : null;
}
