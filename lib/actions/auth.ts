"use server";

import * as Sentry from "@sentry/nextjs";
import { redirect } from "next/navigation";
import { isCredentialRejection } from "@/lib/services/auth-errors";
import { needsMfaChallenge } from "@/lib/services/mfa";
import { createClient } from "@/lib/supabase/server";
import { loginSchema } from "@/lib/validators/auth";

export type AuthActionState = { error: string | null };

export async function login(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    // A real credential rejection stays deliberately vague — naming the field
    // would turn this form into an account-existence oracle.
    if (isCredentialRejection(error)) {
      return { error: "Invalid email or password" };
    }
    // Everything else is infrastructure, and must not wear a password's clothes.
    // See lib/services/auth-errors.ts: on 2026-08-09 a disabled API key showed
    // here as "Invalid email or password" and cost hours. Sentry, not just
    // console, because Vercel keeps ~1h of runtime logs on this plan and nobody
    // reports "I can't log in" that fast.
    Sentry.captureException(
      new Error(`Sign-in failed: ${error.status ?? "?"} ${error.code ?? ""} ${error.message}`),
    );
    return {
      error: "Sign-in is temporarily unavailable — this is not your password. Please try again shortly.",
    };
  }

  // 2FA (C2): route to the challenge here rather than letting the proxy bounce
  // a /dashboard navigation. A middleware redirect issued in response to a
  // server-action redirect renders the challenge but leaves the browser URL on
  // /dashboard, which is confusing and unlinkable. The proxy gate stays as
  // defence for direct navigation.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (needsMfaChallenge(aal?.currentLevel, aal?.nextLevel)) {
    redirect("/login/verify");
  }

  redirect("/dashboard");
}

export async function logout(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
