import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_PASSWORD, anonClient, createTestUser, serviceClient, type TestUser } from "./helpers";

type Job = Database["public"]["Tables"]["notification_jobs"]["Row"];

/**
 * 0112: the activation preview of the lead escalation — an admin asks "if
 * THESE values were switched on now, which enquiries would the sweep mint,
 * who would the worker actually e-mail, and why not the rest" — and the
 * one eligibility rule behind it, `lead_escalation_candidates`, which the
 * sweep now mints from too (audit 2026-09-22, sixth brief).
 *
 * Everything runs on FIXED dates through p_now (the 0110 lesson: a scenario
 * that only fails on some days is not coverage): the brief's Friday-night
 * enquiry swept on Monday 09:20 Nicosia, and a Saturday-night enquiry across
 * the 25 October daylight-saving switch. The policy row stays OFF for the
 * whole file except inside one test that proves the preview agrees with the
 * real sweep. The dates are in 2099 — the same calendar as 2026 (Friday 25
 * September, switches on 29 March and 25 October) — so the live five-minute
 * cron, on the real clock, can never find one of these leads due while the
 * policy is on. They were in 2026 until the 2026-09-24 clock sweep: from 28
 * September 2026 the cron could have minted one inside that stretch. The
 * first test below keeps it so.
 *
 * The preview must WRITE NOTHING: policies, leads, jobs, events. The
 * "writes nothing" test compares snapshots taken before the first preview
 * call, and runs before the one test that lets the real sweep write.
 *
 * TWO THROWAWAY ORGANISATIONS (the events-chain-order idiom), deleted at
 * the end as postgres, events included: the preview's counts and its
 * bounded page are over EVERY open enquiry of an organisation, and the
 * shared fixture organisations carry a hundred-odd from other suites.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const svc = serviceClient();
const run = Date.now().toString(36);
const ORG_P = randomUUID(); // the caller's organisation
const ORG_Q = randomUUID(); // the other one
const SLUG_P = `preview-a-${run}`;
const SLUG_Q = `preview-b-${run}`;
const REDACTED = "[erased at the contact's request]";
const made: string[] = [];
let pg: Client;

let adminA: TestUser;
let agentA1: TestUser;
let agentA2: TestUser;
let inactiveA: TestUser;
let managerA: TestUser;
let noEmailA: TestUser;
let adminB: TestUser;
let agentB: TestUser;
let policyBefore: unknown;

const HOURS = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
const MONDAY_0920 = "2099-09-28T06:20:00Z"; // Monday 28 September 2099 09:20 Asia/Nicosia (summer time; 2099 has 2026's calendar)
const FRIDAY_2200 = "2099-09-25T19:00:00Z"; // Friday 25 September 22:00 local → due Monday 09:15 (06:15Z)
const STRANGER = "11111111-1111-1111-1111-111111111111";

const policy = (recipients: string[], extra: Record<string, unknown> = {}) => ({
  enabled: false, // the preview evaluates as if ON whatever this says
  after_minutes: 15,
  max_age_hours: 48,
  recipients,
  working_hours: HOURS,
  timezone: "Asia/Nicosia",
  ...extra,
});

interface PreviewRecipient {
  id: string;
  full_name: string | null;
  role: string | null;
  is_active: boolean | null;
  has_email: boolean | null;
  eligible: boolean;
  reason: string;
}
interface PreviewLead {
  lead_id: string;
  received_at: string;
  due_at: string;
  verdict: string;
  status: string;
  assignee_id: string | null;
  assignee_name: string | null;
  property_ref: string | null;
  recipients_eligible: number;
  only_recipient_is_assignee: boolean;
  job_state: string | null;
}
interface Preview {
  evaluated_at: string;
  evaluated_as_enabled: boolean;
  stored_enabled: boolean;
  policy: Record<string, unknown>;
  recipients: PreviewRecipient[];
  eligible_recipient_count: number;
  counts: Record<string, number>;
  leads: PreviewLead[];
  truncated: boolean;
  limit: number;
}

async function setPolicy(value: unknown) {
  const { error } = await svc.from("cyprus_config").update({ value: value as never }).eq("key", "lead_escalation");
  if (error) throw new Error(`setPolicy: ${error.message}`);
}

async function submit(label: string, slug = SLUG_P) {
  const { data, error } = await svc.rpc("submit_public_enquiry", {
    p_org_slug: slug,
    p_name: `Preview ${run} ${label}`,
    p_email: `preview-${label}-${run}@example.invalid`,
    p_phone: "",
    p_message: `preview probe ${run} ${label}`,
    p_property_ref: "",
    p_idempotency_key: `prev-${run}-${label}`,
  });
  if (error) throw new Error(`submit ${label}: ${error.message}`);
  const row = data![0]!;
  made.push(row.lead_id);
  return row.lead_id as string;
}

async function patchLead(leadId: string, patch: Record<string, unknown>) {
  const { error } = await svc.from("leads").update(patch as never).eq("id", leadId);
  if (error) throw new Error(`patchLead: ${error.message}`);
}

/** The preview, through a session. Returns the document or the refusal's words. */
async function preview(
  client: Pick<TestUser["client"], "rpc">,
  p_policy: unknown,
  opts: { limit?: number; now?: string } = {},
): Promise<{ doc: Preview | null; error: { code: string; message: string } | null }> {
  const { data, error } = await client.rpc("preview_lead_escalation", {
    p_policy,
    ...(opts.limit !== undefined ? { p_limit: opts.limit } : {}),
    ...(opts.now !== undefined ? { p_now: opts.now } : {}),
  } as never);
  return { doc: (data as Preview | null) ?? null, error: error ? { code: error.code, message: error.message } : null };
}

const leadOf = (doc: Preview, id: string) => doc.leads.find((l) => l.lead_id === id) ?? null;
const recipientOf = (doc: Preview, id: string) => doc.recipients.find((r) => r.id === id) ?? null;

async function escalationJobs(leadIds: string[]): Promise<Job[]> {
  const { data, error } = await svc.from("notification_jobs").select("*").in("lead_id", leadIds).eq("kind", "lead_escalation").order("created_at");
  if (error) throw new Error(`escalationJobs: ${error.message}`);
  return (data ?? []) as Job[];
}

/** Everything a preview must leave alone, for the fixtures of this file. */
async function snapshot() {
  const [{ data: cfg }, { data: leads }, { data: jobs }, { data: events }, { count: allEscalations }] = await Promise.all([
    svc.from("cyprus_config").select("value, updated_at").eq("key", "lead_escalation").single(),
    svc.from("leads").select("id, status, first_response_at, message, assigned_agent_id, updated_at").in("id", made).order("id"),
    // escalation rows only: a dev server on :3000 lets the two-minute cron claim the DESK-ALERT rows mid-file (the sweep-runs trap)
    svc.from("notification_jobs").select("id, lead_id, kind, state, attempts, key_serial, updated_at").in("lead_id", made).eq("kind", "lead_escalation").order("id"),
    svc.from("events").select("id").eq("entity_type", "lead").in("entity_id", made).eq("event_type", "lead_escalation"),
    svc.from("notification_jobs").select("id", { count: "exact", head: true }).eq("kind", "lead_escalation"),
  ]);
  return { cfg, leads, jobs, escalationEventIds: (events ?? []).map((e) => e.id).sort(), allEscalations };
}

// fixtures
let friday: string; // due
let monday: string; // due (received in hours)
let young: string; // not yet due
let backlog: string; // past the cutoff
let answered: string; // absent
let closed: string; // absent
let redacted: string; // absent
let withJob: string; // already escalated
let assigned: string; // due, assigned to agentA2
let dst: string; // Saturday 24 October 22:00 local → Monday 26 October 09:15 WINTER time (07:15Z)
let inB: string; // org B
let before: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await pg.query("insert into organizations (id, name, slug) values ($1, $2, $3), ($4, $5, $6)", [
    ORG_P,
    `Preview ${run}`,
    SLUG_P,
    ORG_Q,
    `Preview other ${run}`,
    SLUG_Q,
  ]);
  [adminA, agentA1, agentA2, inactiveA, managerA, noEmailA, adminB, agentB] = await Promise.all([
    createTestUser(svc, `preview-admin-a-${run}@test.local`, "admin", ORG_P),
    createTestUser(svc, `preview-agent-a1-${run}@test.local`, "agent", ORG_P),
    createTestUser(svc, `preview-agent-a2-${run}@test.local`, "agent", ORG_P),
    createTestUser(svc, `preview-inactive-a-${run}@test.local`, "agent", ORG_P),
    createTestUser(svc, `preview-manager-a-${run}@test.local`, "listing_manager", ORG_P),
    createTestUser(svc, `preview-noemail-a-${run}@test.local`, "agent", ORG_P),
    createTestUser(svc, `preview-admin-b-${run}@test.local`, "admin", ORG_Q),
    createTestUser(svc, `preview-agent-b-${run}@test.local`, "agent", ORG_Q),
  ]);
  await svc.from("profiles").update({ is_active: false }).eq("id", inactiveA.id);
  await svc.from("profiles").update({ email: "   " }).eq("id", noEmailA.id);

  const { data } = await svc.from("cyprus_config").select("value").eq("key", "lead_escalation").single();
  policyBefore = data!.value;
  await setPolicy(policy([adminA.id])); // OFF, with the seeded hours — the cron mints nothing

  // SEQUENTIAL on purpose (the 2026-09-22 partition-health lesson)
  friday = await submit("friday");
  monday = await submit("monday");
  young = await submit("young");
  backlog = await submit("backlog");
  answered = await submit("answered");
  closed = await submit("closed");
  redacted = await submit("redacted");
  withJob = await submit("with-job");
  assigned = await submit("assigned");
  dst = await submit("dst");
  inB = await submit("in-b", SLUG_Q);

  await patchLead(friday, { received_at: FRIDAY_2200 });
  await patchLead(monday, { received_at: "2099-09-28T06:00:00Z" }); // Monday 09:00 local → due 09:15
  await patchLead(young, { received_at: "2099-09-28T06:10:00Z" }); // Monday 09:10 local → due 09:25
  await patchLead(backlog, { received_at: "2099-09-01T07:00:00Z" }); // due 1 September 10:15 local — weeks before
  await patchLead(answered, { received_at: FRIDAY_2200, first_response_at: "2099-09-28T06:05:00Z" });
  await patchLead(closed, { received_at: FRIDAY_2200, status: "lost", lost_reason: "test" });
  await patchLead(redacted, { received_at: FRIDAY_2200, message: REDACTED });
  await patchLead(withJob, { received_at: FRIDAY_2200 });
  await patchLead(assigned, { received_at: FRIDAY_2200, assigned_agent_id: agentA2.id });
  await patchLead(dst, { received_at: "2099-10-24T19:00:00Z" });
  await patchLead(inB, { received_at: FRIDAY_2200 });
  const { error: jobErr } = await svc.from("notification_jobs").insert({ org_id: ORG_P, lead_id: withJob, kind: "lead_escalation" });
  if (jobErr) throw new Error(`with-job: ${jobErr.message}`);

  before = await snapshot();
});

afterAll(async () => {
  await setPolicy(policyBefore);
  if (made.length) {
    await svc.from("tasks").delete().in("lead_id", made);
    await svc.from("leads").delete().in("id", made); // jobs cascade
  }
  for (const u of [adminA, agentA1, agentA2, inactiveA, managerA, noEmailA, adminB, agentB]) {
    if (u) await svc.auth.admin.deleteUser(u.id).catch(() => undefined);
  }
  // the throwaway organisations go with their events, as postgres
  for (const org of [ORG_P, ORG_Q]) {
    await pg.query("delete from profiles where org_id = $1", [org]);
    await pg.query("delete from events where org_id = $1", [org]);
    await pg.query("delete from events_chain_checkpoint where org_id = $1", [org]);
    await pg.query("delete from chain_checks where org_id = $1", [org]);
    await pg.query("delete from organizations where id = $1", [org]);
  }
  await pg.end();
});

describe("who may preview", () => {
  it("an agent is refused, an aal1 admin session is refused, anon is refused at the grant", async () => {
    expect((await preview(agentA1.client, policy([adminA.id]))).error?.message).toMatch(/admins only/i);
    const aal1 = anonClient();
    const { error: signIn } = await aal1.auth.signInWithPassword({ email: adminA.email, password: TEST_PASSWORD });
    expect(signIn).toBeNull();
    expect((await preview(aal1, policy([adminA.id]))).error?.message).toMatch(/second factor/i);
    expect((await preview(anonClient(), policy([adminA.id]))).error?.code).toBe("42501");
  });

  it("the candidates function is service_role-only; a signed-in admin may not read it directly", async () => {
    const a = await anonClient().rpc("lead_escalation_candidates", {} as never);
    expect(a.error?.code).toBe("42501");
    const u = await adminA.client.rpc("lead_escalation_candidates", {} as never);
    expect(u.error?.code).toBe("42501");
    const s = await svc.rpc("lead_escalation_candidates", { p_org: ORG_P, p_now: MONDAY_0920 } as never);
    expect(s.error).toBeNull();
  });

  it("a limit outside 1..200 is refused with a sentence", async () => {
    expect((await preview(adminA.client, policy([adminA.id]), { limit: 0 })).error?.message).toMatch(/limit/i);
    expect((await preview(adminA.client, policy([adminA.id]), { limit: 201 })).error?.message).toMatch(/limit/i);
  });
});

describe("the fixtures are beyond the live cron's reach", () => {
  // The one test that switches the policy ON lets the live five-minute cron
  // sweep every org on the REAL clock. Dated in 2026, these leads became due
  // to it from 28 September 2026 and could be minted inside that stretch,
  // breaking `minted = 3` (the 2026-09-24 clock sweep). Received after 2098,
  // none is ever due to it, whatever day the suite runs.
  it("every enquiry this file makes was received after 2098", async () => {
    const { data, error } = await svc.from("leads").select("received_at").in("id", made);
    expect(error).toBeNull();
    expect(data, "each fixture is read back").toHaveLength(made.length);
    const reachable = (data ?? []).map((l) => l.received_at).filter((at) => Date.parse(at) < Date.UTC(2098, 0, 1));
    expect(reachable, "dated within the live cron's reach").toEqual([]);
  });
});

describe("what the preview says, on Monday 28 September at 09:20 Nicosia", () => {
  let doc: Preview;

  beforeAll(async () => {
    const res = await preview(adminA.client, policy([adminA.id, agentA2.id, inactiveA.id, managerA.id, noEmailA.id, agentB.id, STRANGER]), {
      now: MONDAY_0920,
    });
    if (res.error) throw new Error(`preview: ${res.error.message}`);
    doc = res.doc!;
  });

  it("evaluates the proposed values AS IF ON, and says the stored policy is off", () => {
    expect(doc.evaluated_as_enabled).toBe(true);
    expect(doc.stored_enabled).toBe(false);
    expect(doc.policy).toMatchObject({ enabled: true, after_minutes: 15, max_age_hours: 48, working_hours: HOURS, timezone: "Asia/Nicosia" });
    expect(new Date(doc.evaluated_at).toISOString()).toBe(new Date(MONDAY_0920).toISOString());
  });

  it("classifies every enquiry of the caller's organisation, and shows none of the other's", () => {
    expect(leadOf(doc, friday)?.verdict, "waited through the weekend: due since 09:15").toBe("due");
    expect(leadOf(doc, monday)?.verdict, "received in hours").toBe("due");
    expect(leadOf(doc, assigned)?.verdict).toBe("due");
    expect(leadOf(doc, young)?.verdict, "due at 09:25 — five minutes from now").toBe("not_yet_due");
    expect(leadOf(doc, backlog)?.verdict, "its wait ended weeks ago").toBe("past_cutoff");
    expect(leadOf(doc, withJob)).toMatchObject({ verdict: "already_escalated", job_state: "pending" });
    expect(leadOf(doc, dst)?.verdict, "not yet October").toBe("not_yet_due");
    for (const [label, id] of [["answered", answered], ["closed", closed], ["redacted", redacted]] as const) {
      expect(leadOf(doc, id), `${label} is not an enquiry to escalate, so it is not listed`).toBeNull();
    }
    expect(leadOf(doc, inB), "another organisation's enquiry never appears").toBeNull();
    expect(new Date(leadOf(doc, friday)!.due_at).toISOString()).toBe("2099-09-28T06:15:00.000Z");
  });

  it("counts the sweep's jobs apart from the worker's e-mails", () => {
    expect(doc.counts).toMatchObject({
      considered: 7, // friday, monday, young, backlog, with-job, assigned, dst
      due: 3,
      would_send: 3,
      no_recipient: 0,
      only_recipient_is_assignee: 0,
      not_yet_due: 2,
      past_cutoff: 1,
      already_escalated: 1,
    });
  });

  it("explains every proposed recipient with one reason word", () => {
    expect(recipientOf(doc, adminA.id)).toMatchObject({ eligible: true, reason: "ok", role: "admin", is_active: true, has_email: true });
    expect(recipientOf(doc, agentA2.id)).toMatchObject({ eligible: true, reason: "ok" });
    expect(recipientOf(doc, inactiveA.id)).toMatchObject({ eligible: false, reason: "inactive" });
    expect(recipientOf(doc, managerA.id)).toMatchObject({ eligible: false, reason: "not_admin_or_agent" });
    expect(recipientOf(doc, noEmailA.id)).toMatchObject({ eligible: false, reason: "no_email" });
    expect(recipientOf(doc, agentB.id), "another organisation's agent is nobody here — and is not named").toMatchObject({
      eligible: false,
      reason: "not_in_organisation",
      full_name: null,
    });
    expect(recipientOf(doc, STRANGER)).toMatchObject({ eligible: false, reason: "not_in_organisation" });
    expect(doc.eligible_recipient_count).toBe(2);
    expect(doc.recipients.map((r) => r.id), "in the order proposed").toEqual([
      adminA.id,
      agentA2.id,
      inactiveA.id,
      managerA.id,
      noEmailA.id,
      agentB.id,
      STRANGER,
    ]);
  });

  it("removes each lead's own assignee from its recipients, and names the assignee", () => {
    expect(leadOf(doc, friday)).toMatchObject({ recipients_eligible: 2, only_recipient_is_assignee: false, assignee_id: null, assignee_name: null });
    expect(leadOf(doc, assigned)).toMatchObject({ recipients_eligible: 1, only_recipient_is_assignee: false, assignee_id: agentA2.id });
    expect(leadOf(doc, assigned)!.assignee_name).toBeTruthy();
  });

  it("never carries the enquirer: no name, no address, no message", () => {
    const text = JSON.stringify(doc);
    expect(text).not.toContain("example.invalid");
    expect(text).not.toContain(`Preview ${run}`);
    expect(text).not.toContain("preview probe");
  });
});

describe("the cases an admin most needs to see", () => {
  it("an enquiry whose only eligible recipient is its assignee is flagged, and counted as one the worker could not send", async () => {
    const { doc, error } = await preview(adminA.client, policy([agentA2.id]), { now: MONDAY_0920 });
    expect(error).toBeNull();
    expect(leadOf(doc!, assigned)).toMatchObject({ verdict: "due", recipients_eligible: 0, only_recipient_is_assignee: true });
    expect(leadOf(doc!, friday)).toMatchObject({ verdict: "due", recipients_eligible: 1, only_recipient_is_assignee: false });
    expect(doc!.counts).toMatchObject({ due: 3, would_send: 2, no_recipient: 1, only_recipient_is_assignee: 1 });
  });

  it("with nobody ticked, every due enquiry is one the worker could not send", async () => {
    const { doc, error } = await preview(adminA.client, policy([]), { now: MONDAY_0920 });
    expect(error).toBeNull();
    expect(doc!.eligible_recipient_count).toBe(0);
    expect(doc!.counts).toMatchObject({ due: 3, would_send: 0, no_recipient: 3 });
  });

  it("the Saturday-night enquiry across the October switch is due Monday 09:15 WINTER time", async () => {
    const { doc, error } = await preview(adminA.client, policy([adminA.id]), { now: "2099-10-26T07:20:00Z" });
    expect(error).toBeNull();
    const row = leadOf(doc!, dst)!;
    expect(row.verdict).toBe("due");
    expect(new Date(row.due_at).toISOString()).toBe("2099-10-26T07:15:00.000Z");
    expect(leadOf(doc!, friday)?.verdict, "a month later the September enquiries are past the cutoff").toBe("past_cutoff");
  });

  it("a wider cutoff admits the backlog; around the clock, the Friday enquiry was due on Friday", async () => {
    const wide = await preview(adminA.client, policy([adminA.id], { max_age_hours: 720 }), { now: MONDAY_0920 });
    expect(wide.error).toBeNull();
    expect(leadOf(wide.doc!, backlog)?.verdict).toBe("due");
    const flat = await preview(adminA.client, policy([adminA.id], { working_hours: null }), { now: MONDAY_0920 });
    expect(flat.error).toBeNull();
    expect(new Date(leadOf(flat.doc!, friday)!.due_at).toISOString()).toBe("2099-09-25T19:15:00.000Z");
  });

  it("is bounded: the limit cuts the list, due enquiries first, and says so", async () => {
    const { doc, error } = await preview(adminA.client, policy([adminA.id]), { now: MONDAY_0920, limit: 2 });
    expect(error).toBeNull();
    expect(doc!.leads).toHaveLength(2);
    expect(doc!.leads.every((l) => l.verdict === "due")).toBe(true);
    expect(doc!.truncated).toBe(true);
    expect(doc!.limit).toBe(2);
    expect(doc!.counts.considered, "the counts are over everything, not the page").toBe(7);
  });

  it("malformed values fall back exactly as the sweep's reader does", async () => {
    const { doc, error } = await preview(adminA.client, { after_minutes: 0, recipients: ["nope"], working_hours: { days: [8] }, timezone: "Mars/Olympus" }, { now: MONDAY_0920 });
    expect(error).toBeNull();
    expect(doc!.policy).toMatchObject({ enabled: true, after_minutes: 15, max_age_hours: 48, recipients: [], working_hours: null, timezone: "Asia/Nicosia" });
  });

  it("another organisation's admin sees only its own enquiry", async () => {
    const { doc, error } = await preview(adminB.client, policy([agentB.id]), { now: MONDAY_0920 });
    expect(error).toBeNull();
    expect(doc!.leads.map((l) => l.lead_id)).toEqual([inB]);
    expect(recipientOf(doc!, agentB.id)).toMatchObject({ eligible: true, reason: "ok" });
  });
});

describe("previewing writes nothing", () => {
  it("policy, leads, jobs and escalation events are as they were before the first preview", async () => {
    // one more preview — with every kind of recipient and a small page — then the comparison
    const { error } = await preview(adminA.client, policy([adminA.id, agentA2.id, inactiveA.id, STRANGER]), { now: MONDAY_0920, limit: 1 });
    expect(error).toBeNull();
    const after = await snapshot();
    expect(after.cfg, "the policy row").toEqual(before.cfg);
    expect(after.leads, "the leads").toEqual(before.leads);
    expect(after.jobs, "the escalation rows").toEqual(before.jobs);
    expect(after.allEscalations, "no escalation was minted anywhere").toBe(before.allEscalations);
    expect(after.escalationEventIds, "no lead_escalation event came from a preview").toEqual(before.escalationEventIds);
  });
});

describe("one rule: the preview and the sweep agree", () => {
  it("what the preview calls due is exactly what raise_lead_escalations mints at the same instant", async () => {
    const { doc, error } = await preview(adminA.client, policy([adminA.id]), { now: MONDAY_0920 });
    expect(error).toBeNull();
    const predicted = doc!.leads.filter((l) => l.verdict === "due").map((l) => l.lead_id).sort();
    expect(predicted).toEqual([friday, monday, assigned].sort());
    const beforeMint = (await escalationJobs(made)).map((j) => j.lead_id);

    await setPolicy(policy([adminA.id], { enabled: true }));
    try {
      const { data: minted, error: raiseErr } = await svc.rpc("raise_lead_escalations", { p_org: ORG_P, p_now: MONDAY_0920 });
      expect(raiseErr).toBeNull();
      expect(minted).toBe(3);
    } finally {
      await setPolicy(policy([adminA.id]));
    }
    const afterMint = (await escalationJobs(made)).map((j) => j.lead_id);
    const newlyMinted = afterMint.filter((id) => !beforeMint.includes(id)).sort();
    expect(newlyMinted, "the sweep minted the preview's due set and nothing else").toEqual(predicted);

    // and now the preview reports them as already escalated
    const again = await preview(adminA.client, policy([adminA.id]), { now: MONDAY_0920 });
    expect(again.doc!.counts).toMatchObject({ due: 0, would_send: 0, already_escalated: 4 });
    expect(leadOf(again.doc!, friday)).toMatchObject({ verdict: "already_escalated", job_state: "pending" });
  });

  it("the events chain still verifies after the door, the sweep and every preview in this file", async () => {
    const { data } = await svc.rpc("verify_events_chain", { p_org: ORG_P, p_from_id: null as never });
    expect((data as Array<{ ok: boolean }>)[0]).toMatchObject({ ok: true });
  });
});
