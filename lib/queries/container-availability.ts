import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { formatDate } from "@/lib/utils/format";
import { RETIRED_PROPERTY_VISIBILITY } from "@/lib/validators/properties";

/**
 * What is left in a development, and who holds what (review 2026-10-18, A05)
 * — the reads behind the units page's Hold column and, on a project that has
 * phases, its read-only availability across those phases.
 *
 * WHY A SECOND VIEW AND NOT A WIDER MATRIX. The matrix, the reprice form, the
 * price lists, the drift panel and the velocity card each act on ONE node's
 * direct units, by decision (0141's reviewed scope; lib/queries/
 * sales-velocity.ts). A phased project keeps its units under its phases, so its
 * own matrix is empty — and said "No units yet" over units that exist, while
 * the banner above it (container-units.ts) correctly said otherwise. The answer
 * to "what is left in this development" is this read-only view; editing stays
 * in each node's matrix, so no scope rule is bypassed.
 *
 * THE SAME DEFINITION OF "A UNIT" as container-units.ts: kind = unit, not
 * archived, under the project or one of its phases that is not archived.
 *
 * NO UNIT-ID LISTS. Units and holds are both filtered by PARENT — the node and
 * its phases, a handful — through the embedded `properties!inner(parent_id)`
 * on reservations (one key to properties, 0124's composite
 * reservations_org_property_fkey: unambiguous, checked on PostgREST v14.5).
 * The parents still go out in slices, so a project with an absurd number of
 * phases cannot reach the gateway's ~197-id 414. Every read is paged
 * (fetch-all.ts) over a unique order and de-duplicated by id: the pages are
 * separate snapshots, and a row inserted between two of them repeats.
 *
 * Read on the CALLER's client: RLS decides what they see, as on the matrix.
 * A failed read throws (fetchAll), to the page's error boundary — a hold that
 * could not be read is never shown as "no hold".
 */

/** Parent ids per request: 36 characters and a comma each, far below the gateway's limit. */
export const PARENTS_PER_READ = 100;

const LIVE_HOLD_STATUSES = ["held", "confirmed"] as const;

export interface LiveHold {
  reservationId: string;
  propertyId: string;
  status: (typeof LIVE_HOLD_STATUSES)[number];
  heldFrom: string;
  expiresAt: string;
  /** the buyer's display name; null when none is linked or RLS hides it (an erased buyer keeps the hold, 0044) */
  buyer: string | null;
}

export interface AvailabilityPhaseRow {
  id: string;
  reference: string;
  title: string | null;
  status: string;
  /** a phase's OWN date, severed from the project at creation (BACKLOG 11) */
  delivery_date: string | null;
  construction_status: string | null;
}

export interface AvailabilityUnitRow {
  id: string;
  parent_id: string | null;
  reference: string;
  unit_number: string | null;
  block: string | null;
  property_type: string;
  transaction_type: string;
  bedrooms: number | null;
  covered_area_sqm: number | null;
  asking_price: number | null;
  rent_price_month: number | null;
  status: string;
  delivery_date: string | null;
}

export interface ContainerAvailability {
  /** the project's phases that are not archived, by reference */
  phases: AvailabilityPhaseRow[];
  /** every unit under the project or those phases, not archived */
  units: AvailabilityUnitRow[];
}

function slices<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const uniqueById = <T extends { id: string }>(rows: readonly T[]): T[] => [
  ...new Map(rows.map((r) => [r.id, r])).values(),
];

/**
 * The live hold (held or confirmed) of every unit directly under `parentIds`,
 * by unit id. At most one per unit — 0044's partial unique index.
 */
export async function liveHoldsUnder(
  supabase: SupabaseClient<Database>,
  parentIds: readonly string[],
): Promise<Map<string, LiveHold>> {
  const parents = [...new Set(parentIds)];
  if (parents.length === 0) return new Map();
  const pages = await Promise.all(
    slices(parents, PARENTS_PER_READ).map((ids) =>
      fetchAll(
        (from, to) =>
          supabase
            .from("reservations")
            .select(
              "id, property_id, status, held_from, expires_at, contacts(display_name), properties!inner(parent_id, kind)",
            )
            .in("status", [...LIVE_HOLD_STATUSES])
            .in("properties.parent_id", ids)
            .eq("properties.kind", "unit")
            .order("id")
            .range(from, to),
        "live holds",
      ),
    ),
  );
  const holds = new Map<string, LiveHold>();
  for (const r of uniqueById(pages.flat())) {
    if (holds.has(r.property_id)) continue;
    const joined = r.contacts as { display_name: string | null } | { display_name: string | null }[] | null;
    const contact = Array.isArray(joined) ? (joined[0] ?? null) : joined;
    holds.set(r.property_id, {
      reservationId: r.id,
      propertyId: r.property_id,
      status: r.status as LiveHold["status"],
      heldFrom: r.held_from,
      expiresAt: r.expires_at,
      buyer: contact?.display_name ?? null,
    });
  }
  return holds;
}

const UNIT_SELECT =
  "id, parent_id, reference, unit_number, block, property_type, transaction_type, bedrooms, covered_area_sqm, asking_price, rent_price_month, status, delivery_date";

async function unitsUnder(
  supabase: SupabaseClient<Database>,
  parentIds: readonly string[],
): Promise<AvailabilityUnitRow[]> {
  const pages = await Promise.all(
    slices(parentIds, PARENTS_PER_READ).map((ids) =>
      fetchAll(
        (from, to) =>
          supabase
            .from("properties")
            .select(UNIT_SELECT)
            .in("parent_id", ids)
            .eq("kind", "unit")
            .neq("visibility", RETIRED_PROPERTY_VISIBILITY)
            .order("parent_id")
            .order("block")
            .order("unit_number")
            // a unique last key: pages over a non-unique order are not stable
            .order("id")
            .range(from, to),
        "availability units",
      ),
    ),
  );
  return uniqueById(pages.flat());
}

/**
 * Everything the units page shows about holds and availability for one node.
 *
 * `holds` covers the node's direct units — and, on a project with phases, every
 * unit under those phases too, so the matrix and the consolidated view read
 * ONE set. `overview` is null unless the node is a project with at least one
 * phase that is not archived: a phase's units are all its direct children, and
 * so is a flat project's, and the matrix already shows them.
 */
export async function fetchContainerAvailability(
  supabase: SupabaseClient<Database>,
  node: { id: string; kind: string },
): Promise<{ holds: Map<string, LiveHold>; overview: ContainerAvailability | null }> {
  if (node.kind !== "project") {
    return { holds: await liveHoldsUnder(supabase, [node.id]), overview: null };
  }
  const phaseRows = uniqueById(
    await fetchAll(
      (from, to) =>
        supabase
          .from("properties")
          .select("id, reference, title, status, delivery_date, construction_status")
          .eq("parent_id", node.id)
          .eq("kind", "phase")
          // an archived phase takes its units with it (container-units.ts)
          .neq("visibility", RETIRED_PROPERTY_VISIBILITY)
          .order("reference")
          .order("id")
          .range(from, to),
      "availability phases",
    ),
  );
  if (phaseRows.length === 0) {
    return { holds: await liveHoldsUnder(supabase, [node.id]), overview: null };
  }
  const parents = [node.id, ...phaseRows.map((p) => p.id)];
  const [units, holds] = await Promise.all([unitsUnder(supabase, parents), liveHoldsUnder(supabase, parents)]);
  return {
    holds,
    overview: {
      phases: phaseRows.map((p) => ({
        id: p.id,
        reference: p.reference,
        title: (p.title as { en?: string } | null)?.en ?? null,
        status: p.status,
        delivery_date: p.delivery_date,
        construction_status: p.construction_status,
      })),
      units,
    },
  };
}

/** What a unit's Hold cell says. */
export interface HoldView {
  /** "Held to 12 Nov 2026", "Confirmed to …", or the lapsed form; null = no live hold */
  label: string | null;
  buyer: string | null;
  /** past its expiry and still live: the nightly sweep (expire_reservations, 03:45) has not closed it yet */
  lapsed: boolean;
  /**
   * Where the unit's status and its hold disagree. The two are deliberately
   * NOT coupled (the reservation↔status auto-coupling was declined
   * 2026-08-26, lib/actions/reservations.ts), so they can — and the grid used
   * to show only one of them.
   */
  note: string | null;
}

const STATUS_WORDS: Record<string, string> = {
  draft: "Draft",
  available: "Available",
  reserved: "Reserved",
  under_offer: "Under offer",
  sold: "Sold",
  rented: "Rented",
  withdrawn: "Withdrawn",
};

/**
 * The Hold cell for a unit with this status and this live hold (or none),
 * against `now`. Computed on the server and handed to the grid as text, so the
 * client renders what the server said and nothing differs on hydration.
 */
export function describeHold(unitStatus: string, hold: LiveHold | null | undefined, now: Date): HoldView {
  const statusWord = STATUS_WORDS[unitStatus] ?? unitStatus.replace(/_/g, " ");
  if (!hold) {
    return {
      label: null,
      buyer: null,
      lapsed: false,
      note: unitStatus === "reserved" ? "Reserved, but no live hold is recorded" : null,
    };
  }
  const word = hold.status === "confirmed" ? "Confirmed" : "Held";
  const expires = new Date(hold.expiresAt);
  const lapsed = !Number.isNaN(expires.getTime()) && expires.getTime() <= now.getTime();
  const label = lapsed
    ? `${word} — lapsed ${formatDate(hold.expiresAt)}; the nightly sweep closes it`
    : `${word} to ${formatDate(hold.expiresAt)}`;
  let note: string | null = null;
  if (unitStatus === "available") note = "Status still says Available";
  else if (unitStatus !== "reserved" && unitStatus !== "under_offer")
    note = `Status says ${statusWord}, but the hold is still live`;
  return { label, buyer: hold.buyer, lapsed, note };
}
