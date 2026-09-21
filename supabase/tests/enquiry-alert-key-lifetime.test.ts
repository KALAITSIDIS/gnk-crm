import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { ORG_A, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

type Job = Database["public"]["Tables"]["notification_jobs"]["Row"];

/**
 * 0104: the provider key's lifetime is independent of the retry budget.
 *
 * THE REGRESSION (audit 2026-09-21, reproduced here before the fix). 0102
 * made two promises that contradicted each other through one column:
 *
 *   - `request_enquiry_alert_retry` gives a job a FRESH attempt budget
 *     (`attempts = 0`) but keeps the provider key and its clock
 *     (`first_attempted_at`) when the key is still safe to reuse — so a
 *     retry after a lost answer is the SAME message, not a second one.
 *   - `released` (a worker out of budget hands an unattempted claim back)
 *     gives the claim's attempt back and, "when that claim was the only
 *     attempt there ever was", clears the clock — judged by `attempts - 1
 *     <= 0`.
 *
 * Put together: attempted once → staff retry (attempts 0, clock kept) →
 * claim (attempts 1) → release (attempts 0, and `attempts - 1 <= 0`, so the
 * clock is CLEARED). The row now says the key was never presented. Twenty
 * five hours later the claim hands it out again under the same key — the
 * exact second e-mail the window exists to prevent. The budget was reset;
 * the key's lifetime must not have been.
 *
 * THE FIX. `key_attempts` counts the claims handed out under the CURRENT
 * key serial that were not released. The staff retry never touches it
 * unless the key rotates (then it is 0, with the clock); the claim
 * increments it; `released` decrements it and clears the clock only when it
 * returns to zero — nothing was ever presented under this key. A genuinely
 * first, unattempted claim still clears; an explicit rotation still starts
 * a fresh lifetime; the worker never rotates.
 *
 * "Advancing the clock" here is a timestamp shift of WHATEVER the row
 * carries — a null clock stays null — so the red run reproduces the audit's
 * sequence rather than dodging it.
 */
const svc = serviceClient();
const run = Date.now().toString(36);
const made: string[] = [];
let adminA: TestUser;

const HOUR = 3_600_000;
const hoursAgo = (n: number) => new Date(Date.now() - n * HOUR).toISOString();

async function submit(label: string) {
  const { data, error } = await svc.rpc("submit_public_enquiry", {
    p_org_slug: "test-org-a",
    p_name: `Lifetime ${run} ${label}`,
    p_email: `lifetime-${label}-${run}@example.invalid`,
    p_phone: "",
    p_message: `key lifetime probe ${run} ${label}`,
    p_property_ref: "",
    p_idempotency_key: `life-${run}-${label}`,
  });
  if (error) throw new Error(`submit ${label}: ${error.message}`);
  const row = data![0]!;
  made.push(row.lead_id);
  return row;
}

async function jobFor(leadId: string): Promise<Job> {
  const { data, error } = await svc.from("notification_jobs").select("*").eq("lead_id", leadId).single();
  if (error) throw new Error(`jobFor: ${error.message}`);
  return data as Job;
}

async function setJob(leadId: string, patch: Partial<Job>) {
  const { error } = await svc.from("notification_jobs").update(patch).eq("lead_id", leadId);
  if (error) throw new Error(`setJob: ${error.message}`);
}

async function claim(worker: string, leadId: string) {
  const { data, error } = await svc.rpc("claim_notification_jobs", {
    p_worker: worker,
    p_limit: 1,
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

async function staffRetry(leadId: string) {
  const { error } = await adminA.client.rpc("request_enquiry_alert_retry", { p_lead_id: leadId });
  if (error) throw new Error(`retry: ${error.message}`);
}

/** "Advance the clock" by N hours: shift the timestamps the row carries; a null clock stays null. */
async function ageBy(leadId: string, hours: number) {
  const job = await jobFor(leadId);
  const shift = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - hours * HOUR).toISOString() : null);
  await setJob(leadId, {
    first_attempted_at: shift(job.first_attempted_at),
    last_attempted_at: shift(job.last_attempted_at),
    next_attempt_at: shift(job.next_attempt_at) ?? job.next_attempt_at,
  });
}

async function alertEvents(leadId: string) {
  const { data, error } = await svc
    .from("events")
    .select("payload")
    .eq("entity_type", "lead")
    .eq("entity_id", leadId)
    .eq("event_type", "enquiry_alert")
    .order("occurred_at", { ascending: true });
  if (error) throw new Error(`events: ${error.message}`);
  return (data ?? []).map((e) => e.payload as Record<string, unknown>);
}

/**
 * A job that was REALLY attempted once under key 1, `h` hours ago: through
 * the claim (which counts the presentation) and a transient retry outcome,
 * then aged. No column is written by hand — a fixture that sets `attempts`
 * and the clock directly describes a shape the claim never produces, and
 * 0104's check constraint refuses it.
 */
async function attemptedOnce(label: string, h: number) {
  const row = await submit(label);
  const [claimed] = await claim(`first-${label}-${run}`, row.lead_id);
  if (!claimed) throw new Error(`attemptedOnce ${label}: not claimed`);
  const ok = await complete(claimed.id, `first-${label}-${run}`, "retry", {
    p_category: "transient",
    p_result: "503",
    p_retry_in_seconds: 0,
  });
  if (!ok) throw new Error(`attemptedOnce ${label}: retry outcome refused`);
  await ageBy(row.lead_id, h);
  return row;
}

const closeTo = (iso: string | null, target: number, toleranceMs = 60_000) => {
  expect(iso, "the clock must be set").not.toBeNull();
  expect(Math.abs(new Date(iso!).getTime() - target)).toBeLessThan(toleranceMs);
};

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  adminA = await createTestUser(svc, `lifetime-admin-a-${run}@test.local`, "admin", ORG_A);
});

afterAll(async () => {
  if (!made.length) return;
  await svc.from("tasks").delete().in("lead_id", made);
  const { error } = await svc.from("leads").delete().in("id", made);
  if (error) throw new Error(`cleanup: ${error.message}`);
});

describe("the provider key's lifetime survives a reset budget (audit 2026-09-21)", () => {
  it("manual retry → claim → release → 25 h: the old key is NOT claimed again", async () => {
    const firstAt = Date.now() - 2 * HOUR;
    const row = await attemptedOnce("retry-release", 2);

    await staffRetry(row.lead_id);
    let job = await jobFor(row.lead_id);
    expect(job.key_serial, "inside the window the key is reused on purpose").toBe(1);
    expect(job.attempts, "a fresh budget").toBe(0);
    closeTo(job.first_attempted_at, firstAt);
    expect(job.key_attempts, "the earlier presentation still counts against the key").toBe(1);

    const claimed = await claim(`w1-${run}`, row.lead_id);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.attempts).toBe(1);
    expect(claimed[0]!.key_attempts).toBe(2);
    closeTo(claimed[0]!.first_attempted_at, firstAt);

    expect(await complete(claimed[0]!.id, `w1-${run}`, "released")).toBe(true);
    job = await jobFor(row.lead_id);
    expect(job.state).toBe("pending");
    expect(job.attempts, "the released claim's attempt is given back").toBe(0);
    expect(job.key_attempts, "…but the earlier presentation is not forgotten").toBe(1);
    closeTo(job.first_attempted_at, firstAt);

    await ageBy(row.lead_id, 25);
    const again = await claim(`w2-${run}`, row.lead_id);
    expect(again, "a key the provider has forgotten is never presented again automatically").toHaveLength(0);
    job = await jobFor(row.lead_id);
    expect(job.state).toBe("failed");
    expect(job.last_result).toBe("key_window_expired");
    expect(job.key_serial, "the worker never rotates").toBe(1);
    const events = await alertEvents(row.lead_id);
    expect(events.filter((e) => e.result === "key_window_expired")).toHaveLength(1);
  });

  it("the control: the same sequence without the release is refused at 25 h too", async () => {
    const row = await attemptedOnce("control", 2);
    await staffRetry(row.lead_id);
    await ageBy(row.lead_id, 25);
    const again = await claim(`w-${run}`, row.lead_id);
    expect(again).toHaveLength(0);
    expect((await jobFor(row.lead_id)).last_result).toBe("key_window_expired");
  });

  it("repeated retry / claim / release cycles never restart the key's clock", async () => {
    const firstAt = Date.now() - 3 * HOUR;
    const row = await attemptedOnce("cycles", 3);
    for (let cycle = 1; cycle <= 3; cycle++) {
      await staffRetry(row.lead_id);
      const [claimed] = await claim(`cycle-${cycle}-${run}`, row.lead_id);
      expect(claimed, `cycle ${cycle}: claimed`).toBeDefined();
      expect(await complete(claimed!.id, `cycle-${cycle}-${run}`, "released")).toBe(true);
      const job = await jobFor(row.lead_id);
      expect(job.attempts, `cycle ${cycle}: budget back to zero`).toBe(0);
      expect(job.key_attempts, `cycle ${cycle}: the one real presentation still counts`).toBe(1);
      expect(job.key_serial, `cycle ${cycle}: same key`).toBe(1);
      closeTo(job.first_attempted_at, firstAt);
    }
    await ageBy(row.lead_id, 25);
    expect(await claim(`w-${run}`, row.lead_id)).toHaveLength(0);
    expect((await jobFor(row.lead_id)).last_result).toBe("key_window_expired");
  });

  it("release of a genuinely first, unattempted claim clears the clock and the job stays eligible however old", async () => {
    const row = await submit("first-release");
    const [claimed] = await claim(`w1-${run}`, row.lead_id);
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.key_attempts).toBe(1);
    expect(claimed!.first_attempted_at).not.toBeNull();

    expect(await complete(claimed!.id, `w1-${run}`, "released")).toBe(true);
    let job = await jobFor(row.lead_id);
    expect(job.attempts).toBe(0);
    expect(job.key_attempts, "nothing was ever presented under this key").toBe(0);
    expect(job.first_attempted_at, "so no window is running").toBeNull();

    await setJob(row.lead_id, { created_at: hoursAgo(30 * 24), next_attempt_at: hoursAgo(30 * 24) });
    const again = await claim(`w2-${run}`, row.lead_id);
    expect(again, "never attempted: eligible however old").toHaveLength(1);
    job = await jobFor(row.lead_id);
    expect(job.key_serial).toBe(1);
    expect(job.key_attempts).toBe(1);
  });

  it("explicit rotation → claim → release: the NEW key's lifetime starts at its first claim, and only a real attempt pins it", async () => {
    const row = await attemptedOnce("rotate", 21); // outside the 20 h window: the retry must rotate
    await staffRetry(row.lead_id);
    let job = await jobFor(row.lead_id);
    expect(job.key_serial, "an unsafe key is rotated by the human retry").toBe(2);
    expect(job.first_attempted_at, "a new key has never been presented").toBeNull();
    expect(job.key_attempts).toBe(0);

    // first claim under key 2, released: still never presented
    let [claimed] = await claim(`w1-${run}`, row.lead_id);
    expect(claimed!.key_serial).toBe(2);
    expect(claimed!.key_attempts).toBe(1);
    expect(await complete(claimed!.id, `w1-${run}`, "released")).toBe(true);
    job = await jobFor(row.lead_id);
    expect(job.first_attempted_at).toBeNull();
    expect(job.key_attempts).toBe(0);

    // a REAL attempt under key 2 (a transient retry), then a released claim: the clock stays
    [claimed] = await claim(`w2-${run}`, row.lead_id);
    const presentedAt = new Date(claimed!.first_attempted_at!).getTime();
    expect(await complete(claimed!.id, `w2-${run}`, "retry", { p_category: "transient", p_result: "503", p_retry_in_seconds: 0 })).toBe(true);
    await setJob(row.lead_id, { next_attempt_at: hoursAgo(0) });
    [claimed] = await claim(`w3-${run}`, row.lead_id);
    expect(claimed!.key_attempts).toBe(2);
    expect(await complete(claimed!.id, `w3-${run}`, "released")).toBe(true);
    job = await jobFor(row.lead_id);
    expect(job.key_attempts).toBe(1);
    closeTo(job.first_attempted_at, presentedAt, 5_000);
    expect(job.key_serial).toBe(2);
  });

  it("a stranger's release is refused and changes nothing", async () => {
    const firstAt = Date.now() - 1 * HOUR;
    const row = await attemptedOnce("stranger", 1);
    await staffRetry(row.lead_id);
    const [claimed] = await claim(`holder-${run}`, row.lead_id);
    expect(await complete(claimed!.id, `stranger-${run}`, "released")).toBe(false);
    const job = await jobFor(row.lead_id);
    expect(job.state).toBe("sending");
    expect(job.claimed_by).toBe(`holder-${run}`);
    expect(job.attempts).toBe(1);
    expect(job.key_attempts).toBe(2);
    closeTo(job.first_attempted_at, firstAt);
  });

  it("two workers claiming at once: exactly one is handed the row, and the key clock is counted once", async () => {
    const row = await submit("concurrent");
    const [a, b] = await Promise.all([claim(`race-a-${run}`, row.lead_id), claim(`race-b-${run}`, row.lead_id)]);
    expect(a.length + b.length, "for update skip locked: one holder").toBe(1);
    const job = await jobFor(row.lead_id);
    expect(job.attempts).toBe(1);
    expect(job.key_attempts).toBe(1);
    expect(job.state).toBe("sending");
  });
});
