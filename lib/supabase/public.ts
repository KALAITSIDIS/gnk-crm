import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Anonymous, session-less client for the ONE public route in this app
 * (`/p/[token]`, IMPROVEMENTS B3).
 *
 * Deliberately NOT the service-role client. A public path must not hold the
 * role that bypasses RLS; the anon key reaches no TABLE at all, only the
 * handful of `security definer` functions granted to `anon` by name. That keeps
 * the blast radius of this route to what those functions do, no matter what the
 * page code does.
 *
 * HOW MANY, AND WHICH, IS NOT RESTATED HERE. This comment used to say "the two
 * functions migration 0023 grants it", which was true when 0023 shipped and has
 * been wrong since: 0057 and 0084 added more, 0087 revoked the enquiry pair, and
 * the real number is six. A count kept in prose beside the client it describes is
 * a second copy of a fact, and it went stale in the one file whose job is to
 * justify the blast radius — found by the 2026-09-08 re-verification of the
 * 2026-09-06 audit response, which is the same class of defect the audit was
 * about.
 *
 * The list lives in exactly one place, `scripts/backup/verify-restore.sql`,
 * where it is PINNED — a restore that drops those grants silently kills every
 * live proposal link and the marketing feed, so the pack asserts them and the
 * count is checkable by grep. Read it there.
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
