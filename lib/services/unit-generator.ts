/**
 * Bulk unit generation (BACKLOG audit proposal, follow-on to finding 5).
 *
 * Entering a developer project one unit at a time is the single biggest reason
 * a project is painful to put into this system: a 60-unit block is 60 trips
 * through a dialog. A block is regular by construction — floors repeat, layouts
 * repeat, price climbs with height — so the desk should describe the pattern
 * once and let the system write the rows.
 *
 * Pure and heavily tested, because the failure mode is not a crash. A wrong
 * numbering scheme or a wrong price rule produces sixty plausible-looking rows
 * that somebody has to find and fix by hand.
 */

/** Hard ceiling per run, so a typo in the floor range cannot insert thousands. */
export const MAX_GENERATED_UNITS = 200;

/** Highest floor the numbering scheme is meaningful for. */
export const MAX_FLOOR = 60;

/** Most units one floor can hold in this scheme (two digits after the floor). */
export const MAX_PER_FLOOR = 99;

export interface UnitGenerationSpec {
  block?: string | null;
  floorFrom: number;
  floorTo: number;
  perFloor: number;
  /** First unit index on each floor — 1 gives x01, 0 would give x00. */
  startIndex?: number;
  bedrooms?: number | null;
  bathrooms?: number | null;
  coveredAreaSqm?: number | null;
  /** Price of a unit on `floorFrom`. */
  basePrice?: number | null;
  /** Added per floor above `floorFrom` — the higher, the dearer. */
  pricePerFloor?: number | null;
}

export interface GeneratedUnit {
  unit_number: string;
  block: string | null;
  floor_number: number;
  bedrooms: number | null;
  bathrooms: number | null;
  covered_area_sqm: number | null;
  asking_price: number | null;
  /** What goes after the project reference: block + number, e.g. "B301". */
  label: string;
}

/**
 * Floor 3, unit 1 becomes "301" — the convention every block in Cyprus uses,
 * and the one `createUnit` already implies by joining block and number without
 * a separator. Two digits for the index, so floor 10 gives "1001" and not an
 * ambiguous "101" that collides with floor 1 unit 1.
 */
export function unitNumberFor(floor: number, index: number): string {
  return `${floor}${String(index).padStart(2, "0")}`;
}

/**
 * Price for a floor: base, plus the increment for every floor above the first.
 * Returns null when no base is given — a generated price of 0 would read as a
 * real number, and "not priced yet" is the honest state for a new unit.
 */
export function priceFor(
  spec: Pick<UnitGenerationSpec, "basePrice" | "pricePerFloor" | "floorFrom">,
  floor: number,
): number | null {
  if (spec.basePrice === null || spec.basePrice === undefined) return null;
  const step = spec.pricePerFloor ?? 0;
  return spec.basePrice + (floor - spec.floorFrom) * step;
}

/** How many rows a spec would produce, without building them. */
export function generatedCount(
  spec: Pick<UnitGenerationSpec, "floorFrom" | "floorTo" | "perFloor">,
): number {
  const floors = spec.floorTo - spec.floorFrom + 1;
  if (floors <= 0 || spec.perFloor <= 0) return 0;
  return floors * spec.perFloor;
}

/**
 * Build the rows. Ordered floor-ascending then index-ascending, which is the
 * order the units matrix displays them in, so a generated block reads the way
 * it was described.
 *
 * Validation lives in the action's schema, not here — this returns rows for a
 * spec that has already been checked, and `generatedCount` is what the caller
 * uses to enforce the ceiling before calling.
 */
export function generateUnits(spec: UnitGenerationSpec): GeneratedUnit[] {
  const startIndex = spec.startIndex ?? 1;
  const block = spec.block?.trim() || null;
  const units: GeneratedUnit[] = [];

  for (let floor = spec.floorFrom; floor <= spec.floorTo; floor++) {
    for (let i = 0; i < spec.perFloor; i++) {
      const unit_number = unitNumberFor(floor, startIndex + i);
      units.push({
        unit_number,
        block,
        floor_number: floor,
        bedrooms: spec.bedrooms ?? null,
        bathrooms: spec.bathrooms ?? null,
        covered_area_sqm: spec.coveredAreaSqm ?? null,
        asking_price: priceFor(spec, floor),
        label: `${block ?? ""}${unit_number}`,
      });
    }
  }

  return units;
}
