"use server";

import { redirect } from "next/navigation";
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
    return { error: "Invalid email or password" };
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
