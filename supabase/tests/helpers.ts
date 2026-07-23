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

/**
 * TEST-1 (audit 2026-07-22). The suite used to run inside the SEEDED org —
 * the one `admin@gnk.local` logs into — so every run left `Test admin …`
 * profiles, `RLS Stage …` rows and fixture keys in the local dev database.
 * They could never be cleaned up either: `events` is append-only and RLS
 * denies DELETE on the business tables (guardrail 1, doc 04), so the dev
 * dashboard's "Top agents by activity" and "Latest events" filled with test
 * rows and stayed that way until a `db reset`.
 *
 * Both test orgs are now fixtures the suite owns and seeds itself. Nothing
 * here touches SEEDED_ORG, and RLS test 23 asserts that.
 */
export const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001"; // primary test org
export const ORG_B = "bbbbbbbb-0000-0000-0000-000000000001"; // cross-org isolation fixture

/** The org the dev app runs on. Tests must NEVER write here. */
export const SEEDED_ORG = "00000000-0000-0000-0000-000000000001";

/**
 * Every pipeline from `0003_seed.sql`, verbatim.
 *
 * ALL FOUR deal types are required, not just `sale`: the deal fixtures read
 * the sale stage at sort_order 1, but RLS test 20 exercises add_deal_stage /
 * reorder_stage against **advisory**. Seeding only `sale` left advisory empty,
 * so the stage the test added was the only one and "reorder up" had no
 * neighbour to swap with — it passed on reruns purely because the previous
 * run's stage was still there. A fresh database (i.e. CI) failed.
 */
type StageSeed = [name: string, sortOrder: number, isWon: boolean, isLost: boolean];

const SEED_STAGES: Record<string, StageSeed[]> = {
  sale: [
    ["New", 1, false, false],
    ["Qualified", 2, false, false],
    ["Viewing", 3, false, false],
    ["Offer", 4, false, false],
    ["Reservation", 5, false, false],
    ["Legal & Bank", 6, false, false],
    ["Completed", 7, true, false],
    ["Lost", 8, false, true],
  ],
  rental: [
    ["New", 1, false, false],
    ["Qualified", 2, false, false],
    ["Viewing", 3, false, false],
    ["Application", 4, false, false],
    ["Contract Signed", 5, true, false],
    ["Lost", 6, false, true],
  ],
  antiparoxi: [
    ["Landowner Contact", 1, false, false],
    ["Site & Zoning Review", 2, false, false],
    ["Developer Matching", 3, false, false],
    ["Exchange Terms", 4, false, false],
    ["Legal Structuring", 5, false, false],
    ["Agreement Signed", 6, true, false],
    ["Lost", 7, false, true],
  ],
  advisory: [
    ["Enquiry", 1, false, false],
    ["Scoping", 2, false, false],
    ["Proposal Sent", 3, false, false],
    ["Engaged", 4, true, false],
    ["Lost", 5, false, true],
  ],
};

/**
 * Creates a test org and the org-scoped reference data the suite depends on:
 * `deal_stages` (read by the deal fixtures) and a PAF `district` (needed by
 * `generateReference`). `cyprus_config` is global, so it needs no per-org row.
 * Idempotent — safe to call from every suite's beforeAll.
 */
export async function ensureTestOrg(
  admin: SupabaseClient,
  orgId: string,
  name: string,
  slug: string,
): Promise<void> {
  const { error: orgErr } = await admin
    .from("organizations")
    .upsert({ id: orgId, name, slug }, { onConflict: "id" });
  if (orgErr) throw new Error(`ensureTestOrg org ${slug}: ${orgErr.message}`);

  // Seed each pipeline independently so a partially-seeded org self-repairs.
  const { data: existingStages, error: stageReadErr } = await admin
    .from("deal_stages")
    .select("deal_type")
    .eq("org_id", orgId);
  if (stageReadErr) throw new Error(`ensureTestOrg stages ${slug}: ${stageReadErr.message}`);
  const seeded = new Set((existingStages ?? []).map((s) => s.deal_type as string));

  const missing = Object.entries(SEED_STAGES)
    .filter(([dealType]) => !seeded.has(dealType))
    .flatMap(([dealType, stages]) =>
      stages.map(([stageName, sort_order, is_won, is_lost]) => ({
        org_id: orgId,
        deal_type: dealType,
        name: stageName,
        sort_order,
        is_won,
        is_lost,
      })),
    );

  if (missing.length > 0) {
    const { error } = await admin.from("deal_stages").insert(missing);
    if (error) throw new Error(`ensureTestOrg stage insert ${slug}: ${error.message}`);
  }

  const { error: districtErr } = await admin.from("districts").upsert(
    {
      org_id: orgId,
      code: "PAF",
      name: { en: "Paphos", el: "Πάφος", ru: "Пафос" },
    },
    { onConflict: "org_id,code" },
  );
  if (districtErr) throw new Error(`ensureTestOrg district ${slug}: ${districtErr.message}`);
}

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
