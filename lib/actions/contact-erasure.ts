"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { LEAD_MESSAGE_REDACTED } from "@/lib/services/erasure";
import { runContactErasure, type ErasureSteps } from "@/lib/services/erasure-run";
import { logEvent } from "@/lib/services/events";
import { removeObjectsOrFail } from "@/lib/services/storage";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ErasureState = { error: string | null; erasedAt: string | null };

/** Turn a supabase result's error into a thrown one, so a step never half-succeeds silently. */
function fail(r: { error: { message: string } | null }): void {
  if (r.error) throw new Error(r.error.message);
}

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
 *
 * THE ORDER AND THE FAILURE SEMANTICS LIVE IN lib/services/erasure-run.ts,
 * where they are tested without a database. This file only says how each step
 * touches Supabase. Until 2026-09-06 the contact patch went first and was the
 * only checked write; everything after it discarded its error, a failed
 * AML-basis read computed "no relationship" and destroyed documents the law
 * requires the firm to keep, and a half-finished erasure could never be run
 * again (audit A04).
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
  // last stop before an irreversible write
  if (confirmName.trim() !== (contact.display_name ?? "").trim()) {
    return { error: "The typed name does not match this contact.", erasedAt: null };
  }

  const admin = createAdminClient();

  const steps: ErasureSteps = {
    // Does a customer due-diligence relationship exist? Reads go through the
    // user's client, so RLS scoping applies. Viewing slips are reached through
    // the contact's viewings — slips carry no contact_id. CY-03: the same reads
    // carry the relationship END signals so the 5-year AML clock can anchor.
    // EVERY read is checked: a failed read is an error, never "no basis".
    async readBasis() {
      const [dealsRes, viewingsRes, mandatesRes] = await Promise.all([
        supabase
          .from("deals")
          .select("id, won_at, lost_at")
          .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`),
        supabase.from("viewings").select("id").eq("contact_id", contactId),
        supabase.from("mandates_safe").select("id, expiry_date").eq("owner_contact_id", contactId),
      ]);
      fail(dealsRes);
      fail(viewingsRes);
      fail(mandatesRes);
      const viewingIds = (viewingsRes.data ?? []).map((v) => v.id);
      let slipRows: { signed_at: string | null }[] = [];
      if (viewingIds.length > 0) {
        const slipRes = await supabase
          .from("viewing_slips")
          .select("signed_at")
          .in("viewing_id", viewingIds);
        fail(slipRes);
        slipRows = slipRes.data ?? [];
      }
      return {
        dealCount: (dealsRes.data ?? []).length,
        viewingSlipCount: slipRows.length,
        mandateCount: (mandatesRes.data ?? []).length,
        relationshipEndCandidates: [
          ...(dealsRes.data ?? []).flatMap((d) => [d.won_at, d.lost_at]),
          ...slipRows.map((v) => v.signed_at),
          ...(mandatesRes.data ?? []).map((m) => m.expiry_date),
        ],
      };
    },

    async hasErasedEvent() {
      const r = await supabase
        .from("events")
        .select("id")
        .eq("entity_type", "contact")
        .eq("entity_id", contactId)
        .eq("event_type", "erased")
        .limit(1);
      fail(r);
      return (r.data ?? []).length > 0;
    },

    // The person's own words. Lead messages are ordinary columns, not
    // hash-chained event payloads, so they can safely be rewritten. Only the
    // ones not already redacted, so a re-run counts what it did, not what
    // the first run did.
    async redactLeads() {
      const r = await supabase
        .from("leads")
        .update({ message: LEAD_MESSAGE_REDACTED })
        .eq("contact_id", contactId)
        .not("message", "is", null)
        .neq("message", LEAD_MESSAGE_REDACTED)
        .select("id");
      fail(r);
      return r.data?.length ?? 0;
    },

    // Saved searches — budget, areas, bedrooms — are personal data (0043 moved
    // them out of contacts.preferences and erasure had not followed). Deleted
    // rather than blanked: an emptied search matches nothing forever.
    async deleteRequirements() {
      const r = await supabase
        .from("buyer_requirements")
        .delete()
        .eq("contact_id", contactId)
        .select("id");
      fail(r);
      return r.data?.length ?? 0;
    },

    async listDocuments() {
      const r = await supabase
        .from("documents")
        .select("id, storage_path")
        .eq("entity_type", "contact")
        .eq("entity_id", contactId);
      fail(r);
      return r.data ?? [];
    },

    // Proven, not assumed: every path must be absent afterwards.
    async removeObjects(paths) {
      await removeObjectsOrFail(admin.storage, "documents", paths);
    },

    async deleteDocumentRows() {
      const r = await supabase
        .from("documents")
        .delete()
        .eq("entity_type", "contact")
        .eq("entity_id", contactId)
        .select("id");
      fail(r);
      return r.data?.length ?? 0;
    },

    // Row-count guarded: an RLS-filtered no-op must not be reported as done.
    async patchContact(patch) {
      const r = await supabase
        .from("contacts")
        .update(patch)
        .eq("id", contactId)
        .is("erased_at", null)
        .select("id");
      fail(r);
      return (r.data ?? []).length > 0;
    },

    async writeEvent(payload) {
      await logEvent(supabase, {
        orgId: contact.org_id,
        actorId: profile.id,
        entityType: "contact",
        entityId: contactId,
        eventType: "erased",
        payload: JSON.parse(JSON.stringify(payload)),
      });
    },
  };

  const result = await runContactErasure({
    alreadyErasedAt: contact.erased_at,
    actorId: profile.id,
    now: new Date().toISOString(),
    steps,
  });

  if (result.erasedAt) {
    revalidatePath(`/contacts/${contactId}`);
    revalidatePath("/contacts");
    revalidatePath("/leads");
  }
  return result;
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
 *
 * Objects BEFORE rows, and proven (2026-09-06): a storage failure leaves the
 * rows, which are what a retry uses to find the objects again. The old order
 * deleted rows first and ignored the storage result, so a failed removal left
 * orphaned files nobody could find.
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

  const { data: docs, error: listErr } = await supabase
    .from("documents")
    .select("id, storage_path")
    .eq("entity_type", "contact")
    .eq("entity_id", contactId);
  if (listErr) return { error: listErr.message, purgedAt: null };
  const paths = (docs ?? []).map((d) => d.storage_path).filter((p): p is string => Boolean(p));
  try {
    await removeObjectsOrFail(createAdminClient().storage, "documents", paths);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { error: `The retained files were NOT destroyed: ${why}. Nothing was changed — try again.`, purgedAt: null };
  }

  const { data: deletedRows, error: deleteErr } = await supabase
    .from("documents")
    .delete()
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .select("id");
  if (deleteErr) {
    return {
      error: `The files are gone but their records were not deleted: ${deleteErr.message}. Run it again to finish.`,
      purgedAt: null,
    };
  }
  const documentsDestroyed = deletedRows?.length ?? 0;

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
