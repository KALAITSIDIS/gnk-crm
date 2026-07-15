"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

export type PropertyDocActionState = { error: string | null; savedAt: number | null };

type DocType = Database["public"]["Enums"]["document_type"];

/** doc_type options offered on a property (subset of the document_type enum). */
export const PROPERTY_DOC_TYPES: readonly DocType[] = [
  "title_deed",
  "permit",
  "plan",
  "contract",
  "valuation",
  "other",
] as const;

const ALLOWED_DOC_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_DOC_BYTES = 15 * 1024 * 1024;

/** Upload a property document → private `documents` bucket + `documents` row. */
export async function uploadPropertyDocument(
  _prev: PropertyDocActionState,
  formData: FormData,
): Promise<PropertyDocActionState> {
  const propertyId = String(formData.get("property_id") ?? "");
  const file = formData.get("file");
  const rawType = String(formData.get("doc_type") ?? "other");
  const rawTitle = String(formData.get("title") ?? "").trim();

  if (!z.guid().safeParse(propertyId).success) return { error: "Missing property", savedAt: null };
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a file to upload", savedAt: null };
  }
  if (!ALLOWED_DOC_TYPES.has(file.type)) return { error: "PDF, JPG or PNG only", savedAt: null };
  if (file.size > MAX_DOC_BYTES) return { error: "File is over 15 MB", savedAt: null };

  const docType = (PROPERTY_DOC_TYPES as readonly string[]).includes(rawType)
    ? (rawType as DocType)
    : "other";
  const title = (rawTitle || file.name).slice(0, 200);

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // RLS-checked read proves the caller may touch this property
  const { data: property } = await supabase
    .from("properties")
    .select("id, org_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!property) return { error: "Property not found", savedAt: null };

  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${property.org_id}/properties/${propertyId}/${Date.now()}-${safeName}`;
  const admin = createAdminClient();
  // pass the File straight through (Blob path in storage-js → binary-safe on Vercel)
  const upload = await admin.storage
    .from("documents")
    .upload(path, file, { contentType: file.type });
  if (upload.error) return { error: upload.error.message, savedAt: null };

  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .insert({
      org_id: property.org_id,
      entity_type: "property",
      entity_id: propertyId,
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
    orgId: property.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "document_uploaded",
    payload: { document_id: doc.id, title, doc_type: docType },
  });

  revalidatePath(`/properties/${propertyId}`);
  return { error: null, savedAt: Date.now() };
}

/** Delete a property document (row + stored file). Admin-only per documents RLS. */
export async function deletePropertyDocument(
  documentId: string,
  propertyId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: doc } = await supabase
    .from("documents")
    .select("id, org_id, title, storage_path, entity_type, entity_id")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc) return { error: "Document not found" };

  const { error } = await supabase.from("documents").delete().eq("id", documentId);
  if (error) return { error: error.message };

  const admin = createAdminClient();
  if (doc.storage_path) await admin.storage.from("documents").remove([doc.storage_path]);

  await logEvent(supabase, {
    orgId: doc.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: doc.entity_id,
    eventType: "document_deleted",
    payload: { document_id: documentId, title: doc.title },
  });

  revalidatePath(`/properties/${propertyId}`);
  return { error: null };
}
