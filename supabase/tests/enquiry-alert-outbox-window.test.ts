import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { ORG_A, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

type Job = Database["public"]["Tables"]["notification_jobs"]["Row"];

/**
 * 0102: the outbox after review — the provider's key window, batch release,
 * the legacy closure at the claim, and the lifetime of a rotated key.
 *
 * FINDING A. Resend keeps an idempotency key for 24 hours. Every automatic
 * retry reuses the job's key so that a retry after a LOST ANSWER (the
 * provider accepted, the response never arrived) is answered with the first
 * message rather than a second one. That protection ends when the provider
 * forgets the key — and until 0102 nothing stopped a retry from running
 * after that: `claim_notification_jobs` handed out any due row whatever its
 * age, so a sweep that had been down for a day sent a job first attempted 25
 * hours earlier under a key nobody remembered. Summing the configured
 * backoff (~2h07m) proved nothing, because the backoff only describes when
 * a retry is DUE, not when a sweep actually runs.
 *
 * Now the claim refuses any row whose FIRST attempt is older than the key
 * window (20 hours: 24 minus a margin) and closes it for review — `failed`,
 * `key_window_expired`, one event — while a row that has NEVER been
 * attempted stays eligible however old it is: age is measured from the
 * first attempt, not from creation.
 *
 * FINDING D. The rollout guard (a lead the pre-0101 route already alerted)
 * lived in the worker as a separate read whose failure let the send go
 * ahead. It is now part of the claim itself, in the same transaction: a
 * lead carrying `enquiry_alert: sent` is closed as `legacy_sender` and is
 * never handed out.
 *
 * FINDING B. A worker that runs out of time budget hands an UNATTEMPTED
 * claim back with `released`: the row is pending again at once and the
 * attempt the claim counted is given back, so a slow batch cannot exhaust a
 * message nobody tried to send.
 *
 * And the key's lifetime on an explicit resend: rotating the serial means a
 * NEW key that has never been attempted, so `first_attempted_at` is cleared
 * with it; reusing the key keeps the clock of its first attempt.
 */
const svc = serviceClient();
const run = Date.now().toString(36);
const made: string[] = [];
let adminA: TestUser;

const hours = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

async function submit(label: string) {
  const { data, error } = await svc.rpc("submit_public_enquiry", {
    p_org_slug: "test-org-a",
    p_name: `Window ${run} ${label}`,
    p_email: `window-${label}-${run}@example.invalid`,
    p_phone: "",
    p_message: `window probe ${run} ${label}`,
    p_property_ref: "",
    p_idempotency_key: `win-${run}-${label}`,
  });
  if (error) throw new Error(`submit ${label}: ${error.message}`);
  const row = data![0]!;
  made.push(row.lead_id);
  return row;
}

async function jobFor(leadId: string): Promise<Job | null> {
  const { data, error } = await svc.from("notification_jobs").select("*").eq("lead_id", leadId).maybeSingle();
  if (error) throw new Error(`jobFor: ${error.message}`);
  return data as Job | null;
}

async function setJob(leadId: string, patch: Partial<Job>) {
  const { error } = await svc.from("notification_jobs").update(patch).eq("lead_id", leadId);
  if (error) throw new Error(`setJob: ${error.message}`);
}

async function claim(worker: string, leadId: string, limit = 1) {
  const { data, error } = await svc.rpc("claim_notification_jobs", {
    p_worker: worker,
    p_limit: limit,
    p_lease_seconds: 90,
    p_lead_id: leadId,
  });
  if (error) throw new Error(`claim: ${error.message}`);
  return (data ?? []) as Job[];
}

async function complete(jobId: string, worker: string, outcome: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await svc.rpc("complete_notification_job", {
    p_job_id: jobId,
    p_worker: worker,
    p_outcome: outcome,
    ...extra,
  });
  if (error) throw new Error(`complete: ${error.message}`);
  return data as boolean;
}

async function alertEvents(leadId: string) {
  const { data, error } = await svc
    .from("events")
    .select("payload")
    .eq("entity_type", "lead")
    .eq("entity_id", leadId)
    .eq("event_type", "enquiry_alert")
    .order("id");
  if (error) throw new Error(`alertEvents: ${error.message}`);
  return (data ?? []).map((e) => e.payload as Record<string, unknown>);
}

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  adminA = await createTestUser(svc, `window-admin-a-${run}@test.local`, "admin", ORG_A);
});

afterAll(async () => {
  if (!made.length) return;
  await svc.from("tasks").delete().in("lead_id", made);
  const { error } = await svc.from("leads").delete().in("id", made);
  if (error) throw new Error(`cleanup: ${error.message}`);
});

describe("the provider's key window (finding A)", () => {
  it("a job first attempted 25 hours ago is NOT claimed: it is closed for review, with an event", async () => {
    const row = await submit("stale");
    await setJob(row.lead_id, { attempts: 1, key_attempts: 1, first_attempted_at: hours(25), last_attempted_at: hours(25) });
    const claimed = await claim(`w-${run}`, row.lead_id);
    expect(claimed, "the provider no longer remembers this key — no automatic resend").toHaveLength(0);
    const job = await jobFor(row.lead_id);
    expect(job!.state).toBe("failed");
    expect(job!.last_category).toBe("timeout");
    expect(job!.last_result).toBe("key_window_expired");
    expect(job!.attempts, "no attempt was spent closing it").toBe(1);
    expect(job!.finished_at).not.toBeNull();
    const events = await alertEvents(row.lead_id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "failed", result: "key_window_expired", exhausted: false });
  });

  it("a lease that lapsed on a job first attempted 25 hours ago is closed the same way, not re-claimed", async () => {
    const row = await submit("stale-sending");
    await setJob(row.lead_id, {
      state: "sending",
      claimed_by: "dead-worker",
      claimed_until: hours(23),
      attempts: 2,
      key_attempts: 1, first_attempted_at: hours(25),
    });
    const claimed = await claim(`w-${run}`, row.lead_id);
    expect(claimed).toHaveLength(0);
    expect((await jobFor(row.lead_id))!.last_result).toBe("key_window_expired");
  });

  it("a job inside the window is still claimed under the same key", async () => {
    const row = await submit("fresh-retry");
    await setJob(row.lead_id, { attempts: 3, key_attempts: 3, first_attempted_at: hours(19), key_serial: 1 });
    const claimed = await claim(`w-${run}`, row.lead_id);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.key_serial, "the same key: a lost answer is answered with the first message").toBe(1);
    expect(claimed[0]!.first_attempted_at, "the window keeps counting from the first attempt").toBe(
      (await jobFor(row.lead_id))!.first_attempted_at,
    );
  });

  it("a job that was NEVER attempted stays eligible however old it is — age is the first attempt, not creation", async () => {
    const row = await submit("old-unattempted");
    await setJob(row.lead_id, { created_at: hours(30 * 24), next_attempt_at: hours(30 * 24) });
    await svc.from("leads").update({ received_at: hours(30 * 24) }).eq("id", row.lead_id);
    const claimed = await claim(`w-${run}`, row.lead_id);
    expect(claimed, "an old creation timestamp alone must not prevent a first send").toHaveLength(1);
    expect(claimed[0]!.attempts).toBe(1);
  });

  it("the window is shorter than the provider's retention and the database refuses a longer one", async () => {
    const { data: window } = await svc.rpc("notification_key_window");
    expect(String(window)).toMatch(/20:00:00/);
    const { error } = await svc.rpc("claim_notification_jobs", {
      p_worker: `w-${run}`,
      p_limit: 1,
      p_lease_seconds: 90,
      p_lead_id: "00000000-0000-0000-0000-000000000000",
      p_key_window: "25 hours",
    });
    expect(error?.message, "a window past the provider's 24 hours is a mistake, not a setting").toMatch(/24 hours/);
  });
});

describe("the legacy closure lives in the claim (finding D)", () => {
  it("a lead the old route already alerted is closed as legacy_sender by the claim, and never handed out", async () => {
    const row = await submit("legacy");
    const { error } = await svc.from("events").insert({
      org_id: ORG_A,
      actor_id: null,
      entity_type: "lead",
      entity_id: row.lead_id,
      event_type: "enquiry_alert",
      payload: { outcome: "sent", provider: "resend" },
    });
    expect(error).toBeNull();
    const claimed = await claim(`w-${run}`, row.lead_id);
    expect(claimed, "nothing to send — the desk was told before the deploy").toHaveLength(0);
    const job = await jobFor(row.lead_id);
    expect(job!.state).toBe("accepted");
    expect(job!.last_result).toBe("legacy_sender");
    expect(job!.provider_message_id).toBeNull();
    expect(job!.attempts, "no attempt was spent").toBe(0);
    const events = await alertEvents(row.lead_id);
    expect(events.map((e) => e.outcome)).toEqual(["sent", "accepted"]);
    expect(events[1]).toMatchObject({ result: "legacy_sender" });
  });

  it("a lead whose old alert was SKIPPED or FAILED is not treated as told", async () => {
    const row = await submit("legacy-skipped");
    await svc.from("events").insert({
      org_id: ORG_A,
      actor_id: null,
      entity_type: "lead",
      entity_id: row.lead_id,
      event_type: "enquiry_alert",
      payload: { outcome: "skipped", provider: "resend" },
    });
    const claimed = await claim(`w-${run}`, row.lead_id);
    expect(claimed, "skipped means the desk was NOT told — the row is sent").toHaveLength(1);
  });
});

describe("releasing an unattempted claim (finding B)", () => {
  it("released gives the attempt back and clears the first-attempt clock when nothing was ever tried", async () => {
    const row = await submit("release");
    const [job] = await claim(`w-${run}`, row.lead_id);
    expect(job!.attempts).toBe(1);
    expect(job!.first_attempted_at).not.toBeNull();
    expect(await complete(job!.id, `w-${run}`, "released")).toBe(true);
    const back = await jobFor(row.lead_id);
    expect(back!.state).toBe("pending");
    expect(back!.attempts, "the claim's attempt is given back").toBe(0);
    expect(back!.first_attempted_at, "never attempted: the key window has not started").toBeNull();
    expect(back!.claimed_by).toBeNull();
    expect(new Date(back!.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await alertEvents(row.lead_id), "a release is not an outcome").toHaveLength(0);
    // and it can be claimed again straight away
    expect(await claim(`w2-${run}`, row.lead_id)).toHaveLength(1);
  });

  it("released after an earlier real attempt keeps that attempt's clock", async () => {
    const row = await submit("release-second");
    const first = hours(1);
    await setJob(row.lead_id, { attempts: 1, key_attempts: 1, first_attempted_at: first, last_attempted_at: first });
    const [job] = await claim(`w-${run}`, row.lead_id);
    expect(job!.attempts).toBe(2);
    await complete(job!.id, `w-${run}`, "released");
    const back = await jobFor(row.lead_id);
    expect(back!.attempts).toBe(1);
    expect(new Date(back!.first_attempted_at!).getTime(), "the earlier attempt still happened").toBe(
      new Date(first).getTime(),
    );
  });

  it("only the holder may release, like every other completion", async () => {
    const row = await submit("release-stranger");
    const [job] = await claim(`w-${run}`, row.lead_id);
    expect(await complete(job!.id, `stranger-${run}`, "released")).toBe(false);
    expect((await jobFor(row.lead_id))!.state).toBe("sending");
  });
});

describe("the lifetime of a rotated key (explicit resend)", () => {
  const fail = (leadId: string, patch: Partial<Job>) =>
    setJob(leadId, {
      state: "failed",
      attempts: 8,
      last_category: "timeout",
      last_result: "key_window_expired",
      finished_at: new Date().toISOString(),
      ...patch,
    });

  it("a resend after the window rotates the key AND starts a fresh, unattempted lifetime", async () => {
    const row = await submit("rotate");
    await fail(row.lead_id, { key_attempts: 1, first_attempted_at: hours(25) });
    const res = await adminA.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(res.error).toBeNull();
    const job = await jobFor(row.lead_id);
    expect(job!.key_serial).toBe(2);
    expect(job!.first_attempted_at, "a new key has never been attempted").toBeNull();
    expect(job!.attempts).toBe(0);
    const events = await alertEvents(row.lead_id);
    expect(events.at(-1)).toMatchObject({ outcome: "retry_requested", key_serial: 2, key_rotated: true });
    // and the claim admits it: the old first attempt no longer counts against the new key
    expect(await claim(`w-${run}`, row.lead_id)).toHaveLength(1);
  });

  it("a resend inside the window keeps the key and its clock", async () => {
    const row = await submit("keep");
    const first = hours(2);
    await fail(row.lead_id, { last_category: "permanent", last_result: "validation_error", key_attempts: 1, first_attempted_at: first });
    const res = await adminA.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(res.error).toBeNull();
    const job = await jobFor(row.lead_id);
    expect(job!.key_serial).toBe(1);
    expect(new Date(job!.first_attempted_at!).getTime(), "same key, same clock").toBe(new Date(first).getTime());
    expect((await alertEvents(row.lead_id)).at(-1)).toMatchObject({ key_rotated: false });
  });

  it("a payload conflict rotates the key on the human's say-so, never on the worker's", async () => {
    const row = await submit("conflict");
    await fail(row.lead_id, { last_category: "conflict", last_result: "invalid_idempotent_request", key_attempts: 1, first_attempted_at: hours(1) });
    const res = await adminA.client.rpc("request_enquiry_alert_retry", { p_lead_id: row.lead_id });
    expect(res.error).toBeNull();
    const job = await jobFor(row.lead_id);
    expect(job!.key_serial).toBe(2);
    expect(job!.first_attempted_at).toBeNull();
  });
});
