import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeVelocity,
  soldAtFromEvents,
  type VelocityResult,
  type VelocityUnit,
} from "@/lib/services/sales-velocity";

/**
 * Fetch what `computeVelocity` needs for one project (or phase) node.
 *
 * SCOPED THE SAME WAY THE UNITS PAGE IS — direct `kind = 'unit'` children. A
 * phased project keeps its units under the phases, so its own page already
 * shows an empty unit list and will show an empty velocity card to match; you
 * read velocity per phase, which is the more useful cut anyway. Recursing here
 * would make this one card disagree with every other number on the page.
 *
 * TWO ROUND TRIPS, NOT ONE, and the second is bounded by the number of SOLD
 * units rather than by the project size: only a sold unit can contribute a sale
 * date, so there is nothing to learn from the event history of the other
 * hundred. `events_entity_idx` is `(org_id, entity_type, entity_id,
 * occurred_at)`, which this hits directly.
 */
export async function fetchProjectVelocity(
  supabase: SupabaseClient<Database>,
  projectId: string,
  now: Date = new Date(),
): Promise<VelocityResult> {
  const { data: unitRows, error: unitErr } = await supabase
    .from("properties")
    // org_id comes back so the event read below (which runs as the system) has
    // an explicit boundary taken from a row RLS already returned
    .select("id, status, asking_price, org_id")
    .eq("parent_id", projectId)
    .eq("kind", "unit");
  if (unitErr) throw new Error(`Velocity unit query failed: ${unitErr.message}`);

  const units: VelocityUnit[] = (unitRows ?? []).map((u) => ({
    id: u.id,
    status: u.status,
    soldAt: null,
    askingPrice: u.asking_price,
  }));

  const soldIds = units.filter((u) => u.status === "sold").map((u) => u.id);
  if (soldIds.length === 0) return computeVelocity(units, now);

  /*
   * READ AS THE SYSTEM — this is a METRIC, and a metric must not vary by reader.
   *
   * `events_select` (0063) shows a non-admin only the rows they authored, so on
   * the caller's client "when did each unit sell" became "when did each unit
   * sell BY MY HAND". A unit a colleague marked sold had no visible sale date,
   * `soldAtFromEvents` returned null for it, and the card reported a different
   * velocity to every person who opened it — a wrong number rather than an
   * empty one, which is the worse failure of the two.
   *
   * Same contract as lib/services/entity-timeline.ts: the ids come from a units
   * read on the CALLER's client, and org_id is filtered explicitly because the
   * admin client has no RLS to do it.
   */
  const orgId = (unitRows ?? [])[0]?.org_id as string | undefined;
  if (!orgId) return computeVelocity(units, now);

  const { data: eventRows, error: eventErr } = await createAdminClient()
    .from("events")
    .select("entity_id, event_type, occurred_at, payload")
    .eq("org_id", orgId)
    .eq("entity_type", "property")
    .in("entity_id", soldIds)
    // both shapes — the units grid writes status_changed, the details form
    // writes updated with a per-field diff (see sales-velocity.ts)
    .in("event_type", ["status_changed", "updated"])
    .order("occurred_at", { ascending: true });
  if (eventErr) throw new Error(`Velocity event query failed: ${eventErr.message}`);

  const byUnit = new Map<string, { event_type: string; occurred_at: string; payload: unknown }[]>();
  for (const e of eventRows ?? []) {
    if (!e.entity_id) continue;
    const list = byUnit.get(e.entity_id) ?? [];
    list.push({ event_type: e.event_type, occurred_at: e.occurred_at, payload: e.payload });
    byUnit.set(e.entity_id, list);
  }

  for (const u of units) {
    if (u.status !== "sold") continue;
    u.soldAt = soldAtFromEvents(byUnit.get(u.id) ?? []);
  }

  return computeVelocity(units, now);
}
