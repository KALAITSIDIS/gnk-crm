"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Short-lived signed URL for any private document. Access control = the
 * RLS-checked read of the `documents` row (doc 04: file bodies are served via
 * signed URLs only, after the row is visible to the caller).
 */
export async function getDocumentDownloadUrl(
  documentId: string,
): Promise<{ url: string | null; error: string | null }> {
  const supabase = await createClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("storage_path")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc) return { url: null, error: "Document not found" };

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("documents")
    .createSignedUrl(doc.storage_path, 120);
  if (error) return { url: null, error: error.message };
  return { url: data.signedUrl, error: null };
}
