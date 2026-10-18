import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SenderReadiness } from "@/lib/services/sender-readiness";

/**
 * A08 PR 2 (review 2026-10-18): business words first, the system's words
 * behind "Technical details". What a server render can prove, on the real
 * components:
 *
 *  - the lead card's desk-alert and escalation chips carry no result code,
 *    counter or machinery word in what is shown, and every code is still
 *    there — inside the closed <details>;
 *  - both route error boundaries say "This page could not load" in a
 *    role="alert", quote the digest as the reference, and keep the raw
 *    message inside <details>;
 *  - the admin dashboard's background-jobs line names the work, never the
 *    pg_cron job, outside <details>; the friendly names cover exactly the
 *    jobs the migrations schedule;
 *  - Settings → Cyprus config heads each known row with a plain title, keeps
 *    the key and the stored description in <details>, and an unknown key
 *    still shows; a failed read is the error boundary, not an empty page;
 *  - the escalation, routing and nudge panels and the escalation preview
 *    name no sweep, worker, row, migration or guardrail.
 *
 * The wording of each state is pinned in lib/services/enquiry-alert-status
 * .test.ts and lead-escalation-status.test.ts; this file proves the
 * components put it in the right place. The settings actions' "missing"
 * sentences: lib/actions/settings-missing-row.test.ts.
 */

const admin = vi.hoisted(() => ({
  rpc: vi.fn<(name: string) => Promise<{ data: unknown; error: { message: string } | null }>>(),
}));
const server = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>> | null,
  error: null as { message: string } | null,
}));

vi.mock("@/lib/actions/leads", () => ({ retryEnquiryAlert: vi.fn(), recoverLeadEscalation: vi.fn() }));
vi.mock("@/lib/actions/settings", () => ({
  saveCyprusConfig: vi.fn(),
  saveLeadEscalation: vi.fn(),
  previewLeadEscalation: vi.fn(),
  saveLeadRouting: vi.fn(),
  saveNudgeThresholds: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: admin.rpc }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        order: async () => ({ data: server.rows, error: server.error, status: server.error ? 500 : 200 }),
      }),
    }),
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "u-1", orgId: "org-1", role: "admin", fullName: "Admin Person" }),
}));

const { DeskAlertChip } = await import("@/components/features/leads/desk-alert");
const { EscalationChip } = await import("@/components/features/leads/escalation-status");
const { default: AppError } = await import("@/app/(app)/error");
const { default: PropertiesError } = await import("@/app/(app)/properties/error");
const { CronHealth } = await import("@/components/features/dashboard/cron-health");
const { CRON_JOB_LABELS, cronJobLabel } = await import("@/lib/services/cron-job-labels");
const { EXPECTED_CRON_JOBS } = await import("@/lib/services/cron-health");
const { CONFIG_LABELS, configLabel } = await import("@/components/features/settings/config-labels");
const { default: CyprusConfigSettingsPage } = await import("@/app/(app)/settings/cyprus-config/page");
const { LeadEscalationPanel } = await import("@/components/features/settings/lead-escalation-panel");
const { LeadEscalationPreviewCard } = await import("@/components/features/settings/lead-escalation-preview");
const { LeadRoutingPanel } = await import("@/components/features/settings/lead-routing-panel");
const { NudgeThresholdsPanel } = await import("@/components/features/settings/nudge-thresholds-panel");
const { readLeadEscalationPreview } = await import("@/lib/services/lead-escalation-preview");
const { NUDGE_DEFAULTS } = await import("@/lib/services/nudge-thresholds");

const root = join(import.meta.dirname, "..", "..");

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const html = (element: ReactElement) => renderToStaticMarkup(element);
/** Inline tags join their text to the sentence; every other tag is a break. */
const textOf = (markup: string) =>
  decode(markup.replace(/<\/?(?:span|a|strong|em|code|b|i)\b[^>]*>/g, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
/** What the reader sees without opening anything: the markup minus every <details> and the raw JSON boxes. */
const shown = (markup: string) =>
  textOf(markup.replace(/<details\b[\s\S]*?<\/details>/g, " ").replace(/<textarea\b[\s\S]*?<\/textarea>/g, " "));
/** What is behind "Technical details". */
const hidden = (markup: string) => textOf((markup.match(/<details\b[\s\S]*?<\/details>/g) ?? []).join(" "));

/** The outbox's and the scheduler's vocabulary, which no shown sentence may carry. */
const OUTBOX_JARGON = /[a-z]_[a-z]|\b\d{3}\b|\d+ of \d+|FAILED|outbox|worker|sweep|lease|provider|\bkey\b|\bhttp/i;
/** The machinery a settings screen must not name (A08 acceptance). */
const SETTINGS_JARGON = /\b(sweeps?|workers?|guardrails?|migrations?|outbox)\b|\bthe row\b|\brow currently\b/i;

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

beforeEach(() => {
  admin.rpc.mockReset();
  server.rows = [];
  server.error = null;
});

describe("the lead card's chips: business words shown, codes behind Technical details", () => {
  const base = {
    state: "pending",
    attempts: 0,
    max_attempts: 8,
    next_attempt_at: minutesAgo(-4),
    claimed_until: null,
    last_category: null,
    last_result: null,
    accepted_at: null,
  };
  const esc = (over: Record<string, unknown>) => ({
    ...base,
    id: "job-1",
    first_attempted_at: minutesAgo(20),
    last_attempted_at: minutesAgo(18),
    key_serial: 1,
    ...over,
  });

  const cases: Array<{ name: string; job: Record<string, unknown>; code: string }> = [
    { name: "a refused send", job: { state: "failed", attempts: 1, last_category: "permanent", last_result: "validation_error" }, code: "validation_error" },
    { name: "a send that kept failing", job: { state: "failed", attempts: 8, last_category: "transient", last_result: "503" }, code: "503" },
    { name: "a conflict", job: { state: "failed", attempts: 2, last_category: "conflict", last_result: "invalid_idempotent_request" }, code: "invalid_idempotent_request" },
    { name: "an expired key", job: { state: "failed", attempts: 3, last_category: "timeout", last_result: "key_window_expired" }, code: "key_window_expired" },
    { name: "a backoff", job: { attempts: 2, last_category: "transient", last_result: "503" }, code: "503" },
    { name: "a stuck claim", job: { state: "sending", attempts: 3, claimed_until: minutesAgo(5) }, code: "attempt 3 of 8" },
    { name: "an unworded cancellation", job: { state: "cancelled", last_result: "org_mismatch" }, code: "org_mismatch" },
  ];

  for (const c of cases) {
    it(`desk alert — ${c.name}`, () => {
      const markup = html(createElement(DeskAlertChip, { leadId: "lead-1", job: { ...base, ...c.job } as never }));
      expect(shown(markup)).toMatch(/^Desk alert/);
      expect(shown(markup)).not.toMatch(OUTBOX_JARGON);
      expect(hidden(markup)).toContain(c.code);
      expect(markup).toContain("<summary");
      expect(markup).not.toMatch(/<details[^>]*\sopen/);
    });

    it(`escalation — ${c.name}, as an admin and as an agent`, () => {
      for (const isAdmin of [true, false]) {
        const markup = html(createElement(EscalationChip, { job: esc(c.job) as never, isAdmin }));
        expect(shown(markup)).toMatch(/^Escalation/);
        expect(shown(markup), `isAdmin=${isAdmin}`).not.toMatch(OUTBOX_JARGON);
        expect(hidden(markup)).toContain(c.code);
      }
    });
  }

  it("the escalation's controls are business words too, and an agent gets none", () => {
    const conflict = esc({ state: "failed", attempts: 2, last_category: "conflict", last_result: "invalid_idempotent_request" });
    const adminView = shown(html(createElement(EscalationChip, { job: conflict as never, isAdmin: true })));
    expect(adminView).toContain("Send a new copy…");
    expect(adminView).not.toMatch(/resend|under a new key/i);
    expect(shown(html(createElement(EscalationChip, { job: conflict as never, isAdmin: false })))).not.toContain("Send a new copy");
    const plain = esc({ state: "failed", attempts: 1, last_category: "permanent", last_result: "validation_error" });
    expect(shown(html(createElement(EscalationChip, { job: plain as never, isAdmin: true })))).toContain("Retry escalation");
  });

  it("a queued alert or escalation shows no disclosure at all — there is nothing to add", () => {
    expect(html(createElement(DeskAlertChip, { leadId: "lead-1", job: base as never }))).not.toContain("<details");
    expect(html(createElement(EscalationChip, { job: esc({}) as never, isAdmin: true }))).not.toContain("<details");
  });
});

describe("the route error boundaries", () => {
  const error = Object.assign(new Error("Query failed (deals list): permission denied for table deals"), { digest: "4011228859" });

  for (const [name, Boundary] of [
    ["app/(app)/error.tsx", AppError],
    ["app/(app)/properties/error.tsx", PropertiesError],
  ] as const) {
    it(`${name}: a business sentence in an alert, the digest to quote, the raw message only in details`, () => {
      const markup = html(createElement(Boundary, { error, retry: () => {} }));
      expect(markup).toMatch(/<div role="alert"[^>]*><h1[^>]*>This page could not load<\/h1>/);
      expect(shown(markup)).toContain("Try again. If it keeps happening, tell an admin and quote reference 4011228859.");
      expect(shown(markup)).not.toMatch(/Query failed|permission denied|Something went wrong|Couldn/);
      expect(hidden(markup)).toContain("Query failed (deals list): permission denied for table deals");
      expect(markup).toMatch(/<button[^>]*>.*Try again<\/button>/);
    });
  }

  it("with no digest (a client-side error) it asks for no reference, and an empty message adds no details", () => {
    const markup = html(createElement(AppError, { error: new Error(""), retry: () => {} }));
    expect(shown(markup)).toContain("Try again. If it keeps happening, tell an admin.");
    expect(markup).not.toContain("reference");
    expect(markup).not.toContain("<details");
  });

  it("Try again re-fetches: both boundaries hand Next's retry to the button, not reset", () => {
    for (const f of ["app/(app)/error.tsx", "app/(app)/properties/error.tsx"]) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).toMatch(/retry=\{retry\}/);
      expect(src, f).not.toMatch(/\breset\b/);
    }
  });
});

describe("the dashboard's background-jobs line", () => {
  const ok = (jobname: string, schedule = "0 3 * * *") => ({
    jobname,
    schedule,
    active: true,
    last_start: minutesAgo(30),
    last_status: "succeeded",
    last_success: minutesAgo(30),
  });
  const SCHEDULES: Record<string, string> = {
    "lead-sla": "*/10 * * * *",
    "enquiry-alerts": "*/2 * * * *",
    "lead-escalation": "*/5 * * * *",
    "verify-events-chain-full": "35 3 * * 0",
    "ensure-events-partitions": "20 3 1 * *",
  };
  const allJobs = () => Object.keys(CRON_JOB_LABELS).map((n) => ok(n, SCHEDULES[n]));
  const sweepOk = {
    last_queued_at: minutesAgo(1),
    last_ok_at: minutesAgo(1),
    last_outcome: "ok",
    last_resolved_at: minutesAgo(1),
    consecutive_failures: 0,
    queued_unresolved: 0,
    runs_last_hour: 30,
    overdue_jobs: 0,
    oldest_overdue_minutes: null,
    pending_jobs: 0,
  };
  const answer = (jobs: unknown[], sweep: unknown = sweepOk) =>
    admin.rpc.mockImplementation(async (name: string) =>
      name === "cron_health" ? { data: jobs, error: null } : { data: [sweep], error: null },
    );
  const render = async () => html((await CronHealth()) as ReactElement);

  it("all running: one sentence, nothing technical", async () => {
    answer(allJobs());
    const markup = await render();
    expect(shown(markup)).toBe(`Background jobs: all ${EXPECTED_CRON_JOBS} running.`);
    expect(markup).not.toContain("<details");
  });

  it("a failing job is named by its work; the pg_cron name and the verdict are details", async () => {
    const jobs = allJobs().map((j) =>
      j.jobname === "expire-mandates" ? { ...j, last_success: null, last_status: "failed" } : j,
    );
    answer(jobs, { ...sweepOk, last_outcome: "unconfigured" });
    const markup = await render();
    expect(shown(markup)).toBe(
      `Background jobs: 2 of ${EXPECTED_CRON_JOBS} need attention — Mandate expiry, Website enquiry e-mails.`,
    );
    expect(shown(markup)).not.toMatch(/expire-mandates|enquiry-alerts|never succeeded|pg_cron|sweep|worker/);
    expect(hidden(markup)).toContain("expire-mandates: never succeeded (last run: failed)");
    expect(hidden(markup)).toContain("enquiry-alerts: provider unconfigured");
  });

  it("a job missing from the scheduler is named as not scheduled", async () => {
    answer(allJobs().filter((j) => j.jobname !== "lead-escalation"));
    const markup = await render();
    expect(shown(markup)).toBe("Background jobs: Unanswered-enquiry escalations is not scheduled.");
    expect(hidden(markup)).toContain("lead-escalation: not in pg_cron");
    expect(hidden(markup)).toContain(`expected ${EXPECTED_CRON_JOBS} jobs, found ${EXPECTED_CRON_JOBS - 1}`);
  });

  it("an unreadable status is its own warning, never a pass — the error is a detail", async () => {
    admin.rpc.mockResolvedValue({ data: null, error: { message: "permission denied for function cron_health" } });
    const markup = await render();
    expect(shown(markup)).toBe("Background jobs: their status could not be checked.");
    expect(hidden(markup)).toContain("permission denied for function cron_health");
  });

  it("names exactly the jobs the migrations schedule — a new job without a name fails here", () => {
    const names = new Set<string>();
    const dir = join(root, "supabase", "migrations");
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f))) {
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/cron\.schedule\('([a-z-]+)'/g)) names.add(m[1]!);
    }
    expect(Object.keys(CRON_JOB_LABELS).sort()).toEqual([...names].sort());
    expect(Object.keys(CRON_JOB_LABELS)).toHaveLength(EXPECTED_CRON_JOBS);
    for (const [jobname, label] of Object.entries(CRON_JOB_LABELS)) {
      // a sentence-case name, never a job name of its own (kebab-case) or a code
      expect(label, jobname).toMatch(/^[A-Z][a-z]/);
      expect(label, jobname).not.toMatch(/_|^[a-z]+(?:-[a-z]+)+$/);
      expect(Object.keys(CRON_JOB_LABELS), jobname).not.toContain(label);
    }
    expect(cronJobLabel("toString")).toBe("toString");
    expect(cronJobLabel("some-new-job")).toBe("some-new-job");
  });
});

describe("Settings → Cyprus config", () => {
  const row = (key: string, description: string | null) => ({
    key,
    value: { a: 1 },
    description,
    verified_at: null,
    source_note: null,
  });

  it("heads each known row with a plain title; the key and the stored description sit in details; an unknown key still shows", async () => {
    server.rows = [
      row("nudge_thresholds", "When the nightly sweeps raise chase-up tasks. Editable on Settings → Nudges. Does NOT change how deal health is scored — see 0052."),
      row("transfer_fees", "Department of Lands & Surveys transfer fee bands (progressive, per purchaser share)"),
      row("brand_new_key", "A row a later migration added"),
    ];
    const markup = html((await CyprusConfigSettingsPage()) as ReactElement);
    const seen = shown(markup);
    expect(seen).toContain("Chase-up task timing");
    expect(seen).toContain("Land Registry transfer fees");
    expect(seen).toContain("Easier to change on Settings → Nudges");
    expect(markup).toContain('href="/settings/nudges"');
    expect(seen).not.toMatch(/nudge_thresholds|transfer_fees|nightly sweeps|0052|guardrail/);
    expect(hidden(markup)).toContain("key nudge_thresholds");
    expect(hidden(markup)).toContain("see 0052");
    // the escape hatch stays: every row's JSON editor, the unknown key by its key
    expect(markup.match(/<textarea/g)).toHaveLength(3);
    expect(seen).toContain("brand_new_key");
    expect(seen).toContain("A row a later migration added");
    // the page's own copy
    expect(seen).toContain("every save is recorded in the event log");
    expect(textOf(markup.replace(/<details\b[\s\S]*?<\/details>/g, "").replace(/<textarea\b[\s\S]*?<\/textarea>/g, "").replace("A row a later migration added", ""))).not.toMatch(SETTINGS_JARGON);
  });

  it("a failed read is the error boundary, not an empty page that looks like no settings", async () => {
    server.rows = null;
    server.error = { message: "permission denied for table cyprus_config" };
    await expect(CyprusConfigSettingsPage()).rejects.toThrow(/cyprus_config/);
    server.rows = null;
    server.error = null;
    await expect(CyprusConfigSettingsPage()).rejects.toThrow(/held no rows/);
  });

  it("labels every key the migrations seed, with no machinery in the words", () => {
    const seeded = new Set<string>();
    const dir = join(root, "supabase", "migrations");
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f))) {
      const sql = readFileSync(join(dir, f), "utf8");
      // to the insert's `on conflict` — a stored description may hold a semicolon
      for (const block of sql.matchAll(/insert into (?:public\.)?cyprus_config\b[\s\S]*?\bon conflict\b/g)) {
        // a row's key opens its tuple: `values ('key', …` or, for the next rows, `('key', …` at a line's start
        for (const m of block[0].matchAll(/values\s*\(\s*'([a-z_]+)'|^\('([a-z_]+)'/gm)) seeded.add((m[1] ?? m[2])!);
      }
    }
    expect(seeded.size, "the scanner must find the seeded rows").toBeGreaterThanOrEqual(10);
    // every seeded row has a label, and no label is for a row nothing seeds
    expect([...seeded].sort()).toEqual(Object.keys(CONFIG_LABELS).sort());
    for (const key of seeded) expect(configLabel(key), key).not.toBeNull();
    for (const label of Object.values(CONFIG_LABELS)) {
      expect(`${label.title} ${label.summary}`).not.toMatch(SETTINGS_JARGON);
      expect(`${label.title} ${label.summary}`).not.toMatch(/[a-z]_[a-z]/);
    }
    expect(configLabel("toString")).toBeNull();
  });
});

describe("the escalation, routing and nudge panels name no machinery", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const members = [
    { id: A, full_name: "Active Admin", role: "admin", is_active: true },
    { id: B, full_name: "Gone Agent", role: "agent", is_active: false },
  ];

  it("Lead escalation, with values set outside the form and an inactive recipient", () => {
    const markup = html(
      createElement(LeadEscalationPanel, {
        value: {
          enabled: true,
          after_minutes: 5000,
          max_age_hours: 9000,
          recipients: [A, B],
          working_hours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
          timezone: "Asia/Nicosia",
        },
        members,
      }),
    );
    const seen = shown(markup);
    expect(seen).toContain("the stored value is 5000 minutes, changed outside this form — the check uses it");
    expect(seen).toContain("the stored value is 9000 hours, changed outside this form — the check uses it");
    expect(seen).toContain("Gone Agent was chosen but is now inactive — the check skips them, and saving removes them.");
    expect(seen).not.toMatch(SETTINGS_JARGON);
    expect(seen).not.toMatch(/provider/i);
  });

  it("the activation preview", () => {
    const preview = readLeadEscalationPreview({
      evaluated_at: "2026-09-28T06:20:00+00:00",
      evaluated_as_enabled: true,
      stored_enabled: false,
      policy: { enabled: true, after_minutes: 15, max_age_hours: 48, recipients: [], working_hours: null, timezone: "Asia/Nicosia" },
      recipients: [
        { id: A, full_name: "Active Admin", role: "admin", is_active: true, has_email: true, eligible: true, reason: "ok" },
        { id: B, full_name: "Gone Agent", role: "agent", is_active: false, has_email: true, eligible: false, reason: "inactive" },
      ],
      eligible_recipient_count: 1,
      counts: { considered: 2, due: 2, would_send: 1, no_recipient: 1, only_recipient_is_assignee: 0, not_yet_due: 0, past_cutoff: 0, already_escalated: 0 },
      leads: [
        { lead_id: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", received_at: "2026-09-25T19:00:00+00:00", due_at: "2026-09-28T06:15:00+00:00", verdict: "due", status: "new", assignee_id: null, assignee_name: null, property_ref: null, recipients_eligible: 1, only_recipient_is_assignee: false, job_state: null },
        { lead_id: "7f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", received_at: "2026-09-25T19:00:00+00:00", due_at: "2026-09-28T06:15:00+00:00", verdict: "due", status: "new", assignee_id: null, assignee_name: null, property_ref: null, recipients_eligible: 0, only_recipient_is_assignee: false, job_state: null },
      ],
      truncated: false,
      limit: 50,
    });
    expect(preview).not.toBeNull();
    const markup = html(
      createElement(LeadEscalationPreviewCard, { preview: preview!, sender: { state: "domain_verified", domain: "example.invalid" }, stale: false }),
    );
    const seen = shown(markup);
    expect(seen).toContain("enquiries that would be escalated");
    expect(seen).toContain("e-mails that would be sent");
    expect(seen).toContain("due, but no e-mail would go out");
    expect(seen).toContain("inactive — the check skips them");
    expect(seen).not.toMatch(SETTINGS_JARGON);
    expect(seen).not.toMatch(/minted|no_recipient/);
    // nobody ticked
    const none = html(
      createElement(LeadEscalationPreviewCard, {
        preview: { ...preview!, recipients: [] },
        sender: { state: "domain_verified", domain: "example.invalid" },
        stale: false,
      }),
    );
    expect(shown(none)).toContain("Nobody is ticked — every due enquiry would be cancelled, with nobody to tell.");
    expect(shown(none)).not.toMatch(/no_recipient/);
    // every sender answer the card can show (sender-readiness.ts's words) — the
    // environment's variable names stay: they are what the deployer must set
    const senders: SenderReadiness[] = [
      { state: "not_configured", missing: ["RESEND_API_KEY is not set", "ENQUIRY_ALERT_TO is not set"] },
      { state: "invalid_from" },
      { state: "key_rejected" },
      { state: "test_sender", fromSet: false, domain: "resend.dev" },
      { state: "custom_unverified", domain: "example.invalid", evidence: "lookup_failed" },
      { state: "custom_not_verified", domain: "example.invalid", providerStatus: "pending" },
    ];
    for (const sender of senders) {
      const seenWith = shown(html(createElement(LeadEscalationPreviewCard, { preview: preview!, sender, stale: false })));
      expect(seenWith, sender.state).not.toMatch(SETTINGS_JARGON);
      expect(seenWith, sender.state).toContain("e-mails that would be sent");
    }
  });

  it("Lead routing and Nudges", () => {
    const routing = shown(html(createElement(LeadRoutingPanel, { value: { mode: "round_robin", agents: [A] }, members })));
    expect(routing).toContain("the CRM adds a follow-up task within ten minutes");
    expect(routing).not.toMatch(SETTINGS_JARGON);
    const nudges = shown(html(createElement(NudgeThresholdsPanel, { values: { ...NUDGE_DEFAULTS, deal_no_contact_days: 400 } })));
    expect(nudges).toContain("When the CRM raises chase-up tasks.");
    expect(nudges).toContain("it was set on the Cyprus config page. The nightly checks are using it.");
    expect(nudges).not.toMatch(SETTINGS_JARGON);
    expect(nudges).not.toMatch(/nudge_thresholds/);
  });
});
