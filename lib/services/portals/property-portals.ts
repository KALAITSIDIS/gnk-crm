import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { parseLocationPoint } from "@/lib/utils/geo";
import { eligibilityFor, eligibilityInputFromProperty, reasonText } from "./eligibility";
import { PORTALS, portalById } from "./registry";

/**
 * What the property page's Portals card is given (spec 2026-09-14 §Property
 * page). It lives here rather than in the page so it can be TESTED: the rules
 * below — which portals appear, in what order, and which of them can still be
 * removed — are judgements, and a judgement inside a 900-line server component
 * is a judgement nobody can put a test around.
 *
 * ROWS COME IN REGISTRY ORDER, not in whatever order PostgREST returned the
 * connections. `PORTALS` is the one list, the settings page renders it in that
 * order, and a card whose rows reshuffled between visits (an UPDATE moves a
 * row in an unordered select) would read as something having changed.
 *
 * A SWITCHED-OFF PORTAL KEEPS ITS SELECTIONS VISIBLE. Disabling a connection
 * does not delete `portal_listings` rows — 0095 keeps them, and re-enabling
 * puts every one of those listings back on the portal at its next pull. A card
 * that showed only enabled portals would hide that entirely: the desk would
 * believe a listing was off a portal when switching the portal back on would
 * silently publish it again. So a row appears when the connection is enabled
 * OR a selection exists, and the card offers Remove (never Select) for the
 * switched-off ones.
 */

export interface PortalRow {
  id: string;
  name: string;
  /** ok, or the desk sentences (already portal-specific) for each failing reason */
  eligibility: { ok: true } | { ok: false; reasons: string[] };
  selected: { at: string; byName: string | null } | null;
  lastPulledAt: string | null;
  /** false when the portal is switched off but this listing is still selected for it */
  connectionEnabled: boolean;
}

type PropertyRow = Database["public"]["Tables"]["properties"]["Row"];

/**
 * The narrowest slice of the page's property that answers the question: the
 * eight columns eligibility reads, the two that make a coordinate, and the
 * joined location names. Narrow because a test fixture for the whole row would
 * be ninety fields of noise around the ten that decide anything.
 */
export type PortalPropertyRow = Pick<
  PropertyRow,
  | "visibility"
  | "status"
  | "transaction_type"
  | "asking_price"
  | "rent_price_month"
  | "currency"
  | "public_description"
  | "property_type"
  | "location"
  | "location_approx"
> & { districts: { name: unknown } | null; areas: { name: unknown } | null };

/** Only what the photo counts need — the page's media rows satisfy it. */
export interface PortalMediaRow {
  kind: string;
  path_jpeg: string | null;
}

export interface PropertyPortals {
  rows: PortalRow[];
  /**
   * Set when some photographs have no JPEG rendition yet. The eligibility
   * reason says "fewer than N photos"; this says WHY the count is lower than
   * the gallery the desk is looking at, which is otherwise a contradiction
   * they cannot resolve from the screen.
   */
  photoNote: string | null;
}

export async function buildPropertyPortalRows(
  supabase: SupabaseClient<Database>,
  p: PortalPropertyRow,
  mediaRows: readonly PortalMediaRow[],
  propertyId: string,
): Promise<PropertyPortals> {
  // Neither read may fall through to an empty list on failure: an empty
  // connections list renders "No portal is enabled", which is the reassuring
  // direction and the wrong one — the desk would select a listing for a
  // portal it already sits on, or believe it sits on none.
  const [{ data: connections, error: connErr }, { data: selections, error: selErr }] =
    await Promise.all([
      supabase.from("portal_connections").select("portal, enabled, last_pulled_at"),
      supabase
        .from("portal_listings")
        .select("portal, selected_at, selected_by")
        .eq("property_id", propertyId),
    ]);
  if (connErr) throw new Error(`portal connections: ${connErr.message}`);
  if (selErr) throw new Error(`portal selections: ${selErr.message}`);

  const selectorIds = [...new Set((selections ?? []).map((s) => s.selected_by))].filter(
    (v): v is string => v !== null,
  );
  const selectorName = new Map<string, string | null>();
  if (selectorIds.length) {
    const { data: selectorProfiles, error: profileErr } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", selectorIds);
    // WHO selected it is cosmetic; THAT it is selected, for which portal and
    // when, is the fact, and that is already in hand. So a failed name read
    // degrades to no names rather than taking the whole property page down
    // with it — but it is never silent, because a profiles read failing is
    // itself worth knowing about.
    if (profileErr) {
      console.warn(`portal selector names unavailable: ${profileErr.message}`);
    }
    for (const row of selectorProfiles ?? []) selectorName.set(row.id, row.full_name);
  }

  const photoCount = mediaRows.filter((m) => m.kind === "photo").length;
  const jpegPhotoCount = mediaRows.filter((m) => m.kind === "photo" && m.path_jpeg).length;
  // The remedy — `npm run media:backfill-jpeg`, or re-uploading the
  // photograph — is nothing an agent can do from this page, so it stays here
  // rather than in the sentence they read. The sentence's whole job is to
  // stop the gallery and the portal's photo count looking like a
  // contradiction.
  const photoNote =
    jpegPhotoCount < photoCount
      ? `${photoCount - jpegPhotoCount} of ${photoCount} photos are not yet prepared for portals.`
      : null;

  const point = parseLocationPoint(p.location);
  // The SQL withholds the point of an approximate listing (0095
  // portal_supplement), so the feed's adapter gets `coords: null` for it; this
  // one must not promise the card what the pull will never carry.
  const portalInput = eligibilityInputFromProperty({
    ...p,
    districtName: p.districts?.name ?? null,
    areaName: p.areas?.name ?? null,
    jpegPhotoCount,
    coords: point && !p.location_approx ? { lat: point.lat, lng: point.lng, approx: false } : null,
  });

  const connectionByPortal = new Map((connections ?? []).map((c) => [c.portal, c]));
  const selectionByPortal = new Map((selections ?? []).map((s) => [s.portal, s]));
  // A connection naming a portal this build has never heard of cannot be
  // rendered — there is no name, no requirements and no renderer for it — but
  // dropping it without a word is how a retired or mistyped id goes unnoticed
  // while the desk wonders where the portal went.
  for (const c of connections ?? []) {
    if (!portalById(c.portal)) {
      console.warn(`portal_connections names "${c.portal}", which is not in the registry.`);
    }
  }

  const rows: PortalRow[] = [];
  for (const def of PORTALS) {
    const connection = connectionByPortal.get(def.id);
    const selection = selectionByPortal.get(def.id);
    if (!connection?.enabled && !selection) continue;
    const e = eligibilityFor(def, portalInput);
    rows.push({
      id: def.id,
      name: def.name,
      connectionEnabled: connection?.enabled ?? false,
      eligibility: e.ok
        ? { ok: true }
        : { ok: false, reasons: e.reasons.map((r) => reasonText(def, r)) },
      selected: selection
        ? {
            at: selection.selected_at,
            byName: selection.selected_by
              ? (selectorName.get(selection.selected_by) ?? null)
              : null,
          }
        : null,
      lastPulledAt: connection?.last_pulled_at ?? null,
    });
  }

  return { rows, photoNote };
}
