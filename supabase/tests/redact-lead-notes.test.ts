import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ANON_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * The REAL `redactLead`, against the REAL local stack (T-redact-lead-notes):
 * redacting an unlinked enquiry blanks the desk's notes about it, through
 * 0094's own redaction rule (body → null with redacted_at set — the only
 * UPDATE its trigger admits, and only for the service role), bounded by the
 * caller's organisation and that lead, and it RESUMES a redaction whose notes
 * were left. The note's `conversation_logged` event — hash-chained, holding
 * the note's id and digest, never its words — is untouched.
 *
 * Nothing below the action is stubbed but the Next.js request plumbing:
 * `createClient` is an aal2 session of the fixture admin, `createAdminClient`
 * the real service client, `logEvent` the real chain. Throwaway organisations,
 * deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const RUN = Date.now().toString(36);
const MARKER = "[erased at the contact's request]";

const state = vi.hoisted(() => ({ queue: [] as unknown[] }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = state.queue.shift();
    if (!c) throw new Error("test harness: no client queued for this action");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return { createAdminClient: () => h.serviceClient() };
});

import { redactLead } from "@/lib/actions/leads";
import { loadLeadsWithUnredactedNotes } from "@/lib/queries/lead-unredacted-notes";

let svc: SupabaseClient;
let pg: Client;
let adminA: TestUser;
const userIds: string[] = [];

async function session(user: TestUser): Promise<SupabaseClient> {
  const { data } = await user.client.auth.getSession();
  const s = data.session!;
  const c = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(error.message);
  return c;
}

async function redact(user: TestUser, leadId: string): Promise<string | null> {
  state.queue.push(await session(user));
  try {
    await redactLead(leadId);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function newLead(org: string): Promise<string> {
  const { data, error } = await svc
    .from("leads")
    .insert({ org_id: org, source: "website", message: `Website enquiry\nName: ZZ Redact ${RUN}\nPhone: 99000000` })
    .select("id")
    .single();
  if (error) throw new Error(`lead fixture: ${error.message}`);
  return data.id as string;
}

/** A note as the desk writes it: log_conversation, as the admin, at aal2. */
async function note(leadId: string, text: string): Promise<string> {
  const { data, error } = await adminA.client.rpc("log_conversation", {
    p_entity_type: "lead",
    p_entity_id: leadId,
    p_channel: "phone",
    p_note: text,
  });
  if (error) throw new Error(`note fixture: ${error.message}`);
  return data as string;
}

const noteRow = async (id: string) =>
  (await pg.query("select org_id::text, body, redacted_at from interaction_notes where id = $1", [id])).rows[0] as {
    org_id: string;
    body: string | null;
    redacted_at: Date | null;
  };
const events = async (leadId: string, type: string) =>
  (
    await pg.query("select count(*)::int as c from events where entity_type = 'lead' and entity_id = $1 and event_type = $2", [
      leadId,
      type,
    ])
  ).rows[0].c as number;

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG_A, `Redact A ${RUN}`, `redact-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `Redact B ${RUN}`, `redact-b-${RUN}`);
  adminA = await createTestUser(svc, `rl-admin-a-${RUN}@test.local`, "admin", ORG_A);
  userIds.push(adminA.id);
});

afterAll(async () => {
  const orgs = [ORG_A, ORG_B];
  await pg.query("delete from interaction_notes where org_id = any($1)", [orgs]);
  await pg.query("delete from notification_jobs where org_id = any($1)", [orgs]);
  await pg.query("delete from tasks where org_id = any($1)", [orgs]);
  await pg.query("delete from leads where org_id = any($1)", [orgs]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  await pg.query("delete from profiles where org_id = any($1)", [orgs]);
  await pg.query("delete from events where org_id = any($1)", [orgs]);
  await pg.query("delete from events_chain_checkpoint where org_id = any($1)", [orgs]);
  await pg.query("delete from chain_checks where org_id = any($1)", [orgs]);
  await pg.query("delete from deal_stages where org_id = any($1)", [orgs]);
  await pg.query("delete from districts where org_id = any($1)", [orgs]);
  await pg.query("delete from organizations where id = any($1)", [orgs]);
  await pg.end();
});

describe("redactLead takes the enquiry's notes with its message", () => {
  it("blanks THIS lead's notes in the caller's organisation, leaves the chain's note events and every other note, logs one event", async () => {
    const lead = await newLead(ORG_A);
    const other = await newLead(ORG_A);
    const n1 = await note(lead, `Called back, she wants a sea view ${RUN}`);
    const n2 = await note(lead, `Second call ${RUN}`);
    const kept = await note(other, `Another enquiry ${RUN}`);
    // a row of ANOTHER organisation that names this lead (planted as postgres):
    // the admin client's org bound is what leaves it alone
    const foreign = (
      await pg.query(
        `insert into interaction_notes (org_id, entity_type, entity_id, channel, body, body_sha256)
         values ($1, 'lead', $2, 'phone', $3, encode(sha256(convert_to($3, 'UTF8')), 'hex')) returning id`,
        [ORG_B, lead, `B's own words ${RUN}`],
      )
    ).rows[0].id as string;
    const loggedBefore = await events(lead, "conversation_logged");

    expect(await redact(adminA, lead)).toBeNull();

    const { rows } = await pg.query("select message from leads where id = $1", [lead]);
    expect(rows[0].message).toBe(MARKER);
    for (const id of [n1, n2]) {
      const r = await noteRow(id);
      expect(r.body, id).toBeNull();
      expect(r.redacted_at, id).not.toBeNull();
    }
    expect((await noteRow(kept)).body).toBe(`Another enquiry ${RUN}`);
    expect((await noteRow(foreign)).body).toBe(`B's own words ${RUN}`);
    expect(await events(lead, "conversation_logged")).toBe(loggedBefore); // the chain is not rewritten
    expect(await events(lead, "redacted")).toBe(1);

    // a second press changes nothing and says so
    expect(await redact(adminA, lead)).toBe("Already redacted.");
    expect(await events(lead, "redacted")).toBe(1);
  });

  it("a redaction interrupted after the message is finished by the same action, and the page offers it until then", async () => {
    const lead = await newLead(ORG_A);
    const n = await note(lead, `Left behind ${RUN}`);
    // the first write happened, the second did not
    await pg.query("update leads set message = $1 where id = $2", [MARKER, lead]);

    const page = await session(adminA);
    expect(await loadLeadsWithUnredactedNotes(page, [lead])).toEqual(new Set([lead]));

    expect(await redact(adminA, lead)).toBeNull();
    expect((await noteRow(n)).body).toBeNull();
    expect(await events(lead, "redacted")).toBe(1);
    expect(await loadLeadsWithUnredactedNotes(page, [lead])).toEqual(new Set());
  });
});
