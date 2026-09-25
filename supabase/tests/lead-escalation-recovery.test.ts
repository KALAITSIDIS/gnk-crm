import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import {
  ORG_A,
  ORG_B,
  TEST_PASSWORD,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

type Job = Database["public"]["Tables"]["notification_jobs"]["Row"];

/**
 * 0111: an admin recovers a lead escalation that stopped — by the job's
 * immutable id, with every rule in SQL (audit 2026-09-22, fifth brief).
 *
 * The desk alert (0101) has had a staff retry since it existed; the
 * escalation (0107) had none, and the worker deliberately closes several of
 * its outcomes "for a decision" that nobody could take. This file proves the
 * database half of that decision on a real stack:
 *
 *   - `claim_notification_jobs(... p_job_id)` hands out exactly the row it
 *     was asked for, so a lead that carries BOTH kinds never has the wrong
 *     one claimed by a staff action;
 *   - `request_lead_escalation_recovery(p_job_id, p_action, p_reason)`:
 *     admin, aal2, the caller's own org, this kind only; the lead still
 *     eligible, the policy on, somebody eligible to receive it; no live
 *     lease, not accepted, not merely queued; `retry` only while the key is
 *     safe to present again, `resend` only when it is not — one row never
 *     admits both, and nothing rotates a key on its own;
 *   - two simultaneous requests → one transition;
 *   - the event: the admin, the action, the previous state — ids and fixed
 *     words, never a person and never typed text (0115 dropped the reason) —
 *     under the org's chain lock.
 *
 * FIXTURES REACH THEIR STATE THROUGH THE REAL CLAIM AND COMPLETION (the 0104
 * lesson: a row that writes a clock by hand describes a shape the claim
 * never produces, and the CHECK refuses it). The escalation row itself is
 * inserted directly — the minting sweep is proven in lead-escalation.test.ts
 * and would need the policy ON for the live cron to see — and every lead is
 * fresh, so the five-minute cron never finds one due while the policy is on.
 */
const svc = serviceClient();
const run = Date.now().toString(36);
const REDACTED = "[erased at the contact's request]";
const made: string[] = [];

let adminA: TestUser;
let agentA1: TestUser;
let adminB: TestUser;
let agentB: TestUser;
let policyBefore: unknown;

const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const policyOn = (recipients: string[]) => ({
  enabled: true,
  after_minutes: 15,
  max_age_hours: 48,
  recipients,
  working_hours: null,
  timezone: "Asia/Nicosia",
});

async function setPolicy(value: unknown) {
  const { error } = await svc.from("cyprus_config").update({ value: value as never }).eq("key", "lead_escalation");
  if (error) throw new Error(`setPolicy: ${error.message}`);
}

async function submit(label: string, slug = "test-org-a") {
  const { data, error } = await svc.rpc("submit_public_enquiry", {
    p_org_slug: slug,
    p_name: `Recovery ${run} ${label}`,
    p_email: `recovery-${label}-${run}@example.invalid`,
    p_phone: "",
    p_message: `recovery probe ${run} ${label}`,
    p_property_ref: "",
    p_idempotency_key: `rec-${run}-${label}`,
  });
  if (error) throw new Error(`submit ${label}: ${error.message}`);
  const row = data![0]!;
  made.push(row.lead_id);
  return row.lead_id as string;
}

async function mintEscalation(leadId: string, org = ORG_A): Promise<Job> {
  const { data, error } = await svc
    .from("notification_jobs")
    .insert({ org_id: org, lead_id: leadId, kind: "lead_escalation" })
    .select("*")
    .single();
  if (error) throw new Error(`mintEscalation: ${error.message}`);
  return data as Job;
}

async function jobById(id: string): Promise<Job> {
  const { data, error } = await svc.from("notification_jobs").select("*").eq("id", id).single();
  if (error) throw new Error(`jobById: ${error.message}`);
  return data as Job;
}

async function jobOf(leadId: string, kind: "enquiry_desk_alert" | "lead_escalation"): Promise<Job> {
  const { data, error } = await svc.from("notification_jobs").select("*").eq("lead_id", leadId).eq("kind", kind).single();
  if (error) throw new Error(`jobOf ${kind}: ${error.message}`);
  return data as Job;
}

async function claim(worker: string, opts: { leadId?: string; jobId?: string; leaseSeconds?: number; limit?: number } = {}) {
  const { data, error } = await svc.rpc("claim_notification_jobs", {
    p_worker: worker,
    p_limit: opts.limit ?? 5,
    p_lease_seconds: opts.leaseSeconds ?? 90,
    ...(opts.leadId ? { p_lead_id: opts.leadId } : {}),
    ...(opts.jobId ? { p_job_id: opts.jobId } : {}),
  } as never);
  if (error) throw new Error(`claim ${worker}: ${error.message}`);
  return (data ?? []) as Job[];
}

async function complete(jobId: string, worker: string, outcome: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await svc.rpc("complete_notification_job", {
    p_job_id: jobId,
    p_worker: worker,
    p_outcome: outcome,
    ...extra,
  } as never);
  if (error) throw new Error(`complete ${outcome}: ${error.message}`);
  if (data !== true) throw new Error(`complete ${outcome}: refused (not the holder?)`);
}

/** The recovery, through a session. Returns the row or the refusal's words. */
async function recover(client: TestUser["client"], jobId: string, action: string, reason?: string) {
  const { data, error } = await client.rpc("request_lead_escalation_recovery", {
    p_job_id: jobId,
    p_action: action,
    ...(reason !== undefined ? { p_reason: reason } : {}),
  } as never);
  return { row: ((data ?? []) as Job[])[0] ?? null, error: error ? { code: error.code, message: error.message } : null };
}

/** An escalation attempted once for real (claim + a transient answer) and then terminal — through the budget, not by hand. */
async function failedAfterOneAttempt(label: string, result = "503") {
  const lead = await submit(label);
  const minted = await mintEscalation(lead);
  await svc.from("notification_jobs").update({ max_attempts: 1 }).eq("id", minted.id);
  const [claimed] = await claim(`w-${label}-${run}`, { jobId: minted.id });
  if (!claimed) throw new Error(`${label}: not claimed`);
  await complete(claimed.id, `w-${label}-${run}`, "retry", { p_category: "transient", p_result: result, p_retry_in_seconds: 0 });
  const job = await jobById(minted.id);
  if (job.state !== "failed") throw new Error(`${label}: expected failed after the last attempt, got ${job.state}`);
  return { lead, job };
}

/** A terminal outcome the worker writes itself (conflict, retry_beyond_window, a cancellation). */
async function closedBy(label: string, outcome: "failed" | "cancelled", extra: Record<string, unknown>) {
  const lead = await submit(label);
  const minted = await mintEscalation(lead);
  const [claimed] = await claim(`w-${label}-${run}`, { jobId: minted.id });
  if (!claimed) throw new Error(`${label}: not claimed`);
  await complete(claimed.id, `w-${label}-${run}`, outcome, extra);
  return { lead, job: await jobById(minted.id) };
}

/** "Advance the clock" by N hours: shift the timestamps the row carries; a null clock stays null. */
async function ageBy(jobId: string, hours: number) {
  const job = await jobById(jobId);
  const shift = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - hours * HOUR).toISOString() : null);
  const { error } = await svc
    .from("notification_jobs")
    .update({
      first_attempted_at: shift(job.first_attempted_at),
      last_attempted_at: shift(job.last_attempted_at),
      next_attempt_at: shift(job.next_attempt_at) ?? job.next_attempt_at,
    })
    .eq("id", jobId);
  if (error) throw new Error(`ageBy: ${error.message}`);
}

async function escalationEvents(leadId: string) {
  const { data, error } = await svc
    .from("events")
    .select("actor_id, payload")
    .eq("entity_type", "lead")
    .eq("entity_id", leadId)
    .eq("event_type", "lead_escalation")
    .order("id");
  if (error) throw new Error(`escalationEvents: ${error.message}`);
  return (data ?? []).map((e) => ({ actor_id: e.actor_id, payload: e.payload as Record<string, unknown> }));
}

const recoveries = async (leadId: string) => (await escalationEvents(leadId)).filter((e) => e.payload.outcome === "recovery_requested");

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  await ensureTestOrg(svc, ORG_B, "Test Org B", "test-org-b");
  [adminA, agentA1, adminB, agentB] = await Promise.all([
    createTestUser(svc, `recovery-admin-a-${run}@test.local`, "admin", ORG_A),
    createTestUser(svc, `recovery-agent-a1-${run}@test.local`, "agent", ORG_A),
    createTestUser(svc, `recovery-admin-b-${run}@test.local`, "admin", ORG_B),
    createTestUser(svc, `recovery-agent-b-${run}@test.local`, "agent", ORG_B),
  ]);
  const { data } = await svc.from("cyprus_config").select("value").eq("key", "lead_escalation").single();
  policyBefore = data!.value;
  // ON for the whole file, with the admin as the one recipient; every lead
  // here is fresh, so the live five-minute sweep has nothing to mint.
  await setPolicy(policyOn([adminA.id]));
});

afterAll(async () => {
  await setPolicy(policyBefore);
  if (!made.length) return;
  await svc.from("tasks").delete().in("lead_id", made);
  const { error } = await svc.from("leads").delete().in("id", made);
  if (error) console.warn(`cleanup: ${error.message}`);
});

describe("exact-job targeting in the claim", () => {
  it("a lead carries both kinds, and a claim by job id hands out only that row — the other is untouched", async () => {
    const lead = await submit("both");
    const desk = await jobOf(lead, "enquiry_desk_alert");
    const esc = await mintEscalation(lead);
    // both are due now; by lead alone the claim would order them by next_attempt_at
    const got = await claim(`by-id-${run}`, { jobId: esc.id });
    expect(got.map((j) => j.id)).toEqual([esc.id]);
    expect(got[0]!.kind).toBe("lead_escalation");
    const deskAfter = await jobOf(lead, "enquiry_desk_alert");
    expect(deskAfter, "the desk alert was not claimed, not counted, not touched").toMatchObject({
      state: "pending",
      attempts: 0,
      key_attempts: 0,
      claimed_by: null,
      updated_at: desk.updated_at,
    });
    // by lead AND job id: the pair must match — another lead's job id yields nothing
    const other = await submit("both-other");
    expect(await claim(`by-pair-${run}`, { leadId: other, jobId: desk.id })).toHaveLength(0);
    expect(await claim(`by-pair-2-${run}`, { leadId: lead, jobId: desk.id })).toHaveLength(1);
  });
});

describe("who may recover", () => {
  it("an agent is refused, another organisation cannot find the job, and an aal1 admin session is refused", async () => {
    const { job } = await failedAfterOneAttempt("who");
    const agent = await recover(agentA1.client, job.id, "retry");
    expect(agent.error?.message).toMatch(/admins only/i);
    const stranger = await recover(adminB.client, job.id, "retry");
    expect(stranger.error?.message, "another organisation's admin cannot even see the row").toMatch(/not found/i);
    // the same admin, signed in again without the second factor
    const aal1 = anonClient();
    const { error: signIn } = await aal1.auth.signInWithPassword({ email: adminA.email, password: TEST_PASSWORD });
    expect(signIn).toBeNull();
    const weak = await recover({ rpc: aal1.rpc.bind(aal1) } as never, job.id, "retry");
    expect(weak.error?.message).toMatch(/second factor/i);
    expect((await jobById(job.id)).state, "nothing moved").toBe("failed");
  });

  it("anon is refused at the grant; a desk-alert job is refused by kind; an unknown action is refused", async () => {
    const { lead, job } = await failedAfterOneAttempt("grants");
    const anon = await recover({ rpc: anonClient().rpc.bind(anonClient()) } as never, job.id, "retry");
    expect(anon.error, "anon cannot execute the function").not.toBeNull();
    const desk = await jobOf(lead, "enquiry_desk_alert");
    const wrongKind = await recover(adminA.client, desk.id, "retry");
    expect(wrongKind.error?.message).toMatch(/retry alert/i);
    const odd = await recover(adminA.client, job.id, "reset");
    expect(odd.error?.message).toMatch(/unknown action/i);
  });
});

describe("what may be recovered", () => {
  it("answered, closed and redacted leads are refused", async () => {
    const a = await failedAfterOneAttempt("answered");
    await svc.from("leads").update({ first_response_at: new Date().toISOString() }).eq("id", a.lead);
    expect((await recover(adminA.client, a.job.id, "retry")).error?.message).toMatch(/answered/i);

    const c = await failedAfterOneAttempt("closed");
    await svc.from("leads").update({ status: "lost", lost_reason: "test" }).eq("id", c.lead);
    expect((await recover(adminA.client, c.job.id, "retry")).error?.message).toMatch(/closed/i);

    const r = await failedAfterOneAttempt("redacted");
    await svc.from("leads").update({ message: REDACTED }).eq("id", r.lead);
    expect((await recover(adminA.client, r.job.id, "retry")).error?.message).toMatch(/redacted/i);
  });

  it("a switched-off policy and a policy naming nobody eligible are refused; the assignee never counts as a recipient", async () => {
    const { lead, job } = await failedAfterOneAttempt("policy");
    await setPolicy({ ...policyOn([adminA.id]), enabled: false });
    try {
      expect((await recover(adminA.client, job.id, "retry")).error?.message).toMatch(/switched off/i);
    } finally {
      await setPolicy(policyOn([adminA.id]));
    }
    await setPolicy(policyOn([agentB.id]));
    try {
      expect((await recover(adminA.client, job.id, "retry")).error?.message, "another org's agent is nobody here").toMatch(/nobody/i);
    } finally {
      await setPolicy(policyOn([adminA.id]));
    }
    await svc.from("leads").update({ assigned_agent_id: adminA.id }).eq("id", lead);
    try {
      expect((await recover(adminA.client, job.id, "retry")).error?.message, "the only recipient is the assignee").toMatch(/nobody/i);
    } finally {
      await svc.from("leads").update({ assigned_agent_id: null }).eq("id", lead);
    }
    expect((await jobById(job.id)).state).toBe("failed");
  });

  it("a live lease, an accepted escalation and a queued one are refused", async () => {
    const lead = await submit("busy");
    const minted = await mintEscalation(lead);
    const queued = await recover(adminA.client, minted.id, "retry");
    expect(queued.error?.message).toMatch(/queued|scheduled/i);
    const [held] = await claim(`hold-${run}`, { jobId: minted.id });
    expect(held).toBeDefined();
    const busy = await recover(adminA.client, minted.id, "retry");
    expect(busy.error?.message).toMatch(/being sent/i);
    await complete(minted.id, `hold-${run}`, "accepted", { p_provider_message_id: "re_ok" });
    const done = await recover(adminA.client, minted.id, "retry");
    expect(done.error?.message).toMatch(/already accepted/i);
    const doneResend = await recover(adminA.client, minted.id, "resend", "test");
    expect(doneResend.error?.message, "accepted is final either way").toMatch(/already accepted/i);
  });

  it("a claim whose lease has lapsed is recoverable — the row was stuck, not in flight", async () => {
    const lead = await submit("lapsed");
    const minted = await mintEscalation(lead);
    const [held] = await claim(`lapse-${run}`, { jobId: minted.id, leaseSeconds: 1 });
    expect(held).toBeDefined();
    await sleep(1500);
    const res = await recover(adminA.client, minted.id, "retry");
    expect(res.error).toBeNull();
    expect(res.row).toMatchObject({ state: "pending", attempts: 0, key_serial: 1, claimed_by: null });
  });
});

describe("retry keeps the key; resend is the only way to a new one", () => {
  it("a lost provider answer recovers under the same key and the same clock, budget reset, signed by the admin", async () => {
    const { lead, job } = await failedAfterOneAttempt("lost", "timeout");
    expect(job.first_attempted_at).not.toBeNull();
    const refused = await recover(adminA.client, job.id, "resend", "no need");
    expect(refused.error?.message, "resend is refused while the key is still safe").toMatch(/retry/i);

    const res = await recover(adminA.client, job.id, "retry");
    expect(res.error).toBeNull();
    expect(res.row).toMatchObject({
      state: "pending",
      attempts: 0,
      max_attempts: 1,
      key_serial: 1,
      key_attempts: 1,
      first_attempted_at: job.first_attempted_at,
      last_category: null,
      last_result: null,
      finished_at: null,
      claimed_by: null,
      claimed_until: null,
    });
    expect(new Date(res.row!.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const [ev] = await recoveries(lead);
    expect(ev, "the request is on the timeline").toBeDefined();
    expect(ev!.actor_id).toBe(adminA.id);
    expect(ev!.payload).toMatchObject({
      action: "retry",
      job_id: job.id,
      key_serial: 1,
      key_rotated: false,
      previous_state: "failed",
      previous_category: "transient",
      previous_result: "timeout",
    });
    expect(ev!.payload, "no typed text in the chain (0115)").not.toHaveProperty("reason");
    expect(JSON.stringify(ev!.payload), "ids and words only").not.toContain("example.invalid");
  });

  it("a conflict refuses retry and admits resend without asking for typed text: the key rotates, its clock and presentation count clear", async () => {
    const { lead, job } = await closedBy("conflict", "failed", { p_category: "conflict", p_result: "invalid_idempotent_request" });
    const retry = await recover(adminA.client, job.id, "retry");
    expect(retry.error?.message).toMatch(/resend/i);

    const res = await recover(adminA.client, job.id, "resend");
    expect(res.error).toBeNull();
    expect(res.row).toMatchObject({ state: "pending", attempts: 0, key_serial: 2, key_attempts: 0, first_attempted_at: null, last_category: null, last_result: null });
    const [ev] = await recoveries(lead);
    expect(ev!.payload).toMatchObject({
      action: "resend",
      key_serial: 2,
      key_rotated: true,
      previous_state: "failed",
      previous_category: "conflict",
      previous_result: "invalid_idempotent_request",
    });
    expect(ev!.payload, "no typed text in the chain (0115)").not.toHaveProperty("reason");
  });

  it("a key older than the window, and the two review words, refuse retry and need resend", async () => {
    const aged = await failedAfterOneAttempt("aged");
    await ageBy(aged.job.id, 21);
    expect((await recover(adminA.client, aged.job.id, "retry")).error?.message).toMatch(/resend/i);
    const ok = await recover(adminA.client, aged.job.id, "resend", "older than the provider remembers");
    expect(ok.error).toBeNull();
    expect(ok.row).toMatchObject({ key_serial: 2, first_attempted_at: null, key_attempts: 0 });

    // key_window_expired is the CLAIM's own closure of a stale row (0102)
    const stale = await submit("stale");
    const minted = await mintEscalation(stale);
    const [c] = await claim(`stale-${run}`, { jobId: minted.id });
    await complete(c!.id, `stale-${run}`, "retry", { p_category: "transient", p_result: "503", p_retry_in_seconds: 0 });
    await ageBy(minted.id, 21);
    expect(await claim(`stale-2-${run}`, { jobId: minted.id }), "closed, not handed out").toHaveLength(0);
    expect(await jobById(minted.id)).toMatchObject({ state: "failed", last_result: "key_window_expired" });
    expect((await recover(adminA.client, minted.id, "retry")).error?.message).toMatch(/resend/i);
    expect((await recover(adminA.client, minted.id, "resend", "decided")).error).toBeNull();

    const beyond = await closedBy("beyond", "failed", { p_category: "transient", p_result: "retry_beyond_window" });
    expect((await recover(adminA.client, beyond.job.id, "retry")).error?.message).toMatch(/resend/i);
    expect((await recover(adminA.client, beyond.job.id, "resend", "decided")).error).toBeNull();
  });

  it("a p_reason from a caller deployed before 0115 is accepted and written nowhere — not in the lead's events, not in the job row", async () => {
    const { lead, job } = await closedBy("typed", "failed", { p_category: "conflict", p_result: "invalid_idempotent_request" });
    // synthetic, shaped like what an admin might really type about a person
    const typed = "Called Zenobia Quillfeather-Test on +357 99 000 111, zq.test@example.invalid";
    const res = await recover(adminA.client, job.id, "resend", typed);
    expect(res.error).toBeNull();
    expect(res.row).toMatchObject({ state: "pending", key_serial: 2 });
    expect(await recoveries(lead)).toHaveLength(1);
    const { data: rows, error } = await svc.from("events").select("*").eq("entity_id", lead);
    expect(error).toBeNull();
    const everything = JSON.stringify(rows) + JSON.stringify(await jobById(job.id));
    for (const word of ["Zenobia", "Quillfeather", "000 111", "zq.test"]) {
      expect(everything, `"${word}" is nowhere in the lead's events or the job`).not.toContain(word);
    }
  });
});

describe("cancellations", () => {
  it("cancelled because the policy was off is recoverable once it is on; cancelled because the lead was answered is not", async () => {
    const off = await closedBy("cancel-off", "cancelled", { p_result: "escalation_disabled" });
    const res = await recover(adminA.client, off.job.id, "retry");
    expect(res.error).toBeNull();
    expect(res.row).toMatchObject({ state: "pending", attempts: 0, key_serial: 1 });
    const [ev] = await recoveries(off.lead);
    expect(ev!.payload).toMatchObject({ previous_state: "cancelled", previous_result: "escalation_disabled", previous_category: null });

    const nobody = await closedBy("cancel-nobody", "cancelled", { p_result: "no_recipient" });
    expect((await recover(adminA.client, nobody.job.id, "retry")).error).toBeNull();

    const answered = await closedBy("cancel-answered", "cancelled", { p_result: "lead_answered" });
    expect((await recover(adminA.client, answered.job.id, "retry")).error?.message).toMatch(/no longer|cannot be recovered/i);
    const redacted = await closedBy("cancel-redacted", "cancelled", { p_result: "lead_redacted" });
    expect((await recover(adminA.client, redacted.job.id, "resend", "x")).error?.message).toMatch(/no longer|cannot be recovered/i);
    expect((await jobById(answered.job.id)).state).toBe("cancelled");
  });
});

describe("one transition, and the other kind untouched", () => {
  it("two simultaneous requests produce one transition and one event", async () => {
    const { lead, job } = await failedAfterOneAttempt("race");
    const results = await Promise.all([
      recover(adminA.client, job.id, "retry"),
      recover(adminA.client, job.id, "retry"),
      recover(adminA.client, job.id, "retry"),
    ]);
    const wins = results.filter((r) => r.error === null);
    expect(wins, "exactly one request moved the row").toHaveLength(1);
    for (const r of results.filter((r) => r.error !== null)) {
      expect(r.error!.message).toMatch(/queued|scheduled|being sent/i);
    }
    expect(await recoveries(lead)).toHaveLength(1);
    expect((await jobById(job.id)).attempts).toBe(0);
  });

  it("recovering the escalation leaves the desk alert exactly as it was, and the desk-alert retry leaves the escalation alone", async () => {
    const { lead, job } = await failedAfterOneAttempt("other-kind");
    // the desk alert, failed too, through its own real path
    const desk = await jobOf(lead, "enquiry_desk_alert");
    await svc.from("notification_jobs").update({ max_attempts: 1 }).eq("id", desk.id);
    const [dc] = await claim(`desk-${run}`, { jobId: desk.id });
    await complete(dc!.id, `desk-${run}`, "retry", { p_category: "transient", p_result: "503", p_retry_in_seconds: 0 });
    const deskBefore = await jobById(desk.id);
    expect(deskBefore.state).toBe("failed");

    expect((await recover(adminA.client, job.id, "retry")).error).toBeNull();
    expect(await jobById(desk.id), "byte for byte the row it was").toEqual(deskBefore);

    const escBefore = await jobById(job.id);
    const { error } = await adminA.client.rpc("request_enquiry_alert_retry", { p_lead_id: lead });
    expect(error).toBeNull();
    expect(await jobById(job.id), "the desk-alert retry never reaches the escalation").toEqual(escBefore);
    expect((await jobById(desk.id)).state).toBe("pending");
  });

  it("the events chain still verifies after every recovery in this file", async () => {
    const { data } = await svc.rpc("verify_events_chain", { p_org: ORG_A, p_from_id: null as never });
    expect((data as Array<{ ok: boolean; reason: string | null }>)[0]).toMatchObject({ ok: true });
  });
});
