import { UsersPanel, type UserRow } from "@/components/features/settings/users-panel";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function UsersSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // pages render in parallel with the layout's admin gate — stop here too
  if (profile.role !== "admin") return null;

  // 2FA state cannot come from `profiles`: auth.mfa_factors is not reachable
  // through PostgREST and auth-js has no public admin call for another user's
  // factors. 0028's security definer RPC answers it as one boolean per profile,
  // and is admin-gated in its own body.
  const [{ data: rows }, { data: mfa, error: mfaError }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, email, role, is_active")
      .order("is_active", { ascending: false })
      .order("full_name", { ascending: true })
      .limit(200),
    supabase.rpc("org_mfa_status"),
  ]);

  // A failed lookup must not read as "nobody has 2FA" — that is the reassuring
  // direction, and this column exists to stop exactly that kind of quiet
  // false comfort. Unknown renders as "—" instead.
  const factorById = new Map<string, boolean>(
    mfaError ? [] : (mfa ?? []).map((m) => [m.profile_id, m.has_verified_factor]),
  );

  const users: UserRow[] = (rows ?? []).map((u) => ({
    id: u.id,
    fullName: u.full_name,
    email: u.email,
    role: u.role,
    isActive: u.is_active,
    isSelf: u.id === profile.id,
    hasTwoFactor: factorById.get(u.id) ?? null,
  }));

  return <UsersPanel users={users} />;
}
