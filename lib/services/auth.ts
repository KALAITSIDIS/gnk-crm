import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export interface CurrentProfile {
  id: string;
  orgId: string;
  role: Database["public"]["Enums"]["user_role"];
  fullName: string;
}

/**
 * Resolve the signed-in user's profile. Throws when unauthenticated,
 * deactivated, or profile-less.
 *
 * Deactivated users: since 0014 the RLS helpers return NULL for them, so this
 * select comes back empty and the generic throw fires. The explicit is_active
 * check below is belt and braces for any environment still pre-0014 — a
 * deactivated user with a live JWT must not pass, ban or no ban.
 */
export async function getCurrentProfile(
  supabase: SupabaseClient<Database>,
): Promise<CurrentProfile> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await supabase
    .from("profiles")
    .select("id, org_id, role, full_name, is_active")
    .eq("id", user.id)
    .single();
  if (error || !data) throw new Error("Profile not found for authenticated user");
  if (!data.is_active) throw new Error("Account deactivated");

  return { id: data.id, orgId: data.org_id, role: data.role, fullName: data.full_name };
}
