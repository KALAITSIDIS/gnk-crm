"use server";

import { revalidatePath } from "next/cache";
import type { Database } from "@/lib/supabase/database.types";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export interface MergeCandidate {
  id: string;
  display_name: string;
  phone_e164: string | null;
  email: string | null;
}

/** Search org contacts to absorb into the current one (admin merge dialog). */
export async function searchContactsForMerge(
  query: string,
  excludeId: string,
): Promise<MergeCandidate[]> {
  const supabase = await createClient();
  const q = query.trim().replace(/[%,()]/g, " ");
  if (q.length < 2) return [];

  const { data } = await supabase
    .from("contacts")
    .select("id, display_name, phone_e164, email")
    .eq("is_archived", false)
    .neq("id", excludeId)
    .or(`display_name.ilike.%${q}%,phone_e164.ilike.%${q}%,email.ilike.%${q}%`)
    .limit(8);

  return (data ?? []).map((c) => ({
    id: c.id,
    display_name: c.display_name ?? "Unnamed",
    phone_e164: c.phone_e164,
    email: c.email,
  }));
}

export type MergeState = { error: string | null; mergedAt: number | null };

/**
 * Merge `duplicateId` INTO `primaryId` (doc 02 §C3, doc 04: service role).
 * Repoints operational references, backfills empty primary fields, archives
 * the duplicate with merged_into_id. Historical events are NOT rewritten —
 * see DECISIONS.md (T2.3); timelines traverse merged_into_id instead.
 */
export async function mergeContacts(
  _prev: MergeState,
  formData: FormData,
): Promise<MergeState> {
  const primaryId = formData.get("primary_id");
  const duplicateId = formData.get("duplicate_id");
  if (typeof primaryId !== "string" || typeof duplicateId !== "string") {
    return { error: "Missing contacts", mergedAt: null };
  }
  if (primaryId === duplicateId) {
    return { error: "Cannot merge a contact into itself", mergedAt: null };
  }

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin") {
    return { error: "Only admins can merge contacts", mergedAt: null };
  }

  const admin = createAdminClient();
  const [{ data: primary }, { data: duplicate }] = await Promise.all([
    admin.from("contacts").select("*").eq("id", primaryId).maybeSingle(),
    admin.from("contacts").select("*").eq("id", duplicateId).maybeSingle(),
  ]);
  if (!primary || !duplicate) return { error: "Contact not found", mergedAt: null };
  if (primary.org_id !== profile.orgId || duplicate.org_id !== profile.orgId) {
    return { error: "Cross-org merge refused", mergedAt: null };
  }
  if (duplicate.is_archived) return { error: "Duplicate is already archived", mergedAt: null };

  // 1. archive duplicate first — frees the partial unique phone index so the
  //    primary can inherit the number when backfilling
  const { error: archiveErr } = await admin
    .from("contacts")
    .update({ is_archived: true, merged_into_id: primaryId })
    .eq("id", duplicateId);
  if (archiveErr) return { error: archiveErr.message, mergedAt: null };

  // 2. repoint operational references
  const repoints: Promise<{ error: { message: string } | null }>[] = [
    admin.from("leads").update({ contact_id: primaryId }).eq("contact_id", duplicateId),
    admin.from("deals").update({ buyer_contact_id: primaryId }).eq("buyer_contact_id", duplicateId),
    admin
      .from("deals")
      .update({ seller_contact_id: primaryId })
      .eq("seller_contact_id", duplicateId),
    admin.from("viewings").update({ contact_id: primaryId }).eq("contact_id", duplicateId),
    admin.from("offers").update({ contact_id: primaryId }).eq("contact_id", duplicateId),
    admin.from("tasks").update({ contact_id: primaryId }).eq("contact_id", duplicateId),
    admin
      .from("mandates")
      .update({ owner_contact_id: primaryId })
      .eq("owner_contact_id", duplicateId),
    admin
      .from("properties")
      .update({ owner_contact_id: primaryId })
      .eq("owner_contact_id", duplicateId),
    admin
      .from("properties")
      .update({ developer_contact_id: primaryId })
      .eq("developer_contact_id", duplicateId),
    admin
      .from("documents")
      .update({ entity_id: primaryId })
      .eq("entity_type", "contact")
      .eq("entity_id", duplicateId),
    // contacts previously merged into the duplicate follow it to the primary
    admin
      .from("contacts")
      .update({ merged_into_id: primaryId })
      .eq("merged_into_id", duplicateId)
      .neq("id", duplicateId),
  ] as unknown as Promise<{ error: { message: string } | null }>[];
  const results = await Promise.all(repoints);
  const repointErr = results.find((r) => r.error);
  if (repointErr?.error) return { error: repointErr.error.message, mergedAt: null };

  // 3. backfill empty primary fields from the duplicate
  const backfill: Database["public"]["Tables"]["contacts"]["Update"] = {};
  if (!primary.phone_e164 && duplicate.phone_e164) {
    backfill.phone_e164 = duplicate.phone_e164;
    backfill.phone_raw = duplicate.phone_raw;
  }
  if (!primary.email && duplicate.email) backfill.email = duplicate.email;
  if (!primary.telegram_username && duplicate.telegram_username) {
    backfill.telegram_username = duplicate.telegram_username;
  }
  if (!primary.nationality && duplicate.nationality) backfill.nationality = duplicate.nationality;
  const mergedTypes = [...new Set([...primary.contact_types, ...duplicate.contact_types])];
  if (mergedTypes.length !== primary.contact_types.length) backfill.contact_types = mergedTypes;
  const mergedLangs = [...new Set([...primary.languages, ...duplicate.languages])];
  if (mergedLangs.length !== primary.languages.length) backfill.languages = mergedLangs;
  if (duplicate.notes) {
    backfill.notes = primary.notes
      ? `${primary.notes}\n— merged from ${duplicate.display_name}: ${duplicate.notes}`
      : duplicate.notes;
  }
  if (Object.keys(backfill).length > 0) {
    const { error: backfillErr } = await admin
      .from("contacts")
      .update(backfill)
      .eq("id", primaryId);
    if (backfillErr) return { error: backfillErr.message, mergedAt: null };
  }

  // 4. events on both sides (insert-only — history is never rewritten)
  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: primaryId,
    eventType: "merged",
    payload: {
      merged_contact_id: duplicateId,
      merged_contact_name: duplicate.display_name,
    },
  });
  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: duplicateId,
    eventType: "archived",
    payload: { merged_into: primaryId },
  });

  revalidatePath(`/contacts/${primaryId}`);
  revalidatePath("/contacts");
  return { error: null, mergedAt: Date.now() };
}
