import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALERT_MAX_ATTEMPTS,
  KEY_SAFE_WINDOW_MS,
  PER_JOB_OVERHEAD_MS,
  RETRY_BASE_SECONDS,
  RETRY_CAP_SECONDS,
  alertFromLead,
  idempotencyKeyFor,
  jobsThatFit,
  keyWindowRemainingMs,
  retryAfterSeconds,
  retryDelaySeconds,
  retryFitsKeyWindow,
} from "./enquiry-alert-jobs";

/**
 * The arithmetic and the reconstruction behind the outbox (0101, reviewed
 * 0102), kept pure so a test reaches them without a database or a provider.
 */
describe("the retry schedule", () => {
  it("doubles from a minute and stays inside the provider's 24-hour key memory over the whole budget", () => {
    const delays = Array.from({ length: ALERT_MAX_ATTEMPTS - 1 }, (_, i) => retryDelaySeconds(i + 1, null));
    expect(delays[0]).toBe(RETRY_BASE_SECONDS);
    expect(delays[1]).toBe(RETRY_BASE_SECONDS * 2);
    expect(delays[2]).toBe(RETRY_BASE_SECONDS * 4);
    for (const d of delays) expect(d).toBeLessThanOrEqual(RETRY_CAP_SECONDS);
    const total = delays.reduce((a, b) => a + b, 0);
    expect(total, "every automatic retry reuses one idempotency key, so all of them must fit in 24h").toBeLessThan(
      24 * 3600,
    );
  });

  it("honours a longer Retry-After IN FULL — a retry must never come earlier than the provider asked (review A)", () => {
    expect(retryDelaySeconds(1, 900)).toBe(900);
    expect(retryDelaySeconds(1, 10), "but never shorter than the schedule's own step").toBe(RETRY_BASE_SECONDS);
    expect(retryDelaySeconds(1, 5400), "the old one-hour cap retried before the provider said to").toBe(5400);
    expect(retryDelaySeconds(1, 99_999), "whether such a wait is SAFE is the key window's question, not a cap's").toBe(
      99_999,
    );
  });

  it("treats a nonsense attempt number as the first", () => {
    expect(retryDelaySeconds(0, null)).toBe(RETRY_BASE_SECONDS);
    expect(retryDelaySeconds(-3, null)).toBe(RETRY_BASE_SECONDS);
  });
});

describe("reading Retry-After", () => {
  const now = new Date("2026-09-21T10:00:00Z");
  it("as seconds", () => {
    expect(retryAfterSeconds("120", now)).toBe(120);
  });
  it("as an HTTP date, relative to now", () => {
    expect(retryAfterSeconds("Mon, 21 Sep 2026 10:05:00 GMT", now)).toBe(300);
  });
  it("as nothing useful", () => {
    expect(retryAfterSeconds(null, now)).toBeNull();
    expect(retryAfterSeconds("soon", now)).toBeNull();
    expect(retryAfterSeconds("-5", now)).toBeNull();
    expect(retryAfterSeconds("Mon, 21 Sep 2026 09:00:00 GMT", now), "a date in the past").toBeNull();
  });
});

describe("the provider key", () => {
  it("is the job and its serial, so a retry inside the window reuses it and a rotation changes it", () => {
    expect(idempotencyKeyFor({ id: "8f1c2d3e-0000-4000-8000-000000000001", key_serial: 1 })).toBe(
      "enquiry-desk-alert/8f1c2d3e-0000-4000-8000-000000000001/1",
    );
    expect(idempotencyKeyFor({ id: "8f1c2d3e-0000-4000-8000-000000000001", key_serial: 2 })).toBe(
      "enquiry-desk-alert/8f1c2d3e-0000-4000-8000-000000000001/2",
    );
  });
});

/**
 * THE KEY WINDOW (review A). Resend remembers a key for 24 hours; after that a
 * retry under the same key is a second e-mail if the first was accepted and
 * its answer lost. The window is the ONE number both halves agree on: the
 * migration's `notification_key_window()` closes such rows at the claim, and
 * this module refuses to send or to schedule past it.
 */
describe("the provider's key window", () => {
  const now = new Date("2026-09-21T10:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

  it("is shorter than the provider's 24 hours, and is the migration's number to the hour", () => {
    expect(KEY_SAFE_WINDOW_MS).toBeLessThan(24 * 3_600_000);
    const sql = readFileSync(
      join(__dirname, "..", "..", "supabase", "migrations", "0102_enquiry_alert_key_window.sql"),
      "utf-8",
    );
    const m = /create or replace function public\.notification_key_window\(\)[\s\S]*?select interval '(\d+) hours'/.exec(sql);
    expect(m, "the migration defines notification_key_window() as N hours").not.toBeNull();
    expect(KEY_SAFE_WINDOW_MS, "TS and SQL must carry the same window").toBe(Number(m![1]) * 3_600_000);
  });

  it("counts from the FIRST attempt, never from creation: a never-attempted job has no window running", () => {
    expect(keyWindowRemainingMs({ first_attempted_at: null }, now)).toBeNull();
    expect(keyWindowRemainingMs({ first_attempted_at: ago(19) }, now)).toBe(3_600_000);
    expect(keyWindowRemainingMs({ first_attempted_at: ago(25) }, now)).toBeLessThan(0);
  });

  it("a retry fits when it would land inside the window, and not otherwise", () => {
    expect(retryFitsKeyWindow({ first_attempted_at: null }, 99_999, now), "nothing was ever presented").toBe(true);
    expect(retryFitsKeyWindow({ first_attempted_at: ago(19) }, 3_599, now)).toBe(true);
    expect(retryFitsKeyWindow({ first_attempted_at: ago(19) }, 3_601, now)).toBe(false);
    expect(retryFitsKeyWindow({ first_attempted_at: ago(25) }, 1, now)).toBe(false);
  });
});

/**
 * THE BUDGET (review B). A sweep is one invocation with a wall-clock limit;
 * it may claim only what it can finish, provider timeout plus round trips.
 */
describe("what fits a run's budget", () => {
  it("is the budget over one send's worst case plus its round trips, rounded down", () => {
    expect(jobsThatFit(45_000, 8_000)).toBe(Math.floor(45_000 / (8_000 + PER_JOB_OVERHEAD_MS)));
    expect(jobsThatFit(45_000, 8_000)).toBe(4);
    expect(jobsThatFit(9_000, 8_000), "less than one worst case: claim nothing").toBe(0);
    expect(jobsThatFit(0, 8_000)).toBe(0);
    expect(jobsThatFit(-5, 8_000)).toBe(0);
  });
});

/**
 * The e-mail is rebuilt from the LEAD, not from a stored copy — the row holds
 * no person, and a redacted lead therefore has nothing to send. The block is
 * the one submit_public_enquiry writes (0084 … 0101).
 */
describe("rebuilding the alert from the lead", () => {
  const message = [
    "Website enquiry",
    "Name: A Buyer",
    "Email: buyer@example.invalid",
    "Phone: +357 99 123456",
    "About: PAF0001 (no published listing with that reference)",
    "",
    "Is it still available?",
    "Second line of the question.",
  ].join("\n");

  it("takes the person, the typed reference and the visitor's own words", () => {
    const a = alertFromLead({
      message,
      criteria: { channel: "website_form", listing_reference: null, budget: "over_1m", utm_source: "instagram" },
    });
    expect(a).toEqual({
      name: "A Buyer",
      email: "buyer@example.invalid",
      phone: "+357 99 123456",
      propertyReference: "PAF0001",
      message: "Is it still available?\nSecond line of the question.",
      meta: { budget: "over_1m", utm_source: "instagram" },
    });
  });

  it("carries only allowlisted meta — never the function's own keys, never a stray one", () => {
    const a = alertFromLead({
      message,
      criteria: { channel: "website_form", listing_reference: "PAF0001", email: "x@y.invalid", source_page: "/contact" },
    });
    expect(a!.meta).toEqual({ source_page: "/contact" });
  });

  it("has no message when the visitor typed none, and no meta when criteria is not an object", () => {
    const a = alertFromLead({ message: "Website enquiry\nName: Only Ref\nPhone: +357 1\nAbout: PAF0002\n", criteria: null });
    expect(a).toEqual({
      name: "Only Ref",
      email: null,
      phone: "+357 1",
      propertyReference: "PAF0002",
      message: null,
      meta: null,
    });
  });

  it("is nothing for a redacted lead, a desk-typed lead, or no message at all", () => {
    expect(alertFromLead({ message: "[erased at the contact's request]", criteria: {} })).toBeNull();
    expect(alertFromLead({ message: "Called about the villa", criteria: {} })).toBeNull();
    expect(alertFromLead({ message: null, criteria: {} })).toBeNull();
  });

  it("is nothing for an ambiguous header — an injected address never becomes the alert's Reply-To", () => {
    // T-enquiry-identity-single-line, the audit's case A as the door stored it
    // before 0114: the old reader handed the worker other@x.invalid, and the
    // desk's reply went to whoever that is. Null → the worker cancels the job
    // `lead_unreadable`, which the inbox chip shows; the lead stays in the inbox.
    const caseA = [
      "Website enquiry",
      "Name: Example Buyer",
      "Email: buyer@example.invalid",
      "Phone: +35799123456",
      "Email: other@x.invalid",
      "",
      "Please contact me.",
    ].join("\n");
    expect(alertFromLead({ message: caseA, criteria: {} })).toBeNull();
  });

  it("takes the header's e-mail, not a header-shaped line in the visitor's words", () => {
    const a = alertFromLead({
      message: "Website enquiry\nName: A Buyer\nEmail: buyer@example.invalid\n\nEmail: decoy@example.invalid\nPhone: 000",
      criteria: {},
    });
    expect(a).toMatchObject({ email: "buyer@example.invalid", phone: null, message: "Email: decoy@example.invalid\nPhone: 000" });
  });
});

describe("the escalation's key (0107)", () => {
  it("is prefixed by its kind, so the two messages a lead can produce never share a provider key", () => {
    const id = "8f1c2d3e-0000-4000-8000-000000000001";
    expect(idempotencyKeyFor({ id, key_serial: 1, kind: "lead_escalation" })).toBe(`lead-escalation/${id}/1`);
    expect(idempotencyKeyFor({ id, key_serial: 1, kind: "enquiry_desk_alert" })).toBe(`enquiry-desk-alert/${id}/1`);
    expect(idempotencyKeyFor({ id, key_serial: 1 }), "no kind reads as the desk alert — the shape every caller before 0107 passed").toBe(
      `enquiry-desk-alert/${id}/1`,
    );
  });
});
