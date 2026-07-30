import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Anonymous, session-less client for the ONE public route in this app
 * (`/p/[token]`, IMPROVEMENTS B3).
 *
 * Deliberately NOT the service-role client. A public path must not hold the
 * role that bypasses RLS; the anon key can reach exactly what doc 04 grants
 * `anon`, which is nothing at all except the two `security definer` functions
 * migration 0023 grants it by name. That keeps the blast radius of this route
 * equal to "resolve one token", no matter what the page code does.
 *
 * No cookies: there is no session to read or refresh, and reading them would
 * make the page dynamic on a visitor's auth state, which it must never be.
 */
export function createPublicClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
