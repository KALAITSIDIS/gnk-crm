"use server";

import { createClient } from "@/lib/supabase/server";

export type EntityKind = "contact" | "property" | "agent";

export interface EntityOption {
  id: string;
  label: string;
  sublabel: string | null;
}

/**
 * Async search backing EntityPicker (doc 06): contacts by name/phone/email,
 * properties by reference/title, agents by name. Org scoping via RLS.
 */
export async function searchEntities(kind: EntityKind, query: string): Promise<EntityOption[]> {
  const supabase = await createClient();
  const q = query.trim().replace(/[%,()]/g, " ").trim();
  if (q.length < 2) return [];

  if (kind === "contact") {
    const { data } = await supabase
      .from("contacts")
      .select("id, display_name, phone_e164, email")
      .eq("is_archived", false)
      .or(`display_name.ilike.%${q}%,phone_e164.ilike.%${q}%,email.ilike.%${q}%`)
      .limit(8);
    return (data ?? []).map((c) => ({
      id: c.id,
      label: c.display_name ?? "Unnamed",
      sublabel: c.phone_e164 ?? c.email,
    }));
  }

  if (kind === "property") {
    const { data } = await supabase
      .from("properties")
      .select("id, reference, title, status")
      .or(`reference.ilike.%${q}%,title->>en.ilike.%${q}%`)
      .limit(8);
    return (data ?? []).map((p) => ({
      id: p.id,
      label: (p.title as { en?: string } | null)?.en || p.reference,
      sublabel: `${p.reference} · ${p.status}`,
    }));
  }

  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("is_active", true)
    .ilike("full_name", `%${q}%`)
    .limit(8);
  return (data ?? []).map((a) => ({ id: a.id, label: a.full_name, sublabel: a.role }));
}
