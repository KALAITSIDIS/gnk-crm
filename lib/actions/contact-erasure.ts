"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ErasureState = { error: string | null; erasedAt: string | null };

/**
 * GDPR Article 17 erasure for a contact.
 *
 * A REDACTION, not a delete — see docs/superpowers/specs/2026-07-21-gdpr-
 * contact-erasure-design.md for why events, viewing slips and evidence PDFs
 * are untouchable, and why Cyprus AML makes destroying due-diligence records
 * unlawful for anyone who actually transacted.
 *
 * Admin-only, enforced HERE: the contacts UPDATE policy also admits the
 * assigned/creating agent, so hiding the button would not be a control.
 * Irreversible by design.
 */
export async function eraseContactPersonalData(
  contactId: string,
  confirmName: string,
): Promise<ErasureState> {
  if (!z.guid().safeParse(contactId).success) {
    return { error: "Missing contact", erasedAt: null };
  }

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin") return { error: "Admins only.", erasedAt: null };

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, org_id, display_name, erased_at")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) return { error: "Contact not found", erasedAt: null };
  if (contact.erased_at) {
    return { error: "This contact's personal data has already been erased.", erasedAt: null };
  }
  // last stop before an irreversible write
  if (confirmName.trim() !== (contact.display_name ?? "").trim()) {
    return { error: "The typed name does not match this contact.", erasedAt: null };
  }

  const { planContactErasure, buildErasureEventPayload, hasAmlRelationship, LEAD_MESSAGE_REDACTED } =
    await import("@/lib/services/erasure");

  // Does a customer due-diligence relationship exist? Counts are exact and
  // read through the user's client, so RLS scoping applies. Viewing slips are
  // reached through the contact's viewings — slips carry no contact_id.
  const [dealsRes, viewingsRes, mandatesRes] = await Promise.all([
    supabase
      .from("deals")
      .select("id", { count: "exact", head: true })
      .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`),
    supabase.from("viewings").select("id").eq("contact_id", contactId),
    supabase
      .from("mandates_safe")
      .select("id", { count: "exact", head: true })
      .eq("owner_contact_id", contactId),
  ]);

  const viewingIds = (viewingsRes.data ?? []).map((v) => v.id);
  let viewingSlipCount = 0;
  if (viewingIds.length > 0) {
    const slipRes = await supabase
      .from("viewing_slips")
      .select("id", { count: "exact", head: true })
      .in("viewing_id", viewingIds);
    viewingSlipCount = slipRes.count ?? 0;
  }

  const amlBasis = hasAmlRelationship({
    dealCount: dealsRes.count ?? 0,
    viewingSlipCount,
    mandateCount: mandatesRes.count ?? 0,
  });

  const now = new Date().toISOString();
  const plan = planContactErasure({ amlBasis, actorId: profile.id, now });

  // 1. Redact the contact row. Row-count guarded: an RLS-filtered no-op must
  //    not go on to delete files and write an event claiming success.
  const { data: updated, error: updateErr } = await supabase
    .from("contacts")
    .update(plan.patch)
    .eq("id", contactId)
    .is("erased_at", null)
    .select("id");
  if (updateErr) return { error: updateErr.message, erasedAt: null };
  if (!updated || updated.length === 0) {
    return { error: "You don't have permission to erase this contact.", erasedAt: null };
  }

  // 2. Redact the person's own words. Lead messages are ordinary columns, not
  //    hash-chained event payloads, so they can safely be rewritten.
  const { data: redactedLeads } = await supabase
    .from("leads")
    .update({ message: LEAD_MESSAGE_REDACTED })
    .eq("contact_id", contactId)
    .not("message", "is", null)
    .select("id");
  const leadsRedacted = redactedLeads?.length ?? 0;

  // 3. Documents: destroyed only when no AML basis exists to keep them.
  let documentsDeleted = 0;
  let documentsRetained = 0;
  const { data: docs } = await supabase
    .from("documents")
    .select("id, storage_path")
    .eq("entity_type", "contact")
    .eq("entity_id", contactId);

  if (plan.deleteDocuments && docs && docs.length > 0) {
    const { data: deletedRows } = await supabase
      .from("documents")
      .delete()
      .eq("entity_type", "contact")
      .eq("entity_id", contactId)
      .select("id, storage_path");
    documentsDeleted = deletedRows?.length ?? 0;
    // only remove files whose row the delete actually returned, so an
    // RLS-filtered no-op cannot strand objects in the bucket
    const paths = (deletedRows ?? []).map((d) => d.storage_path).filter(Boolean);
    if (paths.length > 0) {
      await createAdminClient().storage.from("documents").remove(paths);
    }
    documentsRetained = (docs.length ?? 0) - documentsDeleted;
  } else {
    documentsRetained = docs?.length ?? 0;
  }

  // 4. Saved searches. What someone is looking for — budget, areas, bedrooms —
  //    is personal data, and before 0055 it lived in `contacts.preferences`
  //    and was cleared by the patch above. 0043 moved it to rows and erasure
  //    was never updated to follow, so it had been surviving Article 17.
  //    Deleted rather than blanked: a saved search with every field emptied is
  //    not a record of anything, and it would keep matching nothing forever.
  const { data: deletedRequirements } = await supabase
    .from("buyer_requirements")
    .delete()
    .eq("contact_id", contactId)
    .select("id");
  const requirementsDeleted = deletedRequirements?.length ?? 0;

  await logEvent(supabase, {
    orgId: contact.org_id,
    actorId: profile.id,
    entityType: "contact",
    entityId: contactId,
    eventType: "erased",
    payload: JSON.parse(
      JSON.stringify(
        buildErasureEventPayload({
          amlBasis,
          retentionUntil: plan.retentionUntil,
          leadsRedacted,
          requirementsDeleted,
          documentsDeleted,
          documentsRetained,
        }),
      ),
    ),
  });

  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/contacts");
  revalidatePath("/leads");
  return { error: null, erasedAt: now };
}

export type RetentionPurgeState = { error: string | null; purgedAt: string | null };

/**
 * Second-stage destruction once the AML retention duty has run (IMPROVEMENTS
 * B11). Erasure keeps KYC documents when a due-diligence relationship existed
 * and stamps `retention_until` five years out; this is the other half — after
 * that date the legal basis for holding them is gone, so keeping them would
 * itself breach the storage-limitation principle.
 *
 * Destroys ONLY the retained document rows, their storage objects, and the KYC
 * checklist. The erasure record itself (`erased_at`/`erased_by`), the identity
 * fields, events and viewing slips are untouched — the first three are the audit
 * trail, the last two are immutable commission evidence.
 *
 * Admin-only, enforced here: the contacts UPDATE policy also admits the
 * assigned/creating agent. Irreversible.
 */
export async function purgeExpiredRetention(contactId: string): Promise<RetentionPurgeState> {
  if (!z.guid().safeParse(contactId).success) {
    return { error: "Missing contact", purgedAt: null };
  }

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin") return { error: "Admins only.", purgedAt: null };

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, org_id, display_name, erased_at, retention_until")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) return { error: "Contact not found", purgedAt: null };
  if (!contact.retention_until) {
    return { error: "Nothing is retained for this contact.", purgedAt: null };
  }

  const { classifyRetention } = await import("@/lib/services/retention");
  const { zonedParts } = await import("@/lib/utils/tz");
  const today = zonedParts(new Date()).dayKey;
  if (classifyRetention(contact.retention_until, today) !== "expired") {
    // Purging early would destroy records Cyprus AML still requires.
    return {
      error: `Retention runs until ${contact.retention_until} — these records cannot be purged yet.`,
      purgedAt: null,
    };
  }

  // Documents first: only files whose row the delete actually returned are
  // removed, so an RLS-filtered no-op cannot strand objects in the bucket.
  const { data: deletedRows, error: deleteErr } = await supabase
    .from("documents")
    .delete()
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .select("id, storage_path");
  if (deleteErr) return { error: deleteErr.message, purgedAt: null };
  const documentsDestroyed = deletedRows?.length ?? 0;
  const paths = (deletedRows ?? []).map((d) => d.storage_path).filter(Boolean);
  if (paths.length > 0) {
    await createAdminClient().storage.from("documents").remove(paths);
  }

  // Clear the marker so the row leaves the retention surface. Row-count guarded
  // and re-checked against retention_until so two concurrent purges cannot both
  // claim success.
  const { data: updated, error: updateErr } = await supabase
    .from("contacts")
    .update({ retention_until: null, kyc: {} })
    .eq("id", contactId)
    .not("retention_until", "is", null)
    .select("id");
  if (updateErr) return { error: updateErr.message, purgedAt: null };
  if (!updated || updated.length === 0) {
    return { error: "You don't have permission to purge this contact.", purgedAt: null };
  }

  const purgedAt = new Date().toISOString();
  await logEvent(supabase, {
    orgId: contact.org_id,
    actorId: profile.id,
    entityType: "contact",
    entityId: contactId,
    eventType: "retention_purged",
    // counts and dates only — never the destroyed values
    payload: {
      documents_destroyed: documentsDestroyed,
      retention_until: contact.retention_until,
    },
  });

  revalidatePath("/settings/retention");
  revalidatePath(`/contacts/${contactId}`);
  return { error: null, purgedAt };
}
