"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { LEAD_MESSAGE_REDACTED } from "@/lib/services/erasure";
import { runContactErasure, type ErasureSteps } from "@/lib/services/erasure-run";
import { isEvidenceReportPath } from "@/lib/services/evidence-report-path";
import { logEvent } from "@/lib/services/events";
import { removeObjectsOrFail } from "@/lib/services/storage";
import { createAdminClient } from "@/lib/supabase/admin";
import { rowsOf } from "@/lib/supabase/rows";
import { createClient } from "@/lib/supabase/server";

export type ErasureState = { error: string | null; erasedAt: string | null };

/*
 * Every answer a step reads goes through `rowsOf` (lib/supabase/rows.ts):
 * a failed read throws, and so does an answer with NO rows array — the only
 * "none" is `[]` (T-erasure-null-answers). Until 2026-10-13 the steps threw on
 * a truthy error only and then read `data ?? []`: postgrest-js reports an
 * empty-bodied OK answer, an empty 404 and a `null` body (even under a 500) as
 * `data: null, error: null`, and a 500 whose body is `0` as a falsy error. A
 * hollow deals answer for a contact WITH a deal made "no relationship", and the
 * run destroyed the KYC file (measured); a hollow document listing recorded
 * the erasure with the files still there.
 */

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
 * THE ERASURE RECORD IS THE SYSTEM'S (0134, T-erasure-lifecycle-guard). A
 * session can no longer write `erased_at` / `erased_by` / `retention_until`,
 * change an erased contact other than archiving it, or write a contact's
 * `erased` event, or delete an erased contact's retained documents — so the
 * document-row delete, the contact patch and the event run as the service
 * role (as the notes' redaction and the storage removal already did), after
 * the checks below (an aal2, active admin — `getCurrentProfile` reads the
 * profile through RLS — whose RLS-scoped read found the contact in their own
 * organisation, and the typed name), and bounded by that organisation and
 * this contact. The patch stays conditional on `erased_at is null`. The basis
 * reads, the lead redaction, the saved-search delete, the document listing
 * and the record check still run on the admin's session.
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

  // the whole row: a re-run checks it shows what the patch writes (erasure-run)
  const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).maybeSingle();
  // RLS already scopes the read to the caller's organisation; the writes
  // below run as the service role, which has no boundary but the one they
  // name — so the organisation they name is checked to be this one
  if (!contact || contact.org_id !== profile.orgId) return { error: "Contact not found", erasedAt: null };
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
      const deals = rowsOf(dealsRes, "deals");
      const viewings = rowsOf(viewingsRes, "viewings");
      const mandates = rowsOf(mandatesRes, "mandates");
      const viewingIds = viewings.map((v) => v.id);
      let slipRows: { signed_at: string | null }[] = [];
      if (viewingIds.length > 0) {
        const slipRes = await supabase
          .from("viewing_slips")
          .select("signed_at")
          .in("viewing_id", viewingIds);
        slipRows = rowsOf(slipRes, "viewing slips");
      }
      return {
        dealCount: deals.length,
        viewingSlipCount: slipRows.length,
        mandateCount: mandates.length,
        relationshipEndCandidates: [
          ...deals.flatMap((d) => [d.won_at, d.lost_at]),
          ...slipRows.map((v) => v.signed_at),
          ...mandates.map((m) => m.expiry_date),
        ],
      };
    },

    // The record a re-run trusts: since 0134 only the system writes a
    // contact's `erased` event, so a session cannot forge "already done".
    async hasErasedEvent() {
      const r = await supabase
        .from("events")
        .select("id")
        .eq("entity_type", "contact")
        .eq("entity_id", contactId)
        .eq("event_type", "erased")
        .limit(1);
      return rowsOf(r, "the erasure record").length > 0;
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
      return rowsOf(r, "leads").length;
    },

    // The desk's own words about the person (0094, audit SEC-03): the notes
    // on the contact and on the leads that became this contact — the same
    // leads whose messages the step above rewrote. A session cannot update
    // notes (redaction is the service role's), so this runs as the system,
    // bounded by the org and by the contact the admin check above covered.
    // Only rows not already redacted, so a re-run counts what it did.
    async redactNotes() {
      const leadIds = rowsOf(await supabase.from("leads").select("id").eq("contact_id", contactId), "the contact's leads").map(
        (l) => l.id,
      );
      const redaction = { body: null, redacted_at: new Date().toISOString() };
      const own = await admin
        .from("interaction_notes")
        .update(redaction)
        .eq("org_id", contact.org_id)
        .eq("entity_type", "contact")
        .eq("entity_id", contactId)
        .is("redacted_at", null)
        .select("id");
      let count = rowsOf(own, "the contact's notes").length;
      if (leadIds.length > 0) {
        const theirs = await admin
          .from("interaction_notes")
          .update(redaction)
          .eq("org_id", contact.org_id)
          .eq("entity_type", "lead")
          .in("entity_id", leadIds)
          .is("redacted_at", null)
          .select("id");
        count += rowsOf(theirs, "the leads' notes").length;
      }
      return count;
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
      return rowsOf(r, "saved searches").length;
    },

    // Every contact document: the runner keeps the evidence reports (ERA-1)
    async listDocuments() {
      const r = await supabase
        .from("documents")
        .select("id, storage_path")
        .eq("entity_type", "contact")
        .eq("entity_id", contactId);
      return rowsOf(r, "documents");
    },

    // Proven, not assumed: every path must be absent afterwards.
    async removeObjects(paths) {
      await removeObjectsOrFail(admin.storage, "documents", paths);
    },

    // As the system, bounded like the patch below: 0134 refuses a session's
    // delete of an erased contact's documents (only the system destroys them),
    // and a re-run may reach here with the marker already set.
    // …exactly the rows listed (whose files were just removed): a document
    // uploaded meanwhile keeps its row, for the next run to find with its file.
    async deleteDocumentRows(ids) {
      if (ids.length === 0) return 0;
      const r = await admin
        .from("documents")
        .delete()
        .eq("org_id", profile.orgId)
        .eq("entity_type", "contact")
        .eq("entity_id", contactId)
        .in("id", ids)
        .select("id");
      if (r.error || Array.isArray(r.data)) return rowsOf(r, "document rows").length;
      // The answer was lost — the delete may have landed. Proven, not assumed
      // (as the files are): a re-run could not count rows already gone, and
      // would record the destruction as 0 (T-erasure-null-answers review).
      const left = rowsOf(
        await admin.from("documents").select("id").eq("org_id", profile.orgId).in("id", ids),
        "document rows (re-read after an unconfirmed delete)",
      );
      if (left.length > 0) {
        throw new Error(`document rows: ${left.length} of ${ids.length} listed row(s) remain after an unconfirmed delete`);
      }
      return ids.length;
    },

    // As the system (0134 — header), bounded by the caller's organisation
    // and this contact, and only while it is not erased: row-count guarded,
    // so an erasure that landed meanwhile is never reported as this one.
    async patchContact(patch) {
      const r = await admin
        .from("contacts")
        .update(patch)
        .eq("org_id", profile.orgId)
        .eq("id", contactId)
        .is("erased_at", null)
        .select("id");
      // [] — and only [] — is "erased meanwhile"
      if (r.error || Array.isArray(r.data)) return rowsOf(r, "the contact").length > 0;
      // The answer was lost — the patch may have landed. Its own marker says
      // which: this run's instant and actor are this run's patch. Settled here,
      // because once the contact is marked the page offers no second click.
      const [now] = rowsOf(
        await admin.from("contacts").select("erased_at, erased_by").eq("org_id", profile.orgId).eq("id", contactId),
        "the contact (re-read after an unconfirmed patch)",
      );
      if (!now?.erased_at) return rowsOf(r, "the contact").length > 0; // not marked: the failure stands
      return Date.parse(now.erased_at) === Date.parse(patch.erased_at) && now.erased_by === patch.erased_by;
    },

    // As the system too (0134): attributed to the admin, in their organisation.
    async writeEvent(payload) {
      await logEvent(admin, {
        orgId: profile.orgId,
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
    stored: contact,
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
 * fields, events, viewing slips and commission-evidence reports are untouched —
 * the first three are the audit trail, the last three commission evidence. A
 * report is a contact document too, so the listing below sets it aside by its
 * path and the record counts it kept (ERA-1; the erasure keeps it the same way).
 *
 * Admin-only, enforced here: the contacts UPDATE policy also admits the
 * assigned/creating agent. Irreversible.
 *
 * The marker and the `retention_purged` event are the system's (0134, as in
 * eraseContactPersonalData): a session can no longer clear or move
 * `retention_until`, so the date this purge trusts is the one the erasure
 * wrote. They run as the service role after the checks below, bounded by the
 * caller's organisation, this contact, the date the eligibility was decided
 * on, and the contact being erased — a date on a contact that was never
 * erased is no retention duty this purge discharges.
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
  // as in the erasure: the service-role writes below name this organisation
  if (!contact || contact.org_id !== profile.orgId) return { error: "Contact not found", purgedAt: null };
  if (!contact.retention_until) {
    return { error: "Nothing is retained for this contact.", purgedAt: null };
  }
  if (!contact.erased_at) {
    return { error: "This contact was not erased — there is no retention duty to purge.", purgedAt: null };
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

  // Each answer below is checked by `rowsOf` (header of the erasure): an
  // answer with no rows array is a failure, RETURNED — this action returns its
  // errors, a production build hides a thrown one's words. Until 2026-10-13 a
  // hollow listing read as "no documents": the purge cleared the marker and
  // recorded 0 destroyed with the files still there, and a retry then said
  // "Nothing is retained" (measured, T-erasure-null-answers).
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let docs: { id: string; storage_path: string | null }[];
  let evidenceReportsKept = 0;
  try {
    const listed = rowsOf(
      await supabase.from("documents").select("id, storage_path").eq("entity_type", "contact").eq("entity_id", contactId),
      "the retained documents",
    );
    // The AML duty ending is no reason to destroy a commission-evidence
    // report: it is not a KYC record, and its hash is in the event log (ERA-1)
    docs = listed.filter((d) => !isEvidenceReportPath(d.storage_path));
    evidenceReportsKept = listed.length - docs.length;
  } catch (e) {
    return { error: `Could not list the retained documents — nothing was destroyed: ${why(e)}`, purgedAt: null };
  }
  const paths = docs.map((d) => d.storage_path).filter((p): p is string => Boolean(p));
  const admin = createAdminClient();
  try {
    await removeObjectsOrFail(admin.storage, "documents", paths);
  } catch (e) {
    return { error: `The retained files were NOT destroyed: ${why(e)}. Nothing was changed — try again.`, purgedAt: null };
  }

  // As the system (0134 refuses a session's delete of an erased contact's
  // documents): exactly the rows listed above, whose files are now gone.
  // A LOST answer to a write that may have landed is settled HERE, by reading
  // what is left as the system — proven, not assumed, as the files are. Never
  // handed to a re-run: one finds nothing left to destroy and records the
  // destruction as 0 (T-erasure-null-answers review).
  const listedIds = docs.map((d) => d.id);
  let documentsDestroyed = 0;
  if (listedIds.length) {
    try {
      const r = await admin
        .from("documents")
        .delete()
        .eq("org_id", profile.orgId)
        .eq("entity_type", "contact")
        .eq("entity_id", contactId)
        .in("id", listedIds)
        .select("id");
      if (r.error || Array.isArray(r.data)) {
        documentsDestroyed = rowsOf(r, "the document records").length;
      } else {
        const left = rowsOf(
          await admin.from("documents").select("id").eq("org_id", profile.orgId).in("id", listedIds),
          "the document records (re-read after an unconfirmed delete)",
        );
        if (left.length > 0) {
          throw new Error(`the document records: ${left.length} of ${listedIds.length} remain after an unconfirmed delete`);
        }
        documentsDestroyed = listedIds.length;
      }
    } catch (e) {
      // the rows are still there: a re-run lists them, proves the files
      // absent, deletes them and counts them
      return {
        error: `The files are gone but their records were not deleted: ${why(e)}. Run it again to finish.`,
        purgedAt: null,
      };
    }
  }

  // Clear the marker so the row leaves the retention surface — as the system
  // (header), bounded as it says. Row-count guarded and re-checked against the
  // date read above, so two concurrent purges cannot both claim success: the
  // service role is not filtered by RLS, so zero rows — `[]`, and only `[]` —
  // means exactly that.
  const decidedOn: string = contact.retention_until;
  const clearMarker = async () =>
    admin
      .from("contacts")
      .update({ retention_until: null, kyc: {} })
      .eq("org_id", profile.orgId)
      .eq("id", contactId)
      .eq("retention_until", decidedOn)
      .not("erased_at", "is", null)
      .select("id");
  /** Why the marker could not be cleared — everything irreversible is already done. */
  const markerFailure = (e: unknown): RetentionPurgeState => {
    revalidatePath("/settings/retention");
    revalidatePath(`/contacts/${contactId}`);
    return {
      error: `The ${documentsDestroyed} retained file(s) and their records are destroyed, but the retention date could not be cleared: ${why(e)}. Nothing is left to destroy — do not run the purge again (it would record 0 destroyed): the record (retention_purged, ${documentsDestroyed} documents, ${evidenceReportsKept} evidence reports kept, retention until ${contact.retention_until}) must be written by an administrator.`,
      purgedAt: null,
    };
  };
  let cleared: number;
  try {
    const r = await clearMarker();
    if (r.error || Array.isArray(r.data)) {
      cleared = rowsOf(r, "the retention date").length;
    } else {
      // lost: did the clear land? The date this purge decided on says.
      const [now] = rowsOf(
        await admin.from("contacts").select("retention_until").eq("org_id", profile.orgId).eq("id", contactId),
        "the retention date (re-read after an unconfirmed clear)",
      );
      if (now && now.retention_until === null) cleared = 1;
      else if (now && now.retention_until === contact.retention_until) {
        // not cleared: once more, guarded as before
        cleared = rowsOf(await clearMarker(), "the retention date").length;
      } else cleared = 0;
    }
  } catch (e) {
    return markerFailure(e);
  }
  if (cleared === 0) {
    return { error: "This contact's retained records were purged meanwhile — reload the page.", purgedAt: null };
  }

  const purgedAt = new Date().toISOString();
  try {
    await logEvent(admin, {
      orgId: profile.orgId,
      actorId: profile.id,
      entityType: "contact",
      entityId: contactId,
      eventType: "retention_purged",
      // counts and dates only — never the destroyed values
      payload: {
        documents_destroyed: documentsDestroyed,
        evidence_reports_kept: evidenceReportsKept,
        retention_until: contact.retention_until,
      },
    });
  } catch (e) {
    // Everything irreversible is done and the marker is gone, so a retry
    // answers "nothing is retained": say exactly what is missing instead of
    // throwing (a production build hides a thrown action's words).
    revalidatePath("/settings/retention");
    revalidatePath(`/contacts/${contactId}`);
    return {
      error: `Purged — ${documentsDestroyed} retained file(s) and the retention date are gone — but the record of it failed to write: ${why(e)}. The record (retention_purged, ${documentsDestroyed} documents, ${evidenceReportsKept} evidence reports kept, retention until ${contact.retention_until}) must be written by an administrator.`,
      purgedAt,
    };
  }

  revalidatePath("/settings/retention");
  revalidatePath(`/contacts/${contactId}`);
  return { error: null, purgedAt };
}
