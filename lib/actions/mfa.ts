"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { hasVerifiedFactor, mfaSessionState, type MfaSessionState } from "@/lib/services/mfa";
import { createClient } from "@/lib/supabase/server";

/**
 * Two-factor authentication (IMPROVEMENTS C2, doc 02 spec-Essential).
 *
 * TOTP via Supabase Auth. Enrolment is SELF-SERVICE and OPT-IN: a user who has
 * not enrolled signs in exactly as before. Once a factor is verified, that
 * user's every subsequent sign-in requires the code — enforced in `proxy.ts`,
 * which routes an `aal1` session that owes a factor to /login/verify.
 *
 * Enrolment and removal both write to the append-only event log (guardrail 1):
 * turning a second factor off is exactly the kind of act an audit needs.
 */

const codeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app");

export type MfaEnrollState = {
  error: string | null;
  factorId: string | null;
  /** SVG data URL for the authenticator QR */
  qrCode: string | null;
  /** the same secret in text, for a device that cannot scan */
  secret: string | null;
};

export type MfaActionState = { error: string | null; savedAt: number | null };

export interface MfaStatus {
  state: MfaSessionState;
  factors: { id: string; friendlyName: string | null; createdAt: string }[];
}

/** Enrolled factors + this session's assurance state, for the settings panel. */
export async function getMfaStatus(): Promise<MfaStatus> {
  const supabase = await createClient();
  const [{ data: factorData }, { data: aal }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);

  // `listFactors().totp` is already the verified set — an abandoned enrolment
  // must never show here as though 2FA were on.
  const factors = (factorData?.totp ?? [])
    .map((f) => ({
      id: f.id,
      friendlyName: f.friendly_name ?? null,
      createdAt: f.created_at,
    }));

  return {
    state: mfaSessionState(aal?.currentLevel, aal?.nextLevel),
    factors,
  };
}

/**
 * Begin enrolment: returns the QR (and its secret in text) to show the user.
 * The factor exists as `unverified` from here and does NOT gate login until
 * `confirmMfaEnrollment` succeeds.
 */
export async function startMfaEnrollment(): Promise<MfaEnrollState> {
  const supabase = await createClient();
  await getCurrentProfile(supabase); // authenticated + active, or throw

  // Clear out abandoned attempts, which would otherwise pile up against the
  // factor limit. NOTE: `listFactors().totp` contains only VERIFIED factors —
  // unverified ones are reachable solely through `all`.
  const { data: existing } = await supabase.auth.mfa.listFactors();
  const abandoned = (existing?.all ?? []).filter(
    (f) => f.factor_type === "totp" && f.status !== "verified",
  );
  for (const stale of abandoned) {
    await supabase.auth.mfa.unenroll({ factorId: stale.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
  });
  if (error || !data) {
    return { error: error?.message ?? "Could not start enrolment.", factorId: null, qrCode: null, secret: null };
  }

  return {
    error: null,
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
  };
}

/** Finish enrolment by proving the authenticator produces the right code. */
export async function confirmMfaEnrollment(
  factorId: string,
  code: string,
): Promise<MfaActionState> {
  const parsed = codeSchema.safeParse(code);
  if (!parsed.success) return { error: parsed.error.issues[0].message, savedAt: null };

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId });
  if (challengeErr || !challenge) {
    return { error: challengeErr?.message ?? "Could not start the check.", savedAt: null };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code: parsed.data,
  });
  if (verifyErr) {
    return { error: "That code was not accepted. Check the clock on your phone and try again.", savedAt: null };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "user",
    entityId: profile.id,
    eventType: "mfa_enrolled",
    payload: { factor_type: "totp" },
  });

  revalidatePath("/settings/security");
  return { error: null, savedAt: Date.now() };
}

/**
 * Remove a factor. Requires an `aal2` session — otherwise someone who stole a
 * password-only session could simply switch 2FA off, which would make the whole
 * feature decorative.
 */
export async function unenrollMfa(factorId: string): Promise<MfaActionState> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") {
    return {
      error: "Verify with your authenticator first, then you can remove it.",
      savedAt: null,
    };
  }

  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) return { error: error.message, savedAt: null };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "user",
    entityId: profile.id,
    eventType: "mfa_unenrolled",
    payload: { factor_type: "totp" },
  });

  revalidatePath("/settings/security");
  return { error: null, savedAt: Date.now() };
}

/** The login challenge: verify the code and upgrade this session to aal2. */
export async function verifyMfaLogin(
  _prev: MfaActionState,
  formData: FormData,
): Promise<MfaActionState> {
  const parsed = codeSchema.safeParse(String(formData.get("code") ?? ""));
  if (!parsed.success) return { error: parsed.error.issues[0].message, savedAt: null };

  const supabase = await createClient();
  const { data: factorData } = await supabase.auth.mfa.listFactors();
  const totp = (factorData?.totp ?? []).filter((f) => f.status === "verified");
  if (!hasVerifiedFactor(totp)) {
    return { error: "No authenticator is set up for this account.", savedAt: null };
  }

  const factorId = totp[0].id;
  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId });
  if (challengeErr || !challenge) {
    return { error: challengeErr?.message ?? "Could not start the check.", savedAt: null };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code: parsed.data,
  });
  if (verifyErr) {
    // Deliberately vague: this screen is reachable with a stolen password, so
    // it should not describe the state of the account.
    return { error: "That code was not accepted.", savedAt: null };
  }

  return { error: null, savedAt: Date.now() };
}
