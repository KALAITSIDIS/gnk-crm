import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import {
  ORG_A,
  ORG_B,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

type Job = Database["public"]["Tables"]["notification_jobs"]["Row"];

/**
 * 0101: the desk alert is a ROW before it is an e-mail.
 *
 * Until 0101 the only record that the desk had been told about a website
 * enquiry was an `enquiry_alert` event written by the route's `after()`
 * callback — which is to say, after the visitor already had their 202, inside
 * the same function invocation, with nothing anywhere if that invocation was
 * killed, timed out, or the provider answered 503. A saved lead, and a desk
 * that was never told.
 *
 * `submit_public_enquiry` now writes a `notification_jobs` row in the SAME
 * transaction as the lead. The route's `after()` is only an accelerator that
 * claims and sends that row; a worker sweep does the same for whatever the
 * accelerator never reached. This file proves the database half on a real
 * stack: the transaction, the uniqueness, the atomic claim, the lease, the
 * terminal states, the staff retry with its permission checks, tenant
 * isolation, and the redaction trigger. The migration's own self-test proves
 * the one thing a client cannot — that a job insert which FAILS rolls the
 * lead back with it.
 */
const svc = serviceClient();
const run = Date.now().toString(36);
const made: string[] = [];

let adminA: TestUser;
let agentA1: TestUser;
let agentA2: TestUser;
let agentB: TestUser;

const REDACTED = "[erased at the contact's request]";

const args = (label: string) => ({
  p_org_slug: "test-org-a",
  p_name: `Outbox ${run} ${label}`,
  p_email: `outbox-${label}-${run}@example.invalid`,
  p_phone: "",
  p_message: `outbox probe ${run} ${label}`,
  p_property_ref: "",
});

async function submit(label: string, key?: string) {
  const { data, error } = await svc.rpc("submit_public_enquiry", {
    ...args(label),
    p_idempotency_key: key ?? `ob-${run}-${label}`,
  });
  if (error) throw new Error(`submit ${label}: ${error.message}`);
  const row = data![0]!;
  if (!made.includes(row.lead_id)) made.push(row.lead_id);
  return row;
}

async function jobFor(leadId: string) {
  const { data, error } = await svc
    .from("notification_jobs")
    .select("*")
    .eq("lead_id", leadId)
    .eq("kind", "enquiry_desk_alert")
    .maybeSingle();
  if (error) throw new Error(`jobFor: ${error.message}`);
  return data;
}

async function alertEvents(leadId: string) {
  const { data, error } = await svc
    .from("events")
    .select("actor_id, payload")
    .eq("entity_type", "lead")
    .eq("entity_id", leadId)
    .eq("event_type", "enquiry_alert")
    .order("id");
  if (error) throw new Error(`alertEvents: ${error.message}`);
  return (data ?? []).map((e) => ({
    actor_id: e.actor_id,
    payload: e.payload as Record<string, unknown>,
  }));
}

async function claim(worker: string, limit: number, leaseSeconds = 90, leadId?: string) {
  const { data, error } = await svc.rpc("claim_notification_jobs", {
    p_worker: worker,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
    ...(leadId ? { p_lead_id: leadId } : {}),
  });
  if (error) throw new Error(`claim ${worker}: ${error.message}`);
  return (data ?? []) as Job[];
}

async function complete(
  jobId: string,
  worker: string,
  outcome: "accepted" | "retry" | "failed" | "cancelled",
  extra: {
    category?: "transient" | "permanent" | "timeout" | "conflict";
    result?: string;
    providerMessageId?: string;
    retryInSeconds?: number;
  } = {},
) {
  const { data, error } = await svc.rpc("complete_notification_job", {
    p_job_id: jobId,
    p_worker: worker,
    p_outcome: outcome,
    p_category: extra.category ?? undefined,
    p_result: extra.result ?? undefined,
    p_provider_message_id: extra.providerMessageId ?? undefined,
    p_retry_in_seconds: extra.retryInSeconds ?? undefined,
  });
  if (error) throw new Error(`complete ${jobId}: ${error.message}`);
  return data as boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  await ensureTestOrg(svc, ORG_B, "Test Org B", "test-org-b");
  [adminA, agentA1, agentA2, agentB] = await Promise.all([
    createTestUser(svc, `outbox-admin-a-${run}@test.local`, "admin", ORG_A),
    createTestUser(svc, `outbox-agent-a1-${run}@test.local`, "agent", ORG_A),
    createTestUser(svc, `outbox-agent-a2-${run}@test.local`, "agent", ORG_A),
    createTestUser(svc, `outbox-agent-b-${run}@test.local`, "agent", ORG_B),
  ]);
});

afterAll(async () => {
  if (!made.length) return;
  // tasks first: the lead SLA sweep (0098) can attach one between calls
  await svc.from("tasks").delete().in("lead_id", made);
  const { error } = await svc.from("leads").delete().in("id", made);
  if (error) throw new Error(`cleanup: ${error.message}`);
});

describe("the door writes the alert job with the lead", () => {
  it("a new enquiry is one lead and one pending job", async () => {
    const row = await submit("new");
    expect(row.replayed).toBe(false);
    const job = await jobFor(row.lead_id);
    expect(job, "the job exists the moment the lead does").not.toBeNull();
    expect(job!.org_id).toBe(ORG_A);
    expect(job!.state).toBe("pending");
    expect(job!.attempts).toBe(0);
    expect(job!.key_serial).toBe(1);
    expect(job!.claimed_by).toBeNull();
    expect(new Date(job!.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("a replay is still one lead and one job", async () => {
    const first = await submit("replay", `ob-${run}-replay-key`);
    const again = await submit("replay", `ob-${run}-replay-key`);
    expect(again.replayed).toBe(true);
    expect(again.lead_id).toBe(first.lead_id);
    const { count } = await svc
      .from("notification_jobs")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", first.lead_id);
    expect(count, "one job for one enquiry, however many times it is posted").toBe(1);
  });

  it("a second job of the same kind for the same lead is refused by the database itself", async () => {
    const row = await submit("unique");
    const { error } = await svc
      .from("notification_jobs")
      .insert({ org_id: ORG_A, lead_id: row.lead_id, kind: "enquiry_desk_alert" });
    expect(error?.code, "unique (lead_id, kind)").toBe("23505");
  });

  it("a job cannot name a lead of another organisation", async () => {
    const row = await submit("tenant");
    // clear the door's own job first, so the unique index is not what answers
    await svc.from("notification_jobs").delete().eq("lead_id", row.lead_id);
    const { error } = await svc
      .from("notification_jobs")
      .insert({ org_id: ORG_B, lead_id: row.lead_id, kind: "enquiry_desk_alert" });
    expect(error?.code, "the composite foreign key refuses it").toBe("23503");
  });

  it("deleting the lead takes its job with it", async () => {
    const row = await submit("cascade");
    expect(await jobFor(row.lead_id)).not.toBeNull();
    const { error } = await svc.from("leads").delete().eq("id", row.lead_id);
    expect(error).toBeNull();
    made.splice(made.indexOf(row.lead_id), 1);
    expect(await jobFor(row.lead_id)).toBeNull();
  });
});

describe("tenant isolation and staff privileges on the job table", () => {
  it("members of the org read their jobs; another org sees none", async () => {
    const row = await submit("rls");
    const mine = await adminA.client.from("notification_jobs").select("id, state").eq("lead_id", row.lead_id);
    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(1);
    const agent = await agentA1.client.from("notification_jobs").select("id").eq("lead_id", row.lead_id);
    expect(agent.data, "an agent reads the status too — the inbox shows it").toHaveLength(1);
    const theirs = await agentB.client.from("notification_jobs").select("id").eq("lead_id", row.lead_id);
    expect(theirs.error).toBeNull();
    expect(theirs.data).toHaveLength(0);
  });

  it("no signed-in user may insert, update or delete a job — the functions are the only writers", async () => {
    const row = await submit("privs");
    const ins = await adminA.client
      .from("notification_jobs")
      .insert({ org_id: ORG_A, lead_id: row.lead_id, kind: "enquiry_desk_alert" });
    expect(ins.error?.code, "no INSERT privilege").toBe("42501");
    const upd = await adminA.client
      .from("notification_jobs")
      .update({ state: "accepted" })
      .eq("lead_id", row.lead_id);
    expect(upd.error?.code, "no UPDATE privilege").toBe("42501");
    const del = await adminA.client.from("notification_jobs").delete().eq("lead_id", row.lead_id);
    expect(del.error?.code, "no DELETE privilege").toBe("42501");
    expect((await jobFor(row.lead_id))!.state).toBe("pending");
  });

  it("the worker functions are service_role-only", async () => {
    const asUser = await adminA.client.rpc("claim_notification_jobs", { p_worker: "user", p_limit: 1 });
    expect(asUser.error?.code, "claim is not for a browser session").toBe("42501");
    const done = await adminA.client.rpc("complete_notification_job", {
      p_job_id: "00000000-0000-0000-0000-000000000000",
      p_worker: "user",
      p_outcome: "accepted",
    });
    expect(done.error?.code).toBe("42501");
  });

  it("the table stays inside the require_aal2 invariant", async () => {
    const { data, error } = await svc.rpc("rls_aal2_coverage");
    expect(error).toBeNull();
    expect(data, "no RLS-enabled table without require_aal2").toEqual([]);
  });
});

describe("claiming is atomic, leased and recoverable", () => {
  it("two workers claiming at once never receive the same job", async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) await submit(`conc${n}`);
    const [a, b] = await Promise.all([claim(`w1-${run}`, 3), claim(`w2-${run}`, 3)]);
    const idsA = new Set(a.map((j) => j.id));
    const overlap = b.filter((j) => idsA.has(j.id));
    expect(overlap, "for update skip locked: disjoint sets").toHaveLength(0);
    for (const j of [...a, ...b]) {
      expect(j.state).toBe("sending");
      expect(j.attempts).toBeGreaterThanOrEqual(1);
      expect(j.claimed_by).toMatch(/^w[12]-/);
      expect(new Date(j.claimed_until!).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("a job under a live lease is not handed out again", async () => {
    const row = await submit("lease-live");
    const first = await claim(`w1-${run}`, 1, 90, row.lead_id);
    expect(first).toHaveLength(1);
    const second = await claim(`w2-${run}`, 1, 90, row.lead_id);
    expect(second, "still leased to w1").toHaveLength(0);
  });

  it("an interrupted worker's expired lease is recovered by the next claim, and the attempt counts", async () => {
    const row = await submit("lease-expired");
    const first = await claim(`w1-${run}`, 1, 1, row.lead_id);
    expect(first[0]!.attempts).toBe(1);
    await sleep(1500);
    const second = await claim(`w2-${run}`, 1, 90, row.lead_id);
    expect(second, "the lease lapsed, so the job is free again").toHaveLength(1);
    expect(second[0]!.claimed_by).toBe(`w2-${run}`);
    expect(second[0]!.attempts, "the interrupted attempt still counts, so a crash loop is bounded").toBe(2);
    expect(second[0]!.first_attempted_at).toBe(first[0]!.first_attempted_at);
  });

  it("an expired lease with no attempts left is terminal, with an event, not immortal", async () => {
    const row = await submit("lease-exhausted");
    const { error } = await svc
      .from("notification_jobs")
      .update({ max_attempts: 1 })
      .eq("lead_id", row.lead_id);
    expect(error).toBeNull();
    const first = await claim(`w1-${run}`, 1, 1, row.lead_id);
    expect(first).toHaveLength(1);
    await sleep(1500);
    const second = await claim(`w2-${run}`, 1, 90, row.lead_id);
    expect(second, "nothing to hand out").toHaveLength(0);
    const job = await jobFor(row.lead_id);
    expect(job!.state).toBe("failed");
    expect(job!.last_result).toBe("lease_expired");
    expect(job!.claimed_by).toBeNull();
    const events = await alertEvents(row.lead_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ outcome: "failed", result: "lease_expired", job_id: job!.id });
  });
});

describe("completing a job", () => {
  it("only the holder of the claim may complete it; acceptance records the provider id and one event", async () => {
    const row = await submit("accept");
    const [job] = await claim(`w1-${run}`, 1, 90, row.lead_id);
    expect(await complete(job!.id, `w2-${run}`, "accepted", { providerMessageId: "msg-x" })).toBe(false);
    expect((await jobFor(row.lead_id))!.state, "a stranger's completion changed nothing").toBe("sending");
    expect(await complete(job!.id, `w1-${run}`, "accepted", { providerMessageId: "re_123", result: "200" })).toBe(
      true,
    );
    const done = await jobFor(row.lead_id);
    expect(done!.state).toBe("accepted");
    expect(done!.provider_message_id).toBe("re_123");
    expect(done!.accepted_at).not.toBeNull();
    expect(done!.finished_at).not.toBeNull();
    expect(done!.claimed_by).toBeNull();
    expect(done!.claimed_until).toBeNull();
    const events = await alertEvents(row.lead_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.actor_id).toBeNull();
    expect(events[0]!.payload).toMatchObject({
      outcome: "accepted",
      provider: "resend",
      job_id: job!.id,
      attempt: 1,
      provider_message_id: "re_123",
    });
    expect(JSON.stringify(events[0]!.payload)).not.toContain("example.invalid");
    // and it cannot be completed twice
    expect(await complete(job!.id, `w1-${run}`, "accepted")).toBe(false);
  });

  it("a transient failure backs off for the time the worker asks, without an event", async () => {
    const row = await submit("retry");
    const [job] = await claim(`w1-${run}`, 1, 90, row.lead_id);
    const before = Date.now();
    expect(
      await complete(job!.id, `w1-${run}`, "retry", { category: "transient", result: "503", retryInSeconds: 300 }),
    ).toBe(true);
    const again = await jobFor(row.lead_id);
    expect(again!.state).toBe("pending");
    expect(again!.attempts).toBe(1);
    expect(again!.last_category).toBe("transient");
    expect(again!.last_result).toBe("503");
    expect(again!.claimed_by).toBeNull();
    expect(new Date(again!.next_attempt_at).getTime()).toBeGreaterThan(before + 290_000);
    expect(await claim(`w2-${run}`, 1, 90, row.lead_id), "not due yet").toHaveLength(0);
    expect(await alertEvents(row.lead_id), "an intermediate retry is state, not history").toHaveLength(0);
  });

  it("after the last allowed attempt a transient failure is terminal and evented as exhausted", async () => {
    const row = await submit("exhaust");
    await svc.from("notification_jobs").update({ max_attempts: 2 }).eq("lead_id", row.lead_id);
    const [j1] = await claim(`w1-${run}`, 1, 90, row.lead_id);
    await complete(j1!.id, `w1-${run}`, "retry", { category: "transient", result: "503", retryInSeconds: 1 });
    await sleep(1200);
    const [j2] = await claim(`w1-${run}`, 1, 90, row.lead_id);
    expect(j2!.attempts).toBe(2);
    expect(await complete(j2!.id, `w1-${run}`, "retry", { category: "transient", result: "429", retryInSeconds: 60 })).toBe(
      true,
    );
    const done = await jobFor(row.lead_id);
    expect(done!.state).toBe("failed");
    expect(done!.last_result).toBe("429");
    expect(done!.finished_at).not.toBeNull();
    const events = await alertEvents(row.lead_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ outcome: "failed", exhausted: true, attempt: 2, result: "429" });
  });

  it("a permanent failure is terminal at once", async () => {
    const row = await submit("permanent");
    const [job] = await claim(`w1-${run}`, 1, 90, row.lead_id);
    expect(await complete(job!.id, `w1-${run}`, "failed", { category: "permanent", result: "validation_error" })).toBe(
      true,
    );
    const done = await jobFor(row.lead_id);
    expect(done!.state).toBe("failed");
    expect(done!.attempts).toBe(1);
    expect(done!.last_category).toBe("permanent");
    const events = await alertEvents(row.lead_id);
    expect(events[0]!.payload).toMatchObject({ outcome: "failed", exhausted: false, category: "permanent" });
  });

  it("an outcome the function does not know is an error, not a silent state", async () => {
    const row = await submit("badoutcome");
    const [job] = await claim(`w1-${run}`, 1, 90, row.lead_id);
    const { error } = await svc.rpc("complete_notification_job", {
      p_job_id: job!.id,
      p_worker: `w1-${run}`,
      p_outcome: "delivered",
    });
    expect(error?.message).toMatch(/outcome/i);
  });
});

describe("the staff retry", () => {
  const fail = async (leadId: string) => {
    const { error } = await svc
      .from("notification_jobs")
      .update({
        state: "failed",
        attempts: 8,
        last_category: "transient",
        last_result: "503",
        first_attempted_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      })
      .eq("lead_id", leadId);
    if (error) throw new Error(error.message);
  };

  it("another organisation cannot even see that there is a job to retry", async () => {
    const row = await submit("retry-crossorg");
    await fail(row.lead_id);
    const res = await agentB.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(res.error?.message).toMatch(/not found/i);
    expect((await jobFor(row.lead_id))!.state).toBe("failed");
  });

  it("an agent may not retry the alert of a lead assigned to someone else; the assignee and an admin may", async () => {
    const row = await submit("retry-perms");
    await fail(row.lead_id);
    await svc.from("leads").update({ assigned_agent_id: agentA1.id }).eq("id", row.lead_id);

    const other = await agentA2.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(other.error?.message).toMatch(/assigned to another/i);
    expect((await jobFor(row.lead_id))!.state).toBe("failed");

    const mine = await agentA1.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(mine.error).toBeNull();
    const job = await jobFor(row.lead_id);
    expect(job!.state).toBe("pending");
    expect(job!.attempts).toBe(0);
    expect(job!.key_serial, "first attempt under a day ago and no conflict: the same key is safe").toBe(1);
    expect(job!.last_result).toBeNull();
    expect(new Date(job!.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const events = await alertEvents(row.lead_id);
    const req = events.find((e) => e.payload.outcome === "retry_requested");
    expect(req, "the request is on the timeline").toBeDefined();
    expect(req!.actor_id, "signed by the person who asked").toBe(agentA1.id);
    expect(req!.payload).toMatchObject({ job_id: job!.id, key_serial: 1, previous_state: "failed" });

    await fail(row.lead_id);
    const admin = await adminA.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(admin.error).toBeNull();
    expect((await jobFor(row.lead_id))!.state).toBe("pending");
  });

  it("refuses while a worker holds a live claim, and refuses an alert that was already accepted", async () => {
    const row = await submit("retry-busy");
    const [job] = await claim(`w1-${run}`, 1, 90, row.lead_id);
    const busy = await adminA.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(busy.error?.message).toMatch(/being sent/i);
    await complete(job!.id, `w1-${run}`, "accepted", { providerMessageId: "re_ok" });
    const done = await adminA.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(done.error?.message).toMatch(/already/i);
  });

  it("rotates the idempotency key when the provider would no longer remember it, or after a payload conflict", async () => {
    const row = await submit("retry-key");
    await fail(row.lead_id);
    await svc
      .from("notification_jobs")
      .update({ first_attempted_at: new Date(Date.now() - 25 * 3_600_000).toISOString() })
      .eq("lead_id", row.lead_id);
    const old = await adminA.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(old.error).toBeNull();
    expect((await jobFor(row.lead_id))!.key_serial, "older than the 24h window: a fresh key").toBe(2);

    await fail(row.lead_id);
    await svc.from("notification_jobs").update({ last_category: "conflict" }).eq("lead_id", row.lead_id);
    const conflict = await adminA.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(conflict.error).toBeNull();
    expect((await jobFor(row.lead_id))!.key_serial, "a conflict means the old key is burnt").toBe(3);
  });

  it("refuses to resend a redacted enquiry — there is nothing left to say", async () => {
    const row = await submit("retry-redacted");
    await fail(row.lead_id);
    await svc.from("leads").update({ message: REDACTED }).eq("id", row.lead_id);
    const res = await adminA.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(res.error?.message).toMatch(/redacted/i);
  });
});

describe("erasure cancels queued work", () => {
  it("redacting a lead cancels its pending job with an event, and leaves an accepted one alone", async () => {
    const pending = await submit("redact-pending");
    const { error } = await svc.from("leads").update({ message: REDACTED }).eq("id", pending.lead_id);
    expect(error).toBeNull();
    const job = await jobFor(pending.lead_id);
    expect(job!.state).toBe("cancelled");
    expect(job!.last_result).toBe("lead_redacted");
    expect(job!.finished_at).not.toBeNull();
    const events = await alertEvents(pending.lead_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ outcome: "cancelled", result: "lead_redacted" });
    expect(JSON.stringify(events[0]!.payload)).not.toContain(REDACTED);

    const sent = await submit("redact-sent");
    const [j] = await claim(`w1-${run}`, 1, 90, sent.lead_id);
    await complete(j!.id, `w1-${run}`, "accepted", { providerMessageId: "re_sent" });
    await svc.from("leads").update({ message: REDACTED }).eq("id", sent.lead_id);
    expect((await jobFor(sent.lead_id))!.state, "history is not rewritten").toBe("accepted");
  });

  it("the same trigger serves the retention sweep, which writes the same literal", async () => {
    const row = await submit("redact-sweep");
    await svc
      .from("leads")
      .update({ received_at: new Date(Date.now() - 25 * 30 * 24 * 3_600_000).toISOString() })
      .eq("id", row.lead_id);
    const { error } = await svc.rpc("redact_stale_enquiries", { p_months: 24 });
    expect(error).toBeNull();
    expect((await jobFor(row.lead_id))!.state).toBe("cancelled");
  });
});
