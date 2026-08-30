"use server";

import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
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
  const profile = await getCurrentProfile(supabase);

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

  // the fact, never the credential — payload stays empty on purpose
  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "user",
    entityId: profile.id,
    eventType: "password_changed",
    payload: {},
  });

  return { error: null, savedAt: Date.now() };
}
