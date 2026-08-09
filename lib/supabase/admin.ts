import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { assertModernSupabaseKey } from "@/lib/supabase/key-health";

// Service-role client — BYPASSES RLS. Server-only ("server-only" import makes
// any client-bundle inclusion a build error). Use exclusively for operations
// the RLS matrix routes through the service role (doc 04): contact merge,
// admin invites, imports, cross-entity timeline reads. Never for normal CRUD.
export function createAdminClient() {
  assertModernSupabaseKey("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
