import type { Database } from "@/lib/supabase/database.types";

type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];
type ContactUpdate = Database["public"]["Tables"]["contacts"]["Update"];

/**
 * Pure backfill calculation for contact merges (doc 02 §C3): the primary wins
 * every conflict, empty primary fields inherit the duplicate's values, and a
 * conflicting duplicate phone is preserved in `additional_phones` so dedup
 * still catches it. Lives outside the "use server" action file so it can be
 * unit-tested (and because such files may only export async functions).
 */

export interface MergeBackfillResult {
  updates: ContactUpdate;
  /** Conflicting duplicate values that could NOT be kept — recorded on the merge event. */
  dropped: Record<string, string>;
}

const sortedUnion = (...lists: (string[] | null | undefined)[]): string[] =>
  [...new Set(lists.flatMap((l) => l ?? []))].sort();

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

const isEmptyJson = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Marker used for idempotent note appends — a resumed merge must not double-append. */
export function mergeNoteMarker(duplicate: Pick<ContactRow, "id" | "display_name">): string {
  return `— merged from ${duplicate.display_name ?? "Unnamed"} [${duplicate.id.slice(0, 8)}]`;
}

export function buildMergeBackfill(
  primary: ContactRow,
  duplicate: ContactRow,
): MergeBackfillResult {
  const updates: ContactUpdate = {};
  const dropped: Record<string, string> = {};

  // phone: inherit when the primary has none; otherwise keep the duplicate's
  // number reachable via additional_phones
  if (!primary.phone_e164 && duplicate.phone_e164) {
    updates.phone_e164 = duplicate.phone_e164;
    updates.phone_raw = duplicate.phone_raw;
  }
  const finalPrimaryPhone = updates.phone_e164 ?? primary.phone_e164;
  const extraPhones = sortedUnion(
    primary.additional_phones,
    duplicate.additional_phones,
    primary.phone_e164 && duplicate.phone_e164 && duplicate.phone_e164 !== primary.phone_e164
      ? [duplicate.phone_e164]
      : [],
  ).filter((p) => p !== finalPrimaryPhone);
  if (!sameSet(extraPhones, primary.additional_phones ?? [])) {
    updates.additional_phones = extraPhones;
  }

  if (!primary.email && duplicate.email) updates.email = duplicate.email;
  else if (primary.email && duplicate.email && primary.email !== duplicate.email) {
    dropped.email = duplicate.email;
  }

  if (!primary.telegram_username && duplicate.telegram_username) {
    updates.telegram_username = duplicate.telegram_username;
  }
  if (!primary.nationality && duplicate.nationality) updates.nationality = duplicate.nationality;
  if (!primary.psychology && duplicate.psychology) updates.psychology = duplicate.psychology;
  if (!primary.source && duplicate.source) {
    updates.source = duplicate.source;
    if (duplicate.source_detail) updates.source_detail = duplicate.source_detail;
  }
  if (!primary.preferred_channel && duplicate.preferred_channel) {
    updates.preferred_channel = duplicate.preferred_channel;
  }
  if (!primary.assigned_agent_id && duplicate.assigned_agent_id) {
    updates.assigned_agent_id = duplicate.assigned_agent_id;
  }

  const mergedTypes = sortedUnion(primary.contact_types, duplicate.contact_types);
  if (!sameSet(mergedTypes, primary.contact_types ?? [])) updates.contact_types = mergedTypes;
  const mergedLangs = sortedUnion(primary.languages, duplicate.languages);
  if (!sameSet(mergedLangs, primary.languages ?? [])) updates.languages = mergedLangs;

  // checklists/preferences move wholesale only into an empty primary — the
  // primary's own answers are never mixed with the duplicate's
  if (isEmptyJson(primary.preferences) && !isEmptyJson(duplicate.preferences)) {
    updates.preferences = duplicate.preferences;
  }
  if (isEmptyJson(primary.kyc) && !isEmptyJson(duplicate.kyc)) {
    updates.kyc = duplicate.kyc;
  }
  if (isEmptyJson(primary.banking_readiness) && !isEmptyJson(duplicate.banking_readiness)) {
    updates.banking_readiness = duplicate.banking_readiness;
  }

  if (duplicate.notes) {
    const marker = mergeNoteMarker(duplicate);
    if (!primary.notes) {
      updates.notes = `${marker}: ${duplicate.notes}`;
    } else if (!primary.notes.includes(marker)) {
      updates.notes = `${primary.notes}\n${marker}: ${duplicate.notes}`;
    }
  }

  return { updates, dropped };
}
