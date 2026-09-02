import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * What "a unit" means for a container (2026-09-02, post-merge review).
 *
 * The first cut counted every child row of a project — and a PHASE is a child
 * row. A project holding one empty phase and no units satisfied the "at least
 * one unit" score item and slipped past the non-overridable publish refusal,
 * which is the exact incident that refusal was shipped to prevent. Worse, a
 * project whose units live UNDER its phases (units.parent_id = the phase) has
 * zero direct unit children, so it passed only by counting the phases.
 *
 * One definition, used by the publish gate, the score, the worklist, the
 * detail page and the units-page banner, so they cannot disagree:
 *
 *   rows with kind = 'unit', not archived, whose parent is the container
 *   OR any of the container's phases.
 *
 * Sold and reserved units still count — a development whose every unit has
 * sold is still a development that existed. Archived units do not: archiving
 * is how a unit is removed here (there is no hard delete), and a container
 * whose units were all archived is empty again.
 *
 * Errors THROW rather than read as zero. In the gate a failed count must fail
 * closed (an empty container must not publish because a query hiccupped its
 * way to "0 ≠ 0"); on a page it renders the error boundary, which is the
 * house rule for a genuine query failure.
 */
export interface ContainerUnitFacts {
  /** sellable units under the container, directly or through its phases */
  unitCount: number;
  /** of those, the ones carrying an asking price — the container's "price set" */
  pricedUnitCount: number;
  /** phases directly under the container — for copy, never for the gate */
  phaseCount: number;
}

export const EMPTY_CONTAINER_FACTS: ContainerUnitFacts = {
  unitCount: 0,
  pricedUnitCount: 0,
  phaseCount: 0,
};

export async function countContainerUnits(
  supabase: SupabaseClient<Database>,
  containerId: string,
): Promise<ContainerUnitFacts> {
  const { data: phases, error: phaseErr } = await supabase
    .from("properties")
    .select("id")
    .eq("parent_id", containerId)
    .eq("kind", "phase");
  if (phaseErr) throw new Error(`Container phase query failed: ${phaseErr.message}`);

  const parents = [containerId, ...(phases ?? []).map((p) => p.id)];
  // rows, not a head count: a development holds at most a few hundred units
  // and the priced count needs the column
  const { data: units, error: unitErr } = await supabase
    .from("properties")
    .select("id, asking_price, rent_price_month")
    .in("parent_id", parents)
    .eq("kind", "unit")
    .neq("visibility", "archived");
  if (unitErr) throw new Error(`Container unit query failed: ${unitErr.message}`);

  const rows = units ?? [];
  return {
    unitCount: rows.length,
    // a let unit is priced by its rent — a rent development's units carry
    // rent_price_month, never asking_price
    pricedUnitCount: rows.filter((u) => u.asking_price !== null || u.rent_price_month !== null)
      .length,
    phaseCount: (phases ?? []).length,
  };
}

/**
 * The same definition over rows already in memory — what the quality
 * worklist uses, because it scores a whole portfolio from three queries and
 * must not add one per container. Only kind = unit counts; a unit under a
 * phase counts for the phase AND for the project above it. Callers pass rows
 * that already exclude archived units (the worklist's query does).
 */
export interface TallyRow {
  id: string;
  kind: string;
  parent_id: string | null;
  asking_price: number | string | null;
  /** a let unit's price — absent on rows selected without it */
  rent_price_month?: number | string | null;
}

export function tallyContainerUnits(
  rows: readonly TallyRow[],
): Map<string, { unitCount: number; pricedUnitCount: number }> {
  const phaseParent = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "phase" && row.parent_id) phaseParent.set(row.id, row.parent_id);
  }
  const tally = new Map<string, { unitCount: number; pricedUnitCount: number }>();
  const credit = (containerId: string, priced: boolean) => {
    const t = tally.get(containerId) ?? { unitCount: 0, pricedUnitCount: 0 };
    t.unitCount += 1;
    if (priced) t.pricedUnitCount += 1;
    tally.set(containerId, t);
  };
  for (const row of rows) {
    if (row.kind !== "unit" || !row.parent_id) continue;
    const priced = row.asking_price !== null || (row.rent_price_month ?? null) !== null;
    credit(row.parent_id, priced);
    const project = phaseParent.get(row.parent_id);
    if (project) credit(project, priced);
  }
  return tally;
}
