import type { Database } from "@/lib/supabase/database.types";

export type DocType = Database["public"]["Enums"]["document_type"];

/**
 * doc_type options offered on a property (subset of the document_type enum).
 * Lives here — NOT in lib/actions/property-documents.ts — because that file is
 * "use server" and may only export async functions; a const export evaluates
 * fine in dev but crashes every server action on the route in production
 * ("A 'use server' file can only export async functions, found object").
 */
export const PROPERTY_DOC_TYPES: readonly DocType[] = [
  "title_deed",
  "permit",
  "plan",
  "contract",
  "valuation",
  "other",
] as const;

/** doc_type options offered on a contact (KYC paperwork subset, doc 02 §C3). */
export const CONTACT_DOC_TYPES: readonly DocType[] = [
  "id_document",
  "proof_of_address",
  "source_of_funds",
  "contract",
  "other",
] as const;

/**
 * The CDD subset of the contact types — passport scans, proof of address,
 * source-of-funds declarations. These are the most sensitive PII the desk
 * holds and are ADMIN-ONLY by need-to-know (audit 2026-08-29, SEC-02): a
 * hired agent does not need every contact's passport. Enforced three deep —
 * here at upload, by `documents_select` visibility filtering, and by the
 * 0072 CHECK, which refuses an 'internal' KYC contact row from ANY path,
 * service_role included.
 */
export const KYC_CONTACT_DOC_TYPES: readonly DocType[] = [
  "id_document",
  "proof_of_address",
  "source_of_funds",
] as const;

/** Visibility a contact document must carry: KYC → admin_only, the rest stay
 *  org-internal (contracts are working documents, not CDD records). */
export function contactDocVisibility(docType: DocType): "admin_only" | "internal" {
  return (KYC_CONTACT_DOC_TYPES as readonly string[]).includes(docType)
    ? "admin_only"
    : "internal";
}
