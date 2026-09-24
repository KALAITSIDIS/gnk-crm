import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { readLeadEscalation } from "@/lib/services/lead-escalation";
import { ORG_A, ORG_B, anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

type Job = Database["public"]["Tables"]["notification_jobs"]["Row"];

/**
 * 0107: the lead escalation's database half, on a real stack — the policy
 * reader (against the SAME table lib/services/lead-escalation.test.ts runs
 * against the TS mirror), the working-time clock across both daylight-saving
 * switches, the minting sweep's eligibility rule, that two concurrent sweeps
 * mint ONE row, tenant scoping, the kind-aware events, the redaction
 * trigger, and the grants.
 *
 * THE LIVE CRON RUNS HERE TOO. `lead-escalation` fires every five minutes on
 * the local stack and calls raise_lead_escalations() for every org, so while
 * this file has the policy switched ON the cron may mint a test lead's row
 * before the test's own call does. Every assertion therefore reads STATE (a
 * row exists, exactly one) rather than the return value of a particular
 * call, and the policy is ON for as short a stretch as the tests allow and
 * restored to its exact previous value at the end — whatever happens.
 */
const svc = serviceClient();
const run = Date.now().toString(36);
const REDACTED = "[erased at the contact's request]";
const madeLeads: string[] = [];

let adminA: TestUser;
let agentA1: TestUser;
let agentB: TestUser;
let policyBefore: unknown;

const HOURS = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
const onFlat = (recipients: string[]) => ({
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

async function submit(slug: string, label: string) {
  const { data, error } = await svc.rpc("submit_public_enquiry", {
    p_org_slug: slug,
    p_name: `Escalation ${run} ${label}`,
    p_email: `escalation-${label}-${run}@example.invalid`,
    p_phone: "",
    p_message: `escalation probe ${run} ${label}`,
    p_property_ref: "",
    p_idempotency_key: `esc-${run}-${label}`,
  });
  if (error) throw new Error(`submit ${label}: ${error.message}`);
  const row = data![0]!;
  madeLeads.push(row.lead_id);
  return row.lead_id as string;
}

async function age(leadId: string, minutes: number, patch: Record<string, unknown> = {}) {
  const { error } = await svc
    .from("leads")
    .update({ received_at: new Date(Date.now() - minutes * 60_000).toISOString(), ...patch } as never)
    .eq("id", leadId);
  if (error) throw new Error(`age: ${error.message}`);
}

/** The sweep, for one org — and, since 0110, as of a given instant (p_now), so a scenario is the same whatever day it runs. */
async function raise(org: string, now?: string) {
  const { data, error } = await svc.rpc("raise_lead_escalations", { p_org: org, ...(now ? { p_now: now } : {}) });
  if (error) throw new Error(`raise: ${error.message}`);
  return data as number;
}

async function receivedAt(leadId: string, iso: string) {
  const { error } = await svc.from("leads").update({ received_at: iso } as never).eq("id", leadId);
  if (error) throw new Error(`receivedAt: ${error.message}`);
}

async function escalationJobs(leadId: string): Promise<Job[]> {
  const { data, error } = await svc.from("notification_jobs").select("*").eq("lead_id", leadId).eq("kind", "lead_escalation");
  if (error) throw new Error(`escalationJobs: ${error.message}`);
  return (data ?? []) as Job[];
}

async function eventsOf(leadId: string, type: string) {
  const { data, error } = await svc
    .from("events")
    .select("actor_id, event_type, payload")
    .eq("entity_type", "lead")
    .eq("entity_id", leadId)
    .eq("event_type", type)
    .order("id");
  if (error) throw new Error(`eventsOf: ${error.message}`);
  return (data ?? []).map((e) => ({ actor_id: e.actor_id, payload: e.payload as Record<string, unknown> }));
}

async function dueAt(received: string, cfg: Record<string, unknown>) {
  const { data, error } = await svc.rpc("lead_escalation_due_at", { p_received: received, p_cfg: cfg as never });
  if (error) throw new Error(`dueAt: ${error.message}`);
  return new Date(data as string).toISOString();
}

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  await ensureTestOrg(svc, ORG_B, "Test Org B", "test-org-b");
  [adminA, agentA1, agentB] = await Promise.all([
    createTestUser(svc, `escalation-admin-a-${run}@test.local`, "admin", ORG_A),
    createTestUser(svc, `escalation-agent-a1-${run}@test.local`, "agent", ORG_A),
    createTestUser(svc, `escalation-agent-b-${run}@test.local`, "agent", ORG_B),
  ]);
  const { data } = await svc.from("cyprus_config").select("value").eq("key", "lead_escalation").single();
  policyBefore = data!.value;
});

afterAll(async () => {
  // the policy row EXACTLY as it was — whatever a failing test left behind
  await setPolicy(policyBefore);
  if (madeLeads.length) {
    await svc.from("tasks").delete().in("lead_id", madeLeads);
    await svc.from("leads").delete().in("id", madeLeads); // jobs cascade; events stay
  }
  for (const u of [adminA, agentA1, agentB]) {
    if (u) await svc.auth.admin.deleteUser(u.id).catch(() => undefined);
  }
});

describe("the policy reader, against the table the TS mirror is tested with", () => {
  const cases: Array<[string, Record<string, unknown> | null]> = [
    ["nonsense", { enabled: "yes", after_minutes: 0, max_age_hours: -1, recipients: ["nope", 7], working_hours: { days: [8], start: "25:00", end: "18:00" }, timezone: "Mars/Olympus" }],
    ["a valid policy", { enabled: true, after_minutes: 30, max_age_hours: 24, recipients: ["11111111-1111-1111-1111-111111111111", "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"], working_hours: { days: [5, 1, 1], start: "08:30", end: "17:00" }, timezone: "Europe/Athens" }],
    ["the bounds", { after_minutes: 1441, max_age_hours: 720, working_hours: { days: [1], start: "18:00", end: "09:00" } }],
    ["an empty object", {}],
  ];
  it.each(cases)("SQL and TypeScript agree on %s", async (_label, raw) => {
    const { data, error } = await svc.rpc("lead_escalation_config", { p_raw: raw as never });
    expect(error).toBeNull();
    expect(data).toEqual(readLeadEscalation(raw));
  });

  it("the seeded row is OFF, and reads the same both ways", async () => {
    const { data: row } = await svc.from("cyprus_config").select("value").eq("key", "lead_escalation").single();
    const { data: sql } = await svc.rpc("lead_escalation_config");
    expect(sql).toEqual(readLeadEscalation(row!.value));
    expect(readLeadEscalation(policyBefore).enabled, "nothing sends until an admin decides").toBe(false);
  });
});

describe("the working-time clock (Asia/Nicosia, wall-clock arithmetic)", () => {
  const cfg = { enabled: true, after_minutes: 15, working_hours: HOURS, timezone: "Asia/Nicosia" };

  it("inside the hours the wait is the wait", async () => {
    expect(await dueAt("2026-09-22T07:00:00Z", cfg)).toBe("2026-09-22T07:15:00.000Z");
  });
  it("Friday evening in winter time is due Monday 09:15 in SUMMER time — the 29 March switch moves the instant, not the local time", async () => {
    expect(await dueAt("2026-03-27T16:30:00Z", cfg)).toBe("2026-03-30T06:15:00.000Z");
  });
  it("Saturday night in summer time is due Monday 09:15 in WINTER time — the 25 October switch", async () => {
    expect(await dueAt("2026-10-24T19:00:00Z", cfg)).toBe("2026-10-26T07:15:00.000Z");
  });
  it("a wait that crosses closing carries its remainder to the next opening", async () => {
    // 17:50 local: ten minutes fit before 18:00, five carry to 09:05
    expect(await dueAt("2026-09-22T14:50:00Z", cfg)).toBe("2026-09-23T06:05:00.000Z");
  });
  it("before opening, the wait starts at opening", async () => {
    expect(await dueAt("2026-09-22T04:00:00Z", cfg)).toBe("2026-09-22T06:15:00.000Z");
  });
  it("around the clock, the wait is flat", async () => {
    expect(await dueAt("2026-09-26T19:00:00Z", { ...cfg, working_hours: null })).toBe("2026-09-26T19:15:00.000Z");
  });
  it("another zone: Europe/London the same Saturday night is due Monday 09:15 London time", async () => {
    // 2026-10-24 19:00Z is Saturday 20:00 BST; Monday 26 Oct is GMT → 09:15 local = 09:15Z
    expect(await dueAt("2026-10-24T19:00:00Z", { ...cfg, timezone: "Europe/London" })).toBe("2026-10-26T09:15:00.000Z");
  });
});

describe("the minting sweep", () => {
  let waiting: string;
  let answered: string;
  let closed: string;
  let redacted: string;
  let young: string;
  let stale: string;
  let inB: string;

  beforeAll(async () => {
    // SEQUENTIAL on purpose: events_partition_health() flags any two adjacent
    // ids whose occurred_at (transaction start) run backwards, and parallel
    // door calls do exactly that within a millisecond — the health rule's
    // sensitivity to concurrent writers, not a defect here. The concurrency
    // this file proves is the SWEEP's, below.
    waiting = await submit("test-org-a", "waiting");
    answered = await submit("test-org-a", "answered");
    closed = await submit("test-org-a", "closed");
    redacted = await submit("test-org-a", "redacted");
    young = await submit("test-org-a", "young");
    stale = await submit("test-org-a", "stale");
    inB = await submit("test-org-b", "in-b");
    await Promise.all([
      age(waiting, 20),
      age(answered, 20, { first_response_at: new Date().toISOString() }),
      age(closed, 20, { status: "lost", lost_reason: "test" }),
      age(redacted, 20),
      age(young, 5),
      age(stale, 49 * 60),
      age(inB, 20),
    ]);
    // redaction goes through the column the trigger watches
    await svc.from("leads").update({ message: REDACTED }).eq("id", redacted);
  });

  it("mints nothing while the policy is OFF, however overdue the leads", async () => {
    await setPolicy({ ...onFlat([adminA.id]), enabled: false });
    expect(await raise(ORG_A)).toBe(0);
    expect(await escalationJobs(waiting)).toHaveLength(0);
  });

  it("ON: exactly the eligible lead gets exactly one row and one scheduled event; answered, closed, redacted, too young and too old do not", async () => {
    await setPolicy(onFlat([adminA.id]));
    try {
      await raise(ORG_A);
      await raise(ORG_A); // a second pass changes nothing
      expect(await escalationJobs(waiting), "one row, by any number of sweeps").toHaveLength(1);
      for (const [label, id] of [["answered", answered], ["closed", closed], ["redacted", redacted], ["young", young], ["stale", stale]] as const) {
        expect(await escalationJobs(id), `${label} must not be escalated`).toHaveLength(0);
      }
      const scheduled = await eventsOf(waiting, "lead_escalation");
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]!.actor_id, "nobody signed in did this").toBeNull();
      expect(scheduled[0]!.payload).toMatchObject({ outcome: "scheduled", after_minutes: 15, working_hours: false, timezone: "Asia/Nicosia" });
      expect(JSON.stringify(scheduled[0]!.payload), "ids and numbers only").not.toContain("example.invalid");
    } finally {
      await setPolicy({ ...onFlat([adminA.id]), enabled: false });
    }
  });

  it("is scoped by p_org: org A's sweep never mints org B's lead; org B's does", async () => {
    await setPolicy(onFlat([agentB.id]));
    try {
      await raise(ORG_A);
      expect(await escalationJobs(inB), "org A's pass must not reach org B").toHaveLength(0);
      await raise(ORG_B);
      expect(await escalationJobs(inB)).toHaveLength(1);
    } finally {
      await setPolicy({ ...onFlat([adminA.id]), enabled: false });
    }
  });

  it("two concurrent sweeps mint ONE row per lead — the unique index decides, and each call logs only what it wrote", async () => {
    const c1 = await submit("test-org-a", "race-1");
    const c2 = await submit("test-org-a", "race-2");
    await Promise.all([age(c1, 20), age(c2, 20)]);
    await setPolicy(onFlat([adminA.id]));
    try {
      const counts = await Promise.all([raise(ORG_A), raise(ORG_A), raise(ORG_A)]);
      expect(counts.reduce((a, b) => a + b, 0), "at most the two new leads, across every concurrent pass").toBeLessThanOrEqual(2);
      expect(await escalationJobs(c1)).toHaveLength(1);
      expect(await escalationJobs(c2)).toHaveLength(1);
      expect(await eventsOf(c1, "lead_escalation")).toHaveLength(1);
      expect(await eventsOf(c2, "lead_escalation")).toHaveLength(1);
      // 0108: six parallel door calls and three parallel sweeps wrote events
      // for one organisation at the same instant; the chain must still verify.
      // Before the per-organisation lock this forked it (measured 2026-09-22).
      const { data: chain } = await svc.rpc("verify_events_chain", { p_org: ORG_A, p_from_id: null as never });
      expect((chain as Array<{ ok: boolean; reason: string | null }>)[0], "the hash chain survives concurrent writers").toMatchObject({ ok: true });
    } finally {
      await setPolicy({ ...onFlat([adminA.id]), enabled: false });
    }
  });

  it("the minted row is a normal outbox row: claimed like any other, completed under its own event type, never closed by the desk-alert legacy rule", async () => {
    const [job] = await escalationJobs(waiting);
    expect(job).toBeDefined();
    expect(job!.state).toBe("pending");
    // an old-style "sent" event on the lead closes the DESK ALERT (0102 D) and must not touch the escalation
    await svc.from("events").insert({
      org_id: ORG_A,
      actor_id: null,
      entity_type: "lead",
      entity_id: waiting,
      event_type: "enquiry_alert",
      payload: { outcome: "sent", test: run },
    });
    const { data: claimed, error } = await svc.rpc("claim_notification_jobs", { p_worker: `esc-${run}`, p_limit: 5, p_lease_seconds: 60, p_lead_id: waiting });
    expect(error).toBeNull();
    const mine = ((claimed ?? []) as Job[]).find((j) => j.kind === "lead_escalation");
    expect(mine, "the escalation row is handed out").toBeDefined();
    expect(mine!.claimed_by).toBe(`esc-${run}`);
    const { data: desk } = await svc.from("notification_jobs").select("state, last_result").eq("lead_id", waiting).eq("kind", "enquiry_desk_alert").single();
    expect(desk, "the desk alert IS closed by the legacy rule, as before").toMatchObject({ state: "accepted", last_result: "legacy_sender" });

    // the worker found the lead answered in the meantime: cancelled, under lead_escalation
    const { data: done } = await svc.rpc("complete_notification_job", {
      p_job_id: mine!.id,
      p_worker: `esc-${run}`,
      p_outcome: "cancelled",
      p_result: "lead_answered",
    });
    expect(done).toBe(true);
    const cancelled = (await eventsOf(waiting, "lead_escalation")).filter((e) => e.payload.outcome === "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.payload).toMatchObject({ result: "lead_answered", job_id: mine!.id });
    const misfiled = (await eventsOf(waiting, "enquiry_alert")).filter((e) => e.payload.result === "lead_answered");
    expect(misfiled, "an escalation outcome is never filed as a desk alert").toHaveLength(0);
  });

  it("erasure cancels a pending escalation with a lead_escalation event", async () => {
    const [job] = await escalationJobs(inB);
    expect(job?.state).toBe("pending");
    await svc.from("leads").update({ message: REDACTED }).eq("id", inB);
    const [after] = await escalationJobs(inB);
    expect(after).toMatchObject({ state: "cancelled", last_result: "lead_redacted" });
    const ev = (await eventsOf(inB, "lead_escalation")).filter((e) => e.payload.outcome === "cancelled");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ result: "lead_redacted" });
  });

  it("a third kind is refused by the CHECK, a second escalation row by the unique index", async () => {
    const dup = await svc.from("notification_jobs").insert({ org_id: ORG_A, lead_id: waiting, kind: "lead_escalation" });
    expect(dup.error?.code, "unique_violation").toBe("23505");
    const odd = await svc.from("notification_jobs").insert({ org_id: ORG_A, lead_id: waiting, kind: "something_else" });
    expect(odd.error?.code, "check_violation").toBe("23514");
  });
});

/**
 * THE AGE CUTOFF COUNTS FROM WHEN THE WAIT ENDED, NOT FROM ARRIVAL (audit
 * 2026-09-22, second brief, finding 3). 0107 required `received_at` within
 * max_age_hours AND the working-time due time passed. With the seeded
 * Mon–Fri 09:00–18:00 hours, a Friday 22:00 enquiry is due Monday 09:15 —
 * and at Monday 09:20 it is 59 hours old, so the sweep skipped it: the
 * guard against e-mailing a stale backlog at activation was cutting off
 * exactly the enquiries that had waited legitimately through the closed
 * days. Since 0110 the guard asks how long ago the wait ENDED (`due_at`
 * within max_age_hours), which is the same question for a lead received in
 * working hours and the right one for a lead received outside them.
 *
 * The sweep takes `p_now` so the brief's example runs on its own dates
 * whatever day the suite runs: Friday 25 September 22:00 Asia/Nicosia
 * (19:00Z), swept Monday 28 September 09:20 (06:20Z) — in 2099, which has
 * 2026's calendar. They were in 2026 until the 2026-09-24 clock sweep: the
 * live cron (the file header) could have minted one of these leads inside an
 * ON stretch from 28 September 2026. The last test keeps them out of reach.
 */
describe("the age cutoff counts from the end of the wait, not from arrival (finding 3, 2026-09-22)", () => {
  const MONDAY_0920 = "2099-09-28T06:20:00Z";
  let friday: string;
  let monday: string;
  let backlog: string;
  /** every lead this block dates by hand — the last test checks them all */
  const dated: string[] = [];
  const hoursPolicy = () => ({ ...onFlat([adminA.id]), working_hours: HOURS });

  beforeAll(async () => {
    friday = await submit("test-org-a", "friday-night");
    monday = await submit("test-org-a", "monday-control");
    backlog = await submit("test-org-a", "backlog");
    dated.push(friday, monday, backlog);
    await receivedAt(friday, "2099-09-25T19:00:00Z"); // Friday 22:00 local → due Monday 09:15 local (06:15Z)
    await receivedAt(monday, "2099-09-28T06:00:00Z"); // Monday 09:00 local → due 09:15 local (06:15Z)
    await receivedAt(backlog, "2099-09-01T07:00:00Z"); // Tuesday 1 September 10:00 local → due 10:15; weeks before the sweep
  });

  it("the due time itself is unchanged: Friday 22:00 Nicosia is due Monday 09:15", async () => {
    expect(await dueAt("2099-09-25T19:00:00Z", hoursPolicy())).toBe("2099-09-28T06:15:00.000Z");
  });

  it("a Friday-night enquiry, 59 hours old and five minutes overdue on Monday morning, receives its one escalation; the Monday control does too; the weeks-old backlog does not", async () => {
    await setPolicy(hoursPolicy());
    try {
      await raise(ORG_A, MONDAY_0920);
      expect(await escalationJobs(friday), "waited through the weekend: eligible after the next opening").toHaveLength(1);
      expect(await escalationJobs(monday), "received in working hours: eligible as before").toHaveLength(1);
      expect(await escalationJobs(backlog), "its wait ended weeks ago: the activation guard leaves it to its task").toHaveLength(0);
      // a second sweep at the same instant changes nothing
      await raise(ORG_A, MONDAY_0920);
      expect(await escalationJobs(friday)).toHaveLength(1);
      expect(await escalationJobs(monday)).toHaveLength(1);
      expect(await escalationJobs(backlog)).toHaveLength(0);
    } finally {
      await setPolicy({ ...onFlat([adminA.id]), enabled: false });
    }
  });

  it("the guard still bites when the wait ended more than max_age_hours ago: the same Friday enquiry swept on Thursday is left alone", async () => {
    const thursday = await submit("test-org-a", "friday-night-swept-thursday");
    dated.push(thursday);
    await receivedAt(thursday, "2099-09-25T19:00:00Z");
    await setPolicy(hoursPolicy());
    try {
      // due Monday 06:15Z; Thursday 1 October 06:20Z is 72 hours after that
      await raise(ORG_A, "2099-10-01T06:20:00Z");
      expect(await escalationJobs(thursday)).toHaveLength(0);
    } finally {
      await setPolicy({ ...onFlat([adminA.id]), enabled: false });
    }
  });

  it("a lead not yet due at the sweep's instant is untouched, however it is dated", async () => {
    const early = await submit("test-org-a", "friday-night-swept-sunday");
    dated.push(early);
    await receivedAt(early, "2099-09-25T19:00:00Z");
    await setPolicy(hoursPolicy());
    try {
      await raise(ORG_A, "2099-09-27T12:00:00Z"); // Sunday noon: nothing has opened yet
      expect(await escalationJobs(early)).toHaveLength(0);
    } finally {
      await setPolicy({ ...onFlat([adminA.id]), enabled: false });
    }
  });

  // The policy is global and the live cron sweeps every org on the REAL clock
  // (see the file header). A hand-dated lead within the cron's reach can be
  // minted inside one of the ON stretches above and break a "0 rows" check —
  // the 2026 dates this block used to carry would have from 28 September 2026
  // (the 2026-09-24 clock sweep). A lead received after 2098 is never due to
  // the live cron, whatever day the suite runs.
  it("every lead this block dates is beyond the live cron's reach", async () => {
    const { data, error } = await svc.from("leads").select("received_at").in("id", dated);
    expect(error).toBeNull();
    expect(data, "each dated lead is read back").toHaveLength(dated.length);
    const reachable = (data ?? []).map((l) => l.received_at).filter((at) => Date.parse(at) < Date.UTC(2098, 0, 1));
    expect(reachable, "dated within the live cron's reach").toEqual([]);
  });
});

describe("grants", () => {
  it("anon and a signed-in member are refused all three functions; service_role is not", async () => {
    const anon = anonClient();
    for (const [fn, args] of [
      ["lead_escalation_config", {}],
      ["lead_escalation_due_at", { p_received: "2026-09-22T07:00:00Z" }],
      ["raise_lead_escalations", {}],
    ] as const) {
      const a = await anon.rpc(fn, args as never);
      expect(a.error?.code, `anon ${fn}`).toBe("42501");
      const u = await agentA1.client.rpc(fn, args as never);
      expect(u.error?.code, `authenticated ${fn}`).toBe("42501");
    }
    const s = await svc.rpc("lead_escalation_config");
    expect(s.error).toBeNull();
  });
});
