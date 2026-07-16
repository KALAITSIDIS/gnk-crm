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
