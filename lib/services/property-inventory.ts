import {
  PROPERTY_KINDS,
  PROPERTY_STATUSES,
  RETIRED_PROPERTY_STATUS,
} from "@/lib/validators/properties";

/**
 * The admin dashboard's Inventory card (F04-C), as pure rules: what
 * `property_inventory_counts()` (migration 0153) may answer, how its rows add
 * up, and which list each number opens.
 *
 * WHAT IS COUNTED. Live records — not archived and not withdrawn, exactly the
 * properties list's default scope — per kind and status. Every number links
 * to the list that shows the same rows: a (status, kind) chip to
 * `/properties?status=S&kind=K`, a status total to `?status=S&kind=all`. A
 * project or a phase is ONE record; its units are records of their own. So a
 * status total counts records and is not a stock figure.
 *
 * WHAT IS SALEABLE. A standalone listing and a unit. A project or phase is a
 * container: it cannot be reserved and is excluded from matching
 * (lib/services/quality-score.ts) — counting it as stock beside its own units
 * is the double count F04 found. "Saleable available" is therefore available
 * listings + available units, never a container.
 */

export type PropertyKind = (typeof PROPERTY_KINDS)[number];
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];
/** A status the function can answer: withdrawn is outside the live scope. */
export type LiveStatus = Exclude<PropertyStatus, typeof RETIRED_PROPERTY_STATUS>;

export const LIVE_STATUSES: readonly LiveStatus[] = PROPERTY_STATUSES.filter(
  (s): s is LiveStatus => s !== RETIRED_PROPERTY_STATUS,
);

export interface InventoryCount {
  kind: PropertyKind;
  status: LiveStatus;
  n: number;
}

const isKind = (v: unknown): v is PropertyKind =>
  typeof v === "string" && (PROPERTY_KINDS as readonly string[]).includes(v);
const isLiveStatus = (v: unknown): v is LiveStatus =>
  typeof v === "string" && (LIVE_STATUSES as readonly string[]).includes(v);

/**
 * Read the function's rows, or fail. Anything it cannot have answered — an
 * unknown kind, a withdrawn or unknown status, a count that is not a
 * positive whole number (a group-by never answers 0), the same pair twice —
 * means the database is not running 0153's function, and the card must say
 * so through the error boundary rather than paint a wrong number.
 * PostgREST renders bigint as a JSON number: no string coercion.
 */
export function parseInventoryCounts(rows: readonly unknown[]): InventoryCount[] {
  const seen = new Set<string>();
  return rows.map((row, i) => {
    const r = (row ?? {}) as Record<string, unknown>;
    if (!isKind(r.kind) || !isLiveStatus(r.status)) {
      throw new Error(
        `Query failed (inventory counts): row ${i} is not a live kind and status (${JSON.stringify(r.kind)}, ${JSON.stringify(r.status)})`,
      );
    }
    if (typeof r.n !== "number" || !Number.isSafeInteger(r.n) || r.n < 1) {
      throw new Error(`Query failed (inventory counts): row ${i} has no whole count (${JSON.stringify(r.n)})`);
    }
    const key = `${r.kind}/${r.status}`;
    if (seen.has(key)) throw new Error(`Query failed (inventory counts): ${key} answered twice`);
    seen.add(key);
    return { kind: r.kind, status: r.status, n: r.n };
  });
}

export interface StatusInventory {
  status: LiveStatus;
  /** records of every kind — what `?status=S&kind=all` lists */
  total: number;
  /** non-zero kinds only, in PROPERTY_KINDS order; they sum to `total` */
  kinds: { kind: PropertyKind; n: number }[];
}

export interface InventorySummary {
  /** statuses with at least one live record, in PROPERTY_STATUSES order */
  statuses: StatusInventory[];
  /** available listings + available units — never a container */
  saleableAvailable: { total: number; listings: number; units: number };
}

export function summarizeInventory(counts: readonly InventoryCount[]): InventorySummary {
  const n = (status: LiveStatus, kind: PropertyKind) =>
    counts.find((c) => c.status === status && c.kind === kind)?.n ?? 0;

  const statuses = LIVE_STATUSES.map((status) => {
    const kinds = PROPERTY_KINDS.map((kind) => ({ kind, n: n(status, kind) })).filter((k) => k.n > 0);
    return { status, total: kinds.reduce((sum, k) => sum + k.n, 0), kinds };
  }).filter((s) => s.total > 0);

  // the two saleable kinds; a project or phase is never stock
  const listings = n("available", "standalone");
  const units = n("available", "unit");
  return { statuses, saleableAvailable: { total: listings + units, listings, units } };
}

/** `kind=all` is the list's every-kind view; without a kind the list hides units. */
export type InventoryKindLink = PropertyKind | "all";

/** The properties list showing exactly the rows a number counts. */
export function inventoryListHref(status: LiveStatus, kind: InventoryKindLink): string {
  return `/properties?${new URLSearchParams({ status, kind }).toString()}`;
}

/** Everything the card leaves out: withdrawn or archived, every kind. */
export const RETIRED_INVENTORY_HREF = `/properties?${new URLSearchParams({ scope: "archived", kind: "all" }).toString()}`;
