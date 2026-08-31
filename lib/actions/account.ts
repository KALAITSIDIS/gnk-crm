"use server";

import { logEvent } from "@/lib/services/events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { changePasswordSchema } from "@/lib/validators/account";

/**
 * Self-service password change (audit SEC-03), on the /security page next to
 * 2FA for the same reason 2FA lives there: every role must be able to protect
 * their own account. Until now the ONLY way to shed the invite-time temp
 * password was to ask an admin for a new one — which means the admin knew it.
 *
 * Gated exactly like unenrollMfa: when the account has a verified factor, the
 * session must be aal2 — otherwise a stolen password-only session could
 * rotate the password and own the account outright. An account WITHOUT a
 * factor can only ever be aal1, so its cap is its gate.
 *
 * NO getCurrentProfile HERE — same trap startMfaEnrollment fell into: since
 * 0059 an aal1 session reads NOTHING through RLS, profiles included, so a
 * profile read crashes for exactly the factor-less temp-password user this
 * action exists for (found by the 2026-09-01 post-audit review; the mfa.ts
 * fix covered enrolment but not this sibling). The profile lookup and the
 * event write both go through the service-role client instead: the lookup is
 * keyed by the authenticated user's own id, and the event must be written at
 * aal1 or the password change would be an unlogged mutation.
 */
export type ChangePasswordState = { error: string | null; savedAt: number | null };

export async function changePassword(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const parsed = changePasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated.", savedAt: null };

  // Belt and braces on top of the GoTrue ban (setUserActive): a deactivated
  // profile must not rotate its password into a fresh credential.
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, org_id, is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return { error: "Profile not found.", savedAt: null };
  if (!profile.is_active) return { error: "Account deactivated.", savedAt: null };

  const [{ data: factorData }, { data: aal }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  const hasFactor = (factorData?.totp ?? []).length > 0;
  if (hasFactor && aal?.currentLevel !== "aal2") {
    return {
      error: "Verify with your authenticator first, then change the password.",
      savedAt: null,
    };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.new_password });
  if (error) return { error: error.message, savedAt: null };

  // the fact, never the credential — payload stays empty on purpose.
  // Service-role client: the events insert is aal2-gated by RLS, and the
  // password HAS already changed — losing the event here is not an option.
  await logEvent(admin, {
    orgId: profile.org_id,
    actorId: profile.id,
    entityType: "user",
    entityId: profile.id,
    eventType: "password_changed",
    payload: {},
  });

  return { error: null, savedAt: Date.now() };
}
