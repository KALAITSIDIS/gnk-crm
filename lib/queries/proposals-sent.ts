import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { rowsOf } from "@/lib/supabase/rows";

/**
 * Which listings were already proposed to which buyer (A04) — read from the
 * proposal links themselves: `share_links.contact_id` (0139 binds it to the
 * organisation) and the link's curation in `share_link_properties`. Nothing
 * new is recorded; a link minted for a buyer IS the record that they were sent
 * it. Unbound links (minted on /share-links without a buyer) name nobody and
 * are not counted here.
 *
 * READ ON THE CALLER'S CLIENT: `share_links_select` is organisation-wide for
 * every staff role (0023, hoisted in 0147), so every colleague sees what the
 * desk already sent.
 *
 * BOUNDED AND LOUD. The latest PROPOSAL_HISTORY_LIMIT links, uniquely ordered
 * (created_at, id), never an id list in the URL (T-worklist-id-lists). A read
 * that fails, or answers with no rows array, is `{ ok: false }` — the caller
 * says "proposal history unavailable", never "not proposed" — and a full page
 * is `capped`, so an older proposal past the limit is not read as none.
 */

type Client = SupabaseClient<Database>;

export const PROPOSAL_HISTORY_LIMIT = 100;

export interface SentProposal {
  id: string;
  contactId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** counted by the public page on every open — link previews (a chat app's unfurl) count too */
  viewCount: number;
  /**
   * The listings it holds. For `proposalsForContact` all of them; for
   * `proposalsForProperty` only the one asked about (the inner filter).
   */
  propertyIds: string[];
}

export type ProposalHistory =
  | { ok: true; proposals: SentProposal[]; capped: boolean }
  | { ok: false };

const LINK_COLUMNS = "id, contact_id, created_at, expires_at, revoked_at, view_count";

type LinkRow = {
  id: string;
  contact_id: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  view_count: number | null;
  share_link_properties: { property_id: string }[] | null;
};

/** A row with no curation array, or no buyer, is a hollow answer — the whole read is then unknown. */
function toProposals(rows: LinkRow[]): SentProposal[] | null {
  const out: SentProposal[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.share_link_properties) || !r.contact_id) return null;
    out.push({
      id: r.id,
      contactId: r.contact_id,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      viewCount: Number(r.view_count ?? 0),
      propertyIds: r.share_link_properties.map((p) => p.property_id),
    });
  }
  return out;
}

async function settle(read: PromiseLike<{ data: unknown; error: unknown; status?: number }>, label: string): Promise<ProposalHistory> {
  try {
    const rows = rowsOf((await read) as { data: LinkRow[] | null; error: unknown; status?: number }, label);
    const proposals = toProposals(rows);
    if (!proposals) return { ok: false };
    return { ok: true, proposals, capped: rows.length >= PROPOSAL_HISTORY_LIMIT };
  } catch {
    return { ok: false };
  }
}

/** Every proposal minted for this buyer, newest first, with the listings each held. */
export function proposalsForContact(supabase: Client, contactId: string): Promise<ProposalHistory> {
  return settle(
    supabase
      .from("share_links")
      .select(`${LINK_COLUMNS}, share_link_properties(property_id)`)
      .eq("kind", "proposal")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PROPOSAL_HISTORY_LIMIT),
    "proposals for this contact",
  );
}

/**
 * Every buyer-bound proposal that holds this listing, newest first. The inner
 * embed both filters the links and narrows each one's curation to this row.
 * `share_link_properties` has no index on `property_id` (0023 keys it by link
 * first) — a sequential scan, trivial at today's volume; BACKLOG if it grows.
 */
export function proposalsForProperty(supabase: Client, propertyId: string): Promise<ProposalHistory> {
  return settle(
    supabase
      .from("share_links")
      .select(`${LINK_COLUMNS}, share_link_properties!inner(property_id)`)
      .eq("kind", "proposal")
      .not("contact_id", "is", null)
      .eq("share_link_properties.property_id", propertyId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PROPOSAL_HISTORY_LIMIT),
    "proposals holding this listing",
  );
}

/**
 * The newest proposal per key — per listing on the contact side, per buyer on
 * the property side. The proposals arrive newest first, so the first one seen
 * for a key wins.
 */
export function latestProposalBy(
  proposals: readonly SentProposal[],
  key: "property" | "contact",
): Map<string, SentProposal> {
  const out = new Map<string, SentProposal>();
  for (const p of proposals) {
    const keys = key === "property" ? p.propertyIds : [p.contactId];
    for (const k of keys) if (!out.has(k)) out.set(k, p);
  }
  return out;
}
