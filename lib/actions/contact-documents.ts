"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { CONTACT_DOC_TYPES, type DocType } from "@/lib/validators/documents";

// type-only export is fine in a "use server" file (erased at runtime);
// runtime constants are NOT — CONTACT_DOC_TYPES lives in lib/validators/documents.ts
export type ContactDocActionState = { error: string | null; savedAt: number | null };

const ALLOWED_DOC_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_DOC_BYTES = 15 * 1024 * 1024;

/** Upload a contact document (KYC paperwork) → private `documents` bucket + row. */
export async function uploadContactDocument(
  _prev: ContactDocActionState,
  formData: FormData,
): Promise<ContactDocActionState> {
  const contactId = String(formData.get("contact_id") ?? "");
  const file = formData.get("file");
  const rawType = String(formData.get("doc_type") ?? "other");
  const rawTitle = String(formData.get("title") ?? "").trim();

  if (!z.guid().safeParse(contactId).success) return { error: "Missing contact", savedAt: null };
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a file to upload", savedAt: null };
  }
  if (!ALLOWED_DOC_TYPES.has(file.type)) return { error: "PDF, JPG or PNG only", savedAt: null };
  if (file.size > MAX_DOC_BYTES) return { error: "File is over 15 MB", savedAt: null };

  const docType = (CONTACT_DOC_TYPES as readonly string[]).includes(rawType)
    ? (rawType as DocType)
    : "other";
  const title = (rawTitle || file.name).slice(0, 200);

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // RLS-checked read proves the caller may see this contact
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, org_id, is_archived")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) return { error: "Contact not found", savedAt: null };
  if (contact.is_archived) {
    return { error: "This contact is archived — unarchive it first.", savedAt: null };
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${contact.org_id}/contacts/${contactId}/${Date.now()}-${safeName}`;
  const admin = createAdminClient();
  // pass the File straight through (Blob path in storage-js → binary-safe on Vercel)
  const upload = await admin.storage
    .from("documents")
    .upload(path, file, { contentType: file.type });
  if (upload.error) return { error: upload.error.message, savedAt: null };

  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .insert({
      org_id: contact.org_id,
      entity_type: "contact",
      entity_id: contactId,
      doc_type: docType,
      title,
      storage_path: path,
      uploaded_by: profile.id,
    })
    .select("id")
    .single();
  if (docErr) {
    // the row was rejected (RLS/validation) — don't orphan the uploaded object
    await admin.storage.from("documents").remove([path]);
    return { error: docErr.message, savedAt: null };
  }

  await logEvent(supabase, {
    orgId: contact.org_id,
    actorId: profile.id,
    entityType: "contact",
    entityId: contactId,
    eventType: "document_uploaded",
    payload: { document_id: doc.id, title, doc_type: docType },
  });

  revalidatePath(`/contacts/${contactId}`);
  return { error: null, savedAt: Date.now() };
}

/** Delete a contact document (row + stored file). Admin-only per documents RLS. */
export async function deleteContactDocument(
  documentId: string,
  contactId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: doc } = await supabase
    .from("documents")
    .select("id, org_id, title, storage_path, entity_type, entity_id")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc) return { error: "Document not found" };
  if (doc.entity_type !== "contact") {
    return { error: "Not a contact document" };
  }

  // RLS silently filters a forbidden delete to 0 rows — the returned rows are
  // the proof. Without this check the admin-client storage removal below would
  // destroy the file while the row (and everyone's access to it) survives.
  const { data: deletedRows, error } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId)
    .select("id");
  if (error) return { error: error.message };
  if (!deletedRows || deletedRows.length === 0) {
    return { error: "Nothing was deleted — only admins can delete documents." };
  }

  const admin = createAdminClient();
  if (doc.storage_path) await admin.storage.from("documents").remove([doc.storage_path]);

  await logEvent(supabase, {
    orgId: doc.org_id,
    actorId: profile.id,
    entityType: "contact",
    entityId: doc.entity_id,
    eventType: "document_deleted",
    payload: { document_id: documentId, title: doc.title },
  });

  revalidatePath(`/contacts/${contactId}`);
  return { error: null };
}
