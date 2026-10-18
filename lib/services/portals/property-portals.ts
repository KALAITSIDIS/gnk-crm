import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { parseLocationPoint } from "@/lib/utils/geo";
import {
  REASON_FIX_TAB,
  advisoriesFor,
  eligibilityFor,
  eligibilityInputFromProperty,
  reasonText,
  type EligibilityInput,
} from "./eligibility";
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
 * puts every one of those listings back in that portal's feed at its next
 * request. A card that showed only enabled portals would hide that entirely.
 * So a row appears when the connection is enabled OR a selection exists, and
 * the card offers Remove (never Select) for the switched-off ones.
 *
 * WHAT A ROW CLAIMS (portal integrations audit 2026-10-18, finding 7). The CRM
 * knows three things: that a listing is SELECTED, whether it passes the
 * portal's requirements and so is IN THE FEED the portal is offered, and when
 * the feed URL was last REQUESTED. It never learns whether the portal accepted
 * or published the listing. Each row's `state` says only the first two; the
 * card says the third in so many words.
 */

export type PortalRowState = "in_feed" | "excluded" | "off_site" | "switched_off" | "not_selected";

export interface PortalReason {
  text: string;
  /** where on this listing's page the desk fixes it (`?tab=`), or null */
  fixTab: "details" | "marketing" | "media" | null;
}

export interface PortalRow {
  id: string;
  name: string;
  state: PortalRowState;
  /** ok, or the desk sentences (already portal-specific) for each failing reason */
  eligibility: { ok: true } | { ok: false; reasons: PortalReason[] };
  /** what the portal's own moderation may still refuse, or the format cannot carry */
  advisories: string[];
  selected: { at: string; byName: string | null } | null;
  /** when ANY caller last requested the feed URL (0150 record_portal_pull) — not proof the portal did */
  lastRequestedAt: string | null;
  /** false when the portal is switched off but this listing is still selected for it */
  connectionEnabled: boolean;
  /** where the desk sees whether the portal published it (registry publicationCheck) */
  publicationCheck: string;
}

type PropertyRow = Database["public"]["Tables"]["properties"]["Row"];

/**
 * The narrowest slice of a property that answers the question: the eight
 * columns eligibility reads, the two that make a coordinate, and the joined
 * location names. Narrow because a test fixture for the whole row would be
 * ninety fields of noise around the ten that decide anything.
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

/** The columns of a property row `portalEligibilityInput` needs, as a PostgREST select. */
export const PORTAL_PROPERTY_COLUMNS =
  "visibility, status, transaction_type, asking_price, rent_price_month, currency, public_description, property_type, location, location_approx, districts(name), areas(name)";

/** Only what the photo counts need — the page's media rows satisfy it. */
export interface PortalMediaRow {
  kind: string;
  path_jpeg: string | null;
  width?: number | null;
  height?: number | null;
}

/**
 * THE ONE ADAPTER from a property row and its media to what eligibility
 * reads — shared by the property card, Settings → Portals and selectPortal,
 * so the three can never disagree about whether a listing is in a feed.
 */
export function portalEligibilityInput(p: PortalPropertyRow, mediaRows: readonly PortalMediaRow[]): EligibilityInput {
  const point = parseLocationPoint(p.location);
  return eligibilityInputFromProperty({
    ...p,
    districtName: p.districts?.name ?? null,
    areaName: p.areas?.name ?? null,
    jpegPhotos: mediaRows
      .filter((m) => m.kind === "photo" && m.path_jpeg)
      .map((m) => ({ width: m.width ?? null, height: m.height ?? null })),
    // The SQL withholds the point of an approximate listing (0150
    // portal_feed_supplement), so the feed's adapter gets `coords: null` for
    // it; this one must not promise what the pull will never carry.
    coords: point && !p.location_approx ? { lat: point.lat, lng: point.lng, approx: false } : null,
  });
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
  // portal it already sits on, or believe it sits on none. A hollow answer
  // (no rows array at all) is a failure too.
  const [connRes, selRes] = await Promise.all([
    supabase.from("portal_connections").select("portal, enabled, last_pulled_at"),
    supabase
      .from("portal_listings")
      .select("portal, selected_at, selected_by")
      .eq("property_id", propertyId),
  ]);
  if (connRes.error) throw new Error(`portal connections: ${connRes.error.message}`);
  if (selRes.error) throw new Error(`portal selections: ${selRes.error.message}`);
  if (!Array.isArray(connRes.data)) throw new Error("portal connections: the answer held no rows");
  if (!Array.isArray(selRes.data)) throw new Error("portal selections: the answer held no rows");
  const connections = connRes.data;
  const selections = selRes.data;

  const selectorIds = [...new Set(selections.map((s) => s.selected_by))].filter(
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
    // with it — but it is never silent.
    if (profileErr) {
      console.warn(`portal selector names unavailable: ${profileErr.message}`);
    }
    for (const row of selectorProfiles ?? []) selectorName.set(row.id, row.full_name);
  }

  const photoCount = mediaRows.filter((m) => m.kind === "photo").length;
  const jpegPhotoCount = mediaRows.filter((m) => m.kind === "photo" && m.path_jpeg).length;
  // The remedy — `npm run media:backfill-jpeg`, or re-uploading the
  // photograph — is nothing an agent can do from this page, so it stays here
  // rather than in the sentence they read.
  const photoNote =
    jpegPhotoCount < photoCount
      ? `${photoCount - jpegPhotoCount} of ${photoCount} photos are not yet prepared for portals.`
      : null;

  const portalInput = portalEligibilityInput(p, mediaRows);

  const connectionByPortal = new Map(connections.map((c) => [c.portal, c]));
  const selectionByPortal = new Map(selections.map((s) => [s.portal, s]));
  // A connection naming a portal this build has never heard of cannot be
  // rendered, but dropping it without a word is how a retired or mistyped id
  // goes unnoticed while the desk wonders where the portal went.
  for (const c of connections) {
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
    const enabled = connection?.enabled ?? false;
    // A listing that left the website (sold, withdrawn, private…) is not sent
    // ON PURPOSE — the same split Settings → Portals makes — never a failure
    // to fix: offering to "fix" it would invite putting it back on sale.
    const state: PortalRowState = !selection
      ? "not_selected"
      : !enabled
        ? "switched_off"
        : !portalInput.isPublic
          ? "off_site"
          : e.ok
            ? "in_feed"
            : "excluded";
    rows.push({
      id: def.id,
      name: def.name,
      state,
      connectionEnabled: enabled,
      eligibility: e.ok
        ? { ok: true }
        : { ok: false, reasons: e.reasons.map((r) => ({ text: reasonText(def, r), fixTab: REASON_FIX_TAB[r] })) },
      advisories: advisoriesFor(def, portalInput),
      selected: selection
        ? {
            at: selection.selected_at,
            byName: selection.selected_by
              ? (selectorName.get(selection.selected_by) ?? null)
              : null,
          }
        : null,
      lastRequestedAt: connection?.last_pulled_at ?? null,
      publicationCheck: def.publicationCheck,
    });
  }

  return { rows, photoNote };
}
