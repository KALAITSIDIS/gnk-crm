import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Local stack defaults (standard public demo keys, identical on every machine).
// Override via env when running against a different stack.
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
export const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
export const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

export const ORG_A = "00000000-0000-0000-0000-000000000001"; // seeded org
export const ORG_B = "bbbbbbbb-0000-0000-0000-000000000001"; // test fixture org

export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
}

/** Create an auth user + profile via service role, return a signed-in client. */
export async function createTestUser(
  admin: SupabaseClient,
  email: string,
  role: "admin" | "agent" | "listing_manager",
  orgId: string,
): Promise<TestUser> {
  const password = "test-password-1234";
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) throw new Error(`createUser ${email}: ${createErr.message}`);
  const id = created.user.id;

  const { error: profileErr } = await admin.from("profiles").insert({
    id,
    org_id: orgId,
    role,
    full_name: `Test ${role} ${email}`,
    email,
  });
  if (profileErr) throw new Error(`profile ${email}: ${profileErr.message}`);

  const client = anonClient();
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`signIn ${email}: ${signInErr.message}`);

  return { id, email, client };
}
