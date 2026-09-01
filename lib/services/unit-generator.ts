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
  /** Null for villas — they do not stack, and writing 1 would be a lie the
   *  units matrix and the availability share both print. */
  floor_number: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  covered_area_sqm: number | null;
  /** Villas normally have their own plot; a stacked unit does not. */
  plot_area_sqm: number | null;
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
        plot_area_sqm: null,
        asking_price: priceFor(spec, floor),
        label: `${block ?? ""}${unit_number}`,
      });
    }
  }

  return units;
}

/* ========================================================================== *
 * VILLAS — the same job, a different shape.
 *
 * A villa complex has no floors, so the floor grid above cannot describe it:
 * its labels come out "101…1NN" (an apartment number that would reach a
 * proposal), it would write floor_number = 1 on every villa (a lie the matrix
 * and the availability share both print), and a per-villa price ladder is not
 * expressible at all.
 *
 * Kept BESIDE generateUnits rather than folded into it: every exported piece
 * above is floor-shaped and pinned by floor-named tests, and a discriminator
 * would push branching into generatedCount, priceFor and the spec type — four
 * places changed to save one loop. The two share their OUTPUT type, which is
 * the contract the action actually depends on, so the insert, the collision
 * check and the events are untouched.
 * ========================================================================== */

export interface VillaGenerationSpec {
  /** Goes before the number: "V" gives V01…V12. Empty means bare numbers. */
  prefix?: string | null;
  count: number;
  /** First number — 1 gives V01. Mirrors `startIndex` above. */
  startNumber?: number;
  bedrooms?: number | null;
  bathrooms?: number | null;
  coveredAreaSqm?: number | null;
  plotAreaSqm?: number | null;
  /** Price of the first villa. */
  basePrice?: number | null;
  /** Added per villa after the first — a plot-by-plot ladder, if there is one. */
  pricePerVilla?: number | null;
}

/** How many rows a villa spec would produce, without building them. */
export function villaCount(spec: Pick<VillaGenerationSpec, "count">): number {
  return Number.isInteger(spec.count) && spec.count > 0 ? spec.count : 0;
}

/**
 * Zero-padded to the width of the run: 12 villas give V01…V12, not V1…V12.
 * The units matrix and the availability share both order by `unit_number` as
 * TEXT, so unpadded numbers read V1, V10, V11, V2 — the floor scheme already
 * has that wart above floor 9 and one instance of it is enough.
 */
export function villaNumberFor(prefix: string | null, n: number, width: number): string {
  return `${prefix ?? ""}${String(n).padStart(width, "0")}`;
}

/** Price of the nth villa (n counted from the first). Null base ⇒ null price. */
export function villaPriceFor(
  spec: Pick<VillaGenerationSpec, "basePrice" | "pricePerVilla">,
  offset: number,
): number | null {
  if (spec.basePrice === null || spec.basePrice === undefined) return null;
  return spec.basePrice + offset * (spec.pricePerVilla ?? 0);
}

export function generateVillaUnits(spec: VillaGenerationSpec): GeneratedUnit[] {
  const total = villaCount(spec);
  if (total === 0) return [];
  const start = spec.startNumber ?? 1;
  const prefix = spec.prefix?.trim() || null;
  // width of the LAST number, so the whole run pads consistently
  const width = Math.max(2, String(start + total - 1).length);

  const units: GeneratedUnit[] = [];
  for (let i = 0; i < total; i++) {
    const unit_number = villaNumberFor(prefix, start + i, width);
    units.push({
      unit_number,
      // `block` is the repricing/scope axis (blocksOf, applyUnitType) — a "V"
      // block would show up as a scope that means nothing. Left free.
      block: null,
      floor_number: null,
      bedrooms: spec.bedrooms ?? null,
      bathrooms: spec.bathrooms ?? null,
      covered_area_sqm: spec.coveredAreaSqm ?? null,
      plot_area_sqm: spec.plotAreaSqm ?? null,
      asking_price: villaPriceFor(spec, i),
      label: unit_number,
    });
  }
  return units;
}
