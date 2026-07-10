import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export interface CurrentProfile {
  id: string;
  orgId: string;
  role: Database["public"]["Enums"]["user_role"];
  fullName: string;
}

/** Resolve the signed-in user's profile. Throws when unauthenticated. */
export async function getCurrentProfile(
  supabase: SupabaseClient<Database>,
): Promise<CurrentProfile> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await supabase
    .from("profiles")
    .select("id, org_id, role, full_name")
    .eq("id", user.id)
    .single();
  if (error || !data) throw new Error("Profile not found for authenticated user");

  return { id: data.id, orgId: data.org_id, role: data.role, fullName: data.full_name };
}
