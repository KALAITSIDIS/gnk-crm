import { UsersPanel, type UserRow } from "@/components/features/settings/users-panel";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function UsersSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: rows } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, is_active")
    .order("is_active", { ascending: false })
    .order("full_name", { ascending: true })
    .limit(200);

  const users: UserRow[] = (rows ?? []).map((u) => ({
    id: u.id,
    fullName: u.full_name,
    email: u.email,
    role: u.role,
    isActive: u.is_active,
    isSelf: u.id === profile.id,
  }));

  return <UsersPanel users={users} />;
}
