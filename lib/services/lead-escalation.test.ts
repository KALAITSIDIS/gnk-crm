import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEAD_ESCALATION_DEFAULTS,
  escalationBodyFor,
  escalationFromLead,
  escalationIneligibility,
  escalationRecipients,
  escalationSubjectFor,
  readLeadEscalation,
  sendLeadEscalation,
} from "./lead-escalation";

/**
 * 0107: the pure half of the lead escalation. The reader's table below is
 * THE SAME TABLE 0107's assertion block runs against
 * `public.lead_escalation_config()` in SQL — if one changes, both must. The
 * eligibility and recipient rules are pinned here because the worker
 * applies them at the moment of sending, and a colleague chased about an
 * enquiry that was answered a minute ago is the failure this exists to
 * prevent.
 */
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

describe("the policy reader mirrors lead_escalation_config() rule for rule", () => {
  it("nonsense, a missing row and wrong types land on the defaults", () => {
    const off = { ...LEAD_ESCALATION_DEFAULTS, recipients: [] };
    expect(readLeadEscalation(null)).toEqual(off);
    expect(readLeadEscalation([])).toEqual(off);
    expect(readLeadEscalation("on")).toEqual(off);
    expect(
      readLeadEscalation({
        enabled: "yes",
        after_minutes: 0,
        max_age_hours: -1,
        recipients: ["nope", 7],
        working_hours: { days: [8], start: "25:00", end: "18:00" },
        timezone: "Mars/Olympus",
      }),
    ).toEqual(off);
  });

  it("keeps a valid policy, de-duplicates and sorts", () => {
    expect(
      readLeadEscalation({
        enabled: true,
        after_minutes: 30,
        max_age_hours: 24,
        recipients: [A, A, B],
        working_hours: { days: [5, 1, 1], start: "08:30", end: "17:00" },
        timezone: "Europe/Athens",
      }),
    ).toEqual({
      enabled: true,
      after_minutes: 30,
      max_age_hours: 24,
      recipients: [A, B],
      working_hours: { days: [1, 5], start: "08:30", end: "17:00" },
      timezone: "Europe/Athens",
    });
  });

  it("the SQL bounds, not the form's: 1..1440 minutes and 1..720 hours are kept, beyond that the default", () => {
    expect(readLeadEscalation({ after_minutes: 1 }).after_minutes).toBe(1);
    expect(readLeadEscalation({ after_minutes: 1440 }).after_minutes).toBe(1440);
    expect(readLeadEscalation({ after_minutes: 1441 }).after_minutes).toBe(15);
    expect(readLeadEscalation({ after_minutes: 12.5 }).after_minutes).toBe(15);
    expect(readLeadEscalation({ after_minutes: "20" }).after_minutes).toBe(20);
    expect(readLeadEscalation({ max_age_hours: 720 }).max_age_hours).toBe(720);
    expect(readLeadEscalation({ max_age_hours: 721 }).max_age_hours).toBe(48);
  });

  it("working hours: start must precede end, days must be ISO 1..7 and at least one — otherwise around the clock", () => {
    expect(readLeadEscalation({ working_hours: { days: [1], start: "18:00", end: "09:00" } }).working_hours).toBeNull();
    expect(readLeadEscalation({ working_hours: { days: [0, 8], start: "09:00", end: "18:00" } }).working_hours).toBeNull();
    expect(readLeadEscalation({ working_hours: { days: [], start: "09:00", end: "18:00" } }).working_hours).toBeNull();
    expect(readLeadEscalation({ working_hours: null }).working_hours).toBeNull();
    expect(readLeadEscalation({ working_hours: { days: [6, 7], start: "10:00", end: "14:00" } }).working_hours).toEqual({
      days: [6, 7],
      start: "10:00",
      end: "14:00",
    });
  });
});

describe("eligibility at the moment of sending", () => {
  const open = { status: "new", first_response_at: null, message: "Website enquiry\nName: A Buyer\nEmail: a@example.invalid\n\nHi" };
  it("an open, unanswered, readable website lead is still eligible", () => {
    expect(escalationIneligibility(open)).toBeNull();
  });
  it("answered, closed, redacted and unreadable each stop it, redaction first", () => {
    expect(escalationIneligibility({ ...open, first_response_at: "2026-09-22T10:00:00Z" })).toBe("lead_answered");
    expect(escalationIneligibility({ ...open, status: "lost" })).toBe("lead_closed");
    expect(escalationIneligibility({ ...open, status: "converted" })).toBe("lead_closed");
    expect(escalationIneligibility({ ...open, message: "[erased at the contact's request]", first_response_at: "x" })).toBe("lead_redacted");
    expect(escalationIneligibility({ ...open, message: "typed by the desk" })).toBe("lead_unreadable");
  });
  it("an ambiguous header is unreadable too — a colleague is never chased with an injected address", () => {
    // T-enquiry-identity-single-line: the audit's case B as the door stored it before 0114
    const caseB = "Website enquiry\nName: Example\nextra\nextra\nextra\nextra\nEmail: buyer@example.invalid\nPhone: +35799123456\n\nPlease contact me.";
    expect(escalationIneligibility({ ...open, message: caseB })).toBe("lead_unreadable");
    expect(
      escalationFromLead({ message: caseB, received_at: "2026-09-22T10:00:00Z" }, { assigneeName: null, waitMeasuredAt: new Date("2026-09-22T11:00:00Z") }),
    ).toBeNull();
  });
});

describe("who is told", () => {
  const cfg = { recipients: [A, B, C] };
  const lead = { org_id: "org-1", assigned_agent_id: A };
  const p = (id: string, over: Partial<{ org_id: string; email: string | null; role: string; is_active: boolean }> = {}) => ({
    id,
    org_id: "org-1",
    email: `${id.slice(0, 8)}@example.invalid`,
    role: "agent",
    is_active: true,
    ...over,
  });

  it("never the lead's assignee — the escalation is for somebody else", () => {
    expect(escalationRecipients(cfg, [p(A), p(B)], lead)).toEqual(["22222222@example.invalid"]);
  });
  it("only active admins and agents of the lead's own organisation, and only those the policy names", () => {
    expect(escalationRecipients(cfg, [p(B, { is_active: false })], lead)).toEqual([]);
    expect(escalationRecipients(cfg, [p(B, { role: "listing_manager" })], lead)).toEqual([]);
    expect(escalationRecipients(cfg, [p(B, { org_id: "org-2" })], lead)).toEqual([]);
    expect(escalationRecipients({ recipients: [C] }, [p(B)], lead)).toEqual([]);
    expect(escalationRecipients(cfg, [p(B, { email: " " })], lead)).toEqual([]);
    expect(escalationRecipients(cfg, [p(B, { role: "admin" }), p(C)], lead)).toEqual(["22222222@example.invalid", "33333333@example.invalid"]);
  });
  it("an unassigned lead may go to every named colleague", () => {
    expect(escalationRecipients(cfg, [p(A), p(B)], { ...lead, assigned_agent_id: null })).toHaveLength(2);
  });
});

describe("what the colleague reads", () => {
  const waitMeasuredAt = new Date("2026-09-22T10:20:00Z");
  const lead = {
    message: ["Website enquiry", "Name: A Buyer", "Email: buyer@example.invalid", "Phone: +357 99 000000", "About: PAF0001", "", "Still available?"].join("\n"),
    received_at: "2026-09-22T10:02:30Z",
    properties: { reference: "PAF0001" },
  };

  it("is rebuilt from the lead: the wait in whole minutes, the assignee, the enquirer, the message, one link", () => {
    const e = escalationFromLead(lead, { assigneeName: "Nontas", waitMeasuredAt });
    expect(e).not.toBeNull();
    expect(e!.waitingMinutes).toBe(17);
    expect(escalationSubjectFor(e!)).toBe("Unanswered website enquiry — PAF0001 — waiting 17 min");
    const body = escalationBodyFor(e!);
    expect(body).toContain("A Buyer enquired through the website 17 minutes ago");
    expect(body).toContain("Assigned to:  Nontas");
    expect(body).toContain("buyer@example.invalid");
    expect(body).toContain("+357 99 000000");
    expect(body).toContain("Still available?");
    expect(body).toMatch(/\/leads/);
  });

  it("counts the wait to the instant it is given — the first attempt under the key — not to the clock", () => {
    const later = new Date("2026-09-22T12:00:00Z");
    expect(escalationFromLead(lead, { assigneeName: null, waitMeasuredAt })!.waitingMinutes).toBe(17);
    expect(escalationFromLead(lead, { assigneeName: null, waitMeasuredAt: later })!.waitingMinutes).toBe(117);
  });

  it("says so when the lead is unclaimed, and when the enquirer typed no message", () => {
    const e = escalationFromLead({ ...lead, message: "Website enquiry\nName: Quiet Buyer\nPhone: +357 99 1" }, { assigneeName: null, waitMeasuredAt });
    const body = escalationBodyFor(e!);
    expect(body).toContain("nobody — the enquiry is unclaimed");
    expect(body).toContain("(no message)");
    expect(body).not.toContain("Email:");
  });

  it("is null for anything that is not a website enquiry block", () => {
    expect(escalationFromLead({ ...lead, message: "typed by the desk" }, { assigneeName: null, waitMeasuredAt })).toBeNull();
    expect(escalationFromLead({ ...lead, message: null }, { assigneeName: null, waitMeasuredAt })).toBeNull();
  });
});

describe("the provider call", () => {
  const OLD = { ...process.env };
  const e = { name: "A Buyer", email: "buyer@example.invalid", phone: null, propertyReference: "PAF0001", message: "Hi", assigneeName: null, waitingMinutes: 16 };
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...OLD };
  });

  it("skips without a provider key, and never calls out", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await sendLeadEscalation(e, { to: ["x@example.invalid"] })).toEqual({ outcome: "skipped" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends to the named colleagues under the job's key, replying to the enquirer, and reads the provider's answer in the outbox's words", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await sendLeadEscalation(e, { to: ["a@example.invalid", "b@example.invalid"], idempotencyKey: "lead-escalation/job-1/1" });
    expect(result).toEqual({ outcome: "accepted", providerMessageId: "msg_1" });
    const [, init] = fetchSpy.mock.calls[0]! as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("lead-escalation/job-1/1");
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.to).toEqual(["a@example.invalid", "b@example.invalid"]);
    expect(sent.reply_to).toBe("buyer@example.invalid");
    expect(String(sent.subject)).toContain("Unanswered website enquiry");
  });

  it("a provider refusal is classified exactly as the desk alert's", async () => {
    process.env.RESEND_API_KEY = "re_test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ name: "rate_limit_exceeded" }), { status: 429, headers: { "retry-after": "30" } })));
    expect(await sendLeadEscalation(e, { to: ["a@example.invalid"] })).toEqual({
      outcome: "failed",
      category: "transient",
      result: "rate_limit_exceeded",
      retryAfterSeconds: 30,
    });
  });

  it("refuses to send to nobody, permanently — the worker cancels before this, and this is the last line", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await sendLeadEscalation(e, { to: [] })).toMatchObject({ outcome: "failed", category: "permanent", result: "no_recipient" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
