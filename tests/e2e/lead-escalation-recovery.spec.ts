import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { clearFactors, enrolAndVerify } from "@/lib/testing/mfa";
import {
  LOCAL_ANON_KEY,
  LOCAL_SUPABASE_URL,
  assertNoProblems,
  fixtureProfile,
  isLocal,
  login,
  opTimeout,
  serviceClient,
  watchForProblems,
} from "./helpers";

/**
 * The lead inbox's escalation status and an admin's recovery of one that
 * stopped (0111, audit 2026-09-22 fifth brief).
 *
 * The rules are the database's and are proven on a real stack by
 * supabase/tests/lead-escalation-recovery.test.ts; the wording is
 * lib/services/lead-escalation-status.test.ts's. This spec covers what only
 * the running app can prove: a website lead carrying BOTH kinds shows both
 * chips with the right words; Review & resend warns, asks for no typed text
 * (0115) and, once confirmed, the row is pending under a NEW key with the admin's event; Retry
 * on a plain failure leaves the key alone; a lead with no escalation row
 * renders the desk alert alone; and an agent sees the status without the
 * controls.
 *
 * NOTHING IS SENT. The local `.env.local` has no RESEND_API_KEY and no
 * ENQUIRY_ALERT_TO, so the action's after() worker reports itself unconfigured
 * and claims nothing — the rows stay pending, which is exactly what the
 * assertions read. Local only: it writes leads and jobs into the seeded org
 * and flips the escalation policy, restoring the row it found.
 */
const ORG_SLUG = "gnk";
const svc = serviceClient();
const run = Date.now().toString(36);
const made: string[] = [];
let policyBefore: unknown;
let startedAt = "";

async function submit(label: string) {
  const { data, error } = await svc.rpc("submit_public_enquiry", {
    p_org_slug: ORG_SLUG,
    p_name: `E2E Recovery ${run} ${label}`,
    p_email: `e2e-recovery-${label}-${run}@example.invalid`,
    p_phone: "",
    p_message: `e2e recovery probe ${run} ${label}`,
    p_property_ref: "",
    p_idempotency_key: `e2erec-${run}-${label}`,
  });
  if (error) throw new Error(`submit ${label}: ${error.message}`);
  const leadId = data![0]!.lead_id as string;
  made.push(leadId);
  return leadId;
}

type Job = { id: string; state: string; key_serial: number; attempts: number; first_attempted_at: string | null; last_result: string | null };

async function jobOf(leadId: string, kind: string): Promise<Job> {
  const { data, error } = await svc
    .from("notification_jobs")
    .select("id, state, key_serial, attempts, first_attempted_at, last_result")
    .eq("lead_id", leadId)
    .eq("kind", kind)
    .single();
  if (error) throw new Error(`jobOf: ${error.message}`);
  return data as Job;
}

/** An escalation row driven to a terminal state through the real claim and completion — never by hand. */
async function escalationClosedAs(leadId: string, orgId: string, outcome: "failed", extra: Record<string, unknown>) {
  const { data: minted, error } = await svc
    .from("notification_jobs")
    .insert({ org_id: orgId, lead_id: leadId, kind: "lead_escalation" })
    .select("id")
    .single();
  if (error) throw new Error(`mint: ${error.message}`);
  const worker = `e2e-${run}`;
  const claim = await svc.rpc("claim_notification_jobs", { p_worker: worker, p_limit: 1, p_lease_seconds: 60, p_job_id: minted!.id } as never);
  if (claim.error || !(claim.data as unknown[])?.length) throw new Error(`claim: ${claim.error?.message ?? "nothing claimed"}`);
  const done = await svc.rpc("complete_notification_job", { p_job_id: minted!.id, p_worker: worker, p_outcome: outcome, ...extra } as never);
  if (done.error || done.data !== true) throw new Error(`complete: ${done.error?.message ?? "refused"}`);
  return minted!.id as string;
}

/** The desk alert, failed for good through its own real path (one attempt allowed, a transient answer). */
async function deskAlertFailed(leadId: string) {
  const desk = await jobOf(leadId, "enquiry_desk_alert");
  await svc.from("notification_jobs").update({ max_attempts: 1 }).eq("id", desk.id);
  const worker = `e2e-desk-${run}`;
  const claim = await svc.rpc("claim_notification_jobs", { p_worker: worker, p_limit: 1, p_lease_seconds: 60, p_job_id: desk.id } as never);
  if (claim.error || !(claim.data as unknown[])?.length) throw new Error(`desk claim: ${claim.error?.message ?? "nothing claimed"}`);
  const done = await svc.rpc("complete_notification_job", {
    p_job_id: desk.id,
    p_worker: worker,
    p_outcome: "retry",
    p_category: "transient",
    p_result: "503",
    p_retry_in_seconds: 0,
  } as never);
  if (done.error || done.data !== true) throw new Error(`desk complete: ${done.error?.message ?? "refused"}`);
  return desk.id;
}

async function recoveryEvents(leadId: string) {
  const { data, error } = await svc
    .from("events")
    .select("actor_id, payload")
    .eq("entity_type", "lead")
    .eq("entity_id", leadId)
    .eq("event_type", "lead_escalation")
    .order("id");
  if (error) throw new Error(`events: ${error.message}`);
  return (data ?? [])
    .map((e) => ({ actor_id: e.actor_id as string | null, payload: e.payload as Record<string, unknown> }))
    .filter((e) => e.payload.outcome === "recovery_requested");
}

/** The inbox row of one lead, found by the visitor's name the door wrote into the message. */
const rowOf = (page: Page, label: string) => page.locator("li", { hasText: `E2E Recovery ${run} ${label}` });

test.describe("Lead inbox — escalation status and recovery", () => {
  test.beforeAll(async () => {
    test.skip(!isLocal(), "writes leads, jobs and the escalation policy — local only, never production");
    const { id: adminId } = await fixtureProfile(svc);
    const { data } = await svc.from("cyprus_config").select("value").eq("key", "lead_escalation").single();
    policyBefore = data!.value;
    startedAt = new Date().toISOString();
    // ON with the seeded admin as the one recipient: a recovery needs the policy on and somebody eligible
    await svc
      .from("cyprus_config")
      .update({ value: { enabled: true, after_minutes: 15, max_age_hours: 48, recipients: [adminId], working_hours: null, timezone: "Asia/Nicosia" } as never })
      .eq("key", "lead_escalation");
  });

  test.afterAll(async () => {
    if (!isLocal()) return;
    if (policyBefore !== undefined) await svc.from("cyprus_config").update({ value: policyBefore as never }).eq("key", "lead_escalation");
    // While the policy was ON the local five-minute sweep may have minted a
    // queued escalation for some OTHER test lead of the seeded org; nothing
    // sends locally, so such a row would sit "queued" on the inbox for good.
    if (startedAt) {
      const { orgId } = await fixtureProfile(svc);
      await svc
        .from("notification_jobs")
        .delete()
        .eq("org_id", orgId)
        .eq("kind", "lead_escalation")
        .eq("state", "pending")
        .eq("attempts", 0)
        .gte("created_at", startedAt);
    }
    if (made.length) {
      await svc.from("tasks").delete().in("lead_id", made);
      await svc.from("leads").delete().in("id", made);
    }
  });

  test("a lead carrying both kinds shows both; Review & resend warns, asks for no typed text, and re-queues the escalation under a NEW key with the admin's event", async ({ page }) => {
    const { id: adminId, orgId } = await fixtureProfile(svc);
    const lead = await submit("both");
    const deskId = await deskAlertFailed(lead);
    const escId = await escalationClosedAs(lead, orgId, "failed", { p_category: "conflict", p_result: "invalid_idempotent_request" });
    const before = await jobOf(lead, "lead_escalation");
    expect(before).toMatchObject({ state: "failed", key_serial: 1 });

    const problems = watchForProblems(page);
    await page.goto("/leads", { waitUntil: "networkidle" });
    const row = rowOf(page, "both");
    await expect(row).toBeVisible({ timeout: opTimeout(30_000) });
    await expect(row.getByText(/desk alert FAILED/i)).toBeVisible();
    await expect(row.getByText(/escalation needs a decision/i)).toBeVisible();
    await expect(row.getByText(/may already have sent it/i)).toBeVisible();
    await expect(row.getByRole("button", { name: /review & resend/i })).toBeVisible();
    await expect(row.getByRole("button", { name: /retry escalation/i }), "the row admits resend, not retry").toHaveCount(0);

    await row.getByRole("button", { name: /review & resend/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/may already have accepted/i)).toBeVisible();
    // 0115: no free-text box — the chain keeps the facts (who, when, which
    // action, the previous state), never words typed about a person
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await expect(dialog.getByText(/audit log records that you resent it/i)).toBeVisible();
    // opening the dialog moved nothing
    expect(await jobOf(lead, "lead_escalation")).toMatchObject({ state: "failed", key_serial: 1 });
    await dialog.getByRole("button", { name: /resend under a new key/i }).click();
    await expect(page.getByText(/escalation queued under a new key/i)).toBeVisible({ timeout: opTimeout(20_000) });
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: opTimeout(20_000) });

    // the database agrees: pending under key 2, the desk alert untouched, one event signed by the admin
    await expect.poll(async () => (await jobOf(lead, "lead_escalation")).state, { timeout: opTimeout(20_000) }).toBe("pending");
    const after = await jobOf(lead, "lead_escalation");
    expect(after).toMatchObject({ id: escId, state: "pending", key_serial: 2, attempts: 0, first_attempted_at: null, last_result: null });
    expect(await jobOf(lead, "enquiry_desk_alert")).toMatchObject({ id: deskId, state: "failed", key_serial: 1, last_result: "503" });
    const events = await recoveryEvents(lead);
    expect(events).toHaveLength(1);
    expect(events[0]!.actor_id).toBe(adminId);
    expect(events[0]!.payload).toMatchObject({
      action: "resend",
      job_id: escId,
      key_serial: 2,
      key_rotated: true,
      previous_state: "failed",
      previous_result: "invalid_idempotent_request",
    });
    expect(events[0]!.payload, "no typed text in the chain (0115)").not.toHaveProperty("reason");
    expect(JSON.stringify(events[0]!.payload), "ids and words only — no address").not.toContain("example.invalid");

    // the row now reads as queued, with no control
    await page.reload({ waitUntil: "networkidle" });
    await expect(rowOf(page, "both").getByText(/escalation queued/i)).toBeVisible({ timeout: opTimeout(30_000) });
    await expect(rowOf(page, "both").getByRole("button", { name: /resend|retry escalation/i })).toHaveCount(0);
    assertNoProblems(problems, "leads (escalation resend)");
  });

  test("Retry on a plain failure re-queues under the SAME key, and a lead with no escalation row shows the desk alert alone", async ({ page }) => {
    const { orgId } = await fixtureProfile(svc);
    const lead = await submit("retry");
    const escId = await escalationClosedAs(lead, orgId, "failed", { p_category: "permanent", p_result: "validation_error" });
    const before = await jobOf(lead, "lead_escalation");
    await submit("plain");

    await page.goto("/leads", { waitUntil: "networkidle" });
    const row = rowOf(page, "retry");
    await expect(row).toBeVisible({ timeout: opTimeout(30_000) });
    await expect(row.getByText(/escalation FAILED \(validation_error\)/i)).toBeVisible();
    await expect(row.getByRole("button", { name: /review & resend/i })).toHaveCount(0);
    await row.getByRole("button", { name: /retry escalation/i }).click();
    await expect(page.getByText(/escalation queued — sending now/i)).toBeVisible({ timeout: opTimeout(20_000) });

    await expect.poll(async () => (await jobOf(lead, "lead_escalation")).state, { timeout: opTimeout(20_000) }).toBe("pending");
    expect(await jobOf(lead, "lead_escalation")).toMatchObject({
      id: escId,
      key_serial: 1,
      attempts: 0,
      first_attempted_at: before.first_attempted_at,
    });
    const [ev] = await recoveryEvents(lead);
    expect(ev!.payload).toMatchObject({ action: "retry", key_rotated: false, previous_result: "validation_error" });
    expect(ev!.payload, "no typed text in the chain (0115)").not.toHaveProperty("reason");

    // the second lead: a desk alert chip and nothing about an escalation
    const plainRow = rowOf(page, "plain");
    await expect(plainRow.getByText(/desk alert queued/i)).toBeVisible();
    await expect(plainRow.getByText(/escalation/i)).toHaveCount(0);
  });

  test.describe("an agent's view", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("sees the status and none of the controls", async ({ page }) => {
      const { orgId } = await fixtureProfile(svc);
      const email = `e2e-recovery-agent-${run}@gnk.local`;
      const password = `agent-pw-${run}`;
      const { data: created, error: createErr } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
      expect(createErr).toBeNull();
      const agentId = created!.user!.id;
      const { error: profErr } = await svc.from("profiles").insert({ id: agentId, org_id: orgId, role: "agent", full_name: "E2E Recovery Agent", email });
      expect(profErr).toBeNull();
      try {
        // the factor the login needs, enrolled the way auth.setup.ts enrols the admin's
        await clearFactors(svc, agentId);
        const user = createClient(LOCAL_SUPABASE_URL, LOCAL_ANON_KEY, { auth: { persistSession: false } });
        const { error: signIn } = await user.auth.signInWithPassword({ email, password });
        expect(signIn).toBeNull();
        const factor = await enrolAndVerify(user);

        const lead = await submit("agent");
        await escalationClosedAs(lead, orgId, "failed", { p_category: "conflict", p_result: "invalid_idempotent_request" });

        await login(page, email, password, factor.secret);
        await page.goto("/leads", { waitUntil: "networkidle" });
        const row = rowOf(page, "agent");
        await expect(row).toBeVisible({ timeout: opTimeout(30_000) });
        await expect(row.getByText(/escalation needs a decision/i)).toBeVisible();
        await expect(row.getByRole("button", { name: /review & resend|retry escalation/i }), "an agent may look, not act").toHaveCount(0);
      } finally {
        await svc.from("profiles").delete().eq("id", agentId);
        await svc.auth.admin.deleteUser(agentId);
      }
    });
  });
});
