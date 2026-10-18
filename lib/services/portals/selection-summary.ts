import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { REASON_FIX_TAB, eligibilityFor, reasonText } from "./eligibility";
import { textIn } from "./feed-listing";
import {
  PORTAL_PROPERTY_COLUMNS,
  portalEligibilityInput,
  type PortalMediaRow,
  type PortalPropertyRow,
  type PortalReason,
} from "./property-portals";
import { PORTALS } from "./registry";

/**
 * Settings → Portals' view of every selected listing, per portal (portal
 * integrations audit 2026-10-18, finding 5 and the dashboard).
 *
 *   selected — rows in portal_listings for the portal
 *   offSite  — selected but no longer public and available on the website
 *              (sold, withdrawn, private…): they leave the feed on purpose,
 *              and are listed apart so a legitimate departure never reads as
 *              a failure
 *   inFeed   — on the website AND passing the portal's requirements: what
 *              the next request will be offered
 *   excluded — on the website but failing a requirement: each with its
 *              reasons and where to fix them
 *
 * A PREDICTION from the listing rows, through the SAME adapter the property
 * card and selectPortal use — not a reading of the feed. The pull record's
 * own counts (what the last request was actually served) sit beside it.
 *
 * One paged read of portal_listings, each row embedding its property (the
 * composite tenant key 0095 gave the table) with the property's names and
 * photos: no list of ids ever goes into a URL (BACKLOG "id lists" — a 414 at
 * a few hundred). Every table read is org-scoped for the admin by RLS.
 */

export interface SummaryListing {
  propertyId: string;
  reference: string;
  title: string;
}

export interface ExcludedListing extends SummaryListing {
  reasons: PortalReason[];
}

export interface OffSiteListing extends SummaryListing {
  status: string;
  visibility: string;
}

export interface PortalSelectionSummary {
  selected: number;
  inFeed: number;
  excluded: ExcludedListing[];
  offSite: OffSiteListing[];
}

type EmbeddedProperty = PortalPropertyRow & {
  id: string;
  reference: string;
  title: unknown;
  property_media: PortalMediaRow[] | null;
};

type SelectionRow = {
  portal: string;
  property_id: string;
  properties: EmbeddedProperty | null;
};

export async function buildPortalSelectionSummary(
  supabase: SupabaseClient<Database>,
): Promise<Map<string, PortalSelectionSummary>> {
  const rows = (await fetchAll<SelectionRow>(
    (from, to) =>
      supabase
        .from("portal_listings")
        .select(
          `portal, property_id, properties!portal_listings_org_property_fkey(id, reference, title, ${PORTAL_PROPERTY_COLUMNS}, property_media(kind, path_jpeg, width, height))`,
        )
        .order("property_id")
        .order("portal")
        .range(from, to) as unknown as PromiseLike<{ data: SelectionRow[] | null; error: { message: string } | null }>,
    "portal selections",
  )) as SelectionRow[];

  const out = new Map<string, PortalSelectionSummary>();
  for (const def of PORTALS) out.set(def.id, { selected: 0, inFeed: 0, excluded: [], offSite: [] });

  for (const r of rows) {
    const summary = out.get(r.portal);
    const p = r.properties;
    if (!summary || !p) continue; // a retired portal id, or a property this session cannot read
    const def = PORTALS.find((d) => d.id === r.portal)!;
    summary.selected++;
    const listing: SummaryListing = {
      propertyId: p.id,
      reference: p.reference,
      title: textIn(p.title, "en") || p.reference,
    };
    if (!(p.visibility === "public" && p.status === "available")) {
      summary.offSite.push({ ...listing, status: p.status, visibility: p.visibility });
      continue;
    }
    const e = eligibilityFor(def, portalEligibilityInput(p, p.property_media ?? []));
    if (e.ok) {
      summary.inFeed++;
    } else {
      summary.excluded.push({
        ...listing,
        // not_public cannot occur here (filtered above)
        reasons: e.reasons.map((reason) => ({ text: reasonText(def, reason), fixTab: REASON_FIX_TAB[reason] })),
      });
    }
  }
  for (const s of out.values()) {
    s.excluded.sort((a, b) => a.reference.localeCompare(b.reference));
    s.offSite.sort((a, b) => a.reference.localeCompare(b.reference));
  }
  return out;
}
