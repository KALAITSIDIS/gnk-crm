import { BUYER_META_KEYS, SELLER_META_KEYS, cleanEnquiryMeta } from "@/lib/services/enquiry-meta";
import { LEAD_MESSAGE_REDACTED } from "@/lib/services/erasure";
import { mayEditBuyerRequirements } from "@/lib/validators/buyer-requirements";

/**
 * Whether a lead's contact has a saved search — on the inbox row (A04), so the
 * desk qualifying a buyer sees, where it works the lead, whether the matcher
 * has anything to go on.
 *
 * ONE READ, NOT ONE PER ROW. The inbox's own select embeds the contact's
 * searches, narrowed IN the embed to active ones and at most one per contact
 * (the filter and the limit below, applied on the inbox query): the row needs
 * "is there one", not the list. PostgREST applies both to the embedded rows
 * only, so a lead whose contact has none still comes back — with `[]`.
 *
 * NEVER "NONE" FOR "UNKNOWN": an embed that did not come back as an array
 * (an old deploy's select, a hollow answer) is `unknown`, and the row then
 * offers no "add one" it cannot vouch for.
 */

/** the inbox's contact embed: the row's fields, the lifecycle, and the searches */
export const LEAD_CONTACT_EMBED =
  "contacts(id, display_name, phone_e164, telegram_username, has_whatsapp, is_archived, erased_at, buyer_requirements(id))";

/** only ACTIVE searches count (an archived one is retired) — applied as `.eq(...ACTIVE_SEARCH_FILTER)` */
export const ACTIVE_SEARCH_FILTER = ["contacts.buyer_requirements.is_active", true] as const;
/** and one is enough to answer "is there one" — applied as `.limit(1, { referencedTable })` */
export const SEARCH_EMBED_TABLE = "contacts.buyer_requirements";

export type SavedSearchState = "has" | "none" | "unknown";

export function savedSearchState(contact: { buyer_requirements?: unknown } | null): SavedSearchState {
  if (!contact) return "unknown";
  const rows = contact.buyer_requirements;
  if (!Array.isArray(rows)) return "unknown";
  return rows.length > 0 ? "has" : "none";
}

/**
 * Whether the row offers anything about saved searches at all, and whether it
 * offers "Save brief as search". Mirrors `saveSearchFromEnquiry`'s refusals so
 * the button is shown only where the action can succeed (the action re-checks
 * every one of them):
 *
 *   - a linked lead only — a search belongs to a contact;
 *   - not a SELLER's brief: a seller enquiry has nothing to search for, and
 *     "No saved search" on it would be noise;
 *   - "Save brief as search" only on a website lead with a buyer's answers in
 *     its brief, not redacted, whose contact is neither archived nor erased,
 *     has no active search, and when the viewer's role may record one.
 */
export function savedSearchOffer(input: {
  lead: { source: string; message: string | null; criteria: unknown; contact_id: string | null };
  contact: { is_archived?: boolean | null; erased_at?: string | null } | null;
  state: SavedSearchState;
  role: string;
}): { show: boolean; canSaveBrief: boolean; canAdd: boolean } {
  const { lead, contact, state, role } = input;
  const none = { show: false, canSaveBrief: false, canAdd: false };
  if (!lead.contact_id || !contact) return none;
  const meta = cleanEnquiryMeta(lead.criteria);
  const buyerBrief = BUYER_META_KEYS.some((k) => meta[k]);
  const sellerBrief = SELLER_META_KEYS.some((k) => meta[k]);
  if (sellerBrief && !buyerBrief && state !== "has") return none;
  const mayEdit = mayEditBuyerRequirements(role, {
    isArchived: Boolean(contact.is_archived),
    isErased: Boolean(contact.erased_at),
  });
  // a frozen contact with no search: nothing to show and nothing to add
  if (!mayEdit && state !== "has") return none;
  return {
    show: true,
    canAdd: mayEdit && state === "none",
    canSaveBrief:
      mayEdit &&
      state === "none" &&
      lead.source === "website" &&
      buyerBrief &&
      lead.message !== LEAD_MESSAGE_REDACTED,
  };
}
