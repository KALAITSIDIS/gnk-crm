import { describe, expect, it } from "vitest";
import { escalationStatus, type EscalationJob } from "./lead-escalation-status";

/**
 * What the inbox says about a website lead's escalation (0107, recovery
 * 0111), from its `notification_jobs` row. Pure, so the wording — the one
 * place a colleague learns that nobody else was told either, or that a
 * decision is an admin's — is pinned without rendering anything. The
 * recovery offered here is the one the database would admit for the same
 * row (request_lead_escalation_recovery); the function refuses the other.
 */
const now = new Date("2026-09-22T10:00:00Z");
const at = (minutesBefore: number) => new Date(now.getTime() - minutesBefore * 60_000).toISOString();

const job = (over: Partial<EscalationJob> = {}): EscalationJob => ({
  id: "job-1",
  state: "pending",
  attempts: 0,
  max_attempts: 8,
  next_attempt_at: at(0),
  claimed_until: null,
  last_category: null,
  last_result: null,
  accepted_at: null,
  first_attempted_at: null,
  last_attempted_at: null,
  key_serial: 1,
  ...over,
});

describe("escalationStatus", () => {
  it("a lead with no escalation row says nothing — nothing was due, or the outbox predates it", () => {
    expect(escalationStatus(null, now)).toBeNull();
    expect(escalationStatus(undefined, now)).toBeNull();
  });

  it("queued, before the first attempt", () => {
    expect(escalationStatus(job(), now)).toEqual({ tone: "neutral", label: "Escalation queued", detail: null, recovery: null });
  });

  it("in flight under a live lease", () => {
    expect(escalationStatus(job({ state: "sending", attempts: 1, claimed_until: at(-1), first_attempted_at: at(0), last_attempted_at: at(0) }), now)).toEqual({
      tone: "neutral",
      label: "Escalation sending…",
      detail: null,
      recovery: null,
    });
  });

  it("backing off after a failed attempt says when it will try again, and offers nothing — the worker owns it", () => {
    expect(
      escalationStatus(
        job({ attempts: 2, last_category: "transient", last_result: "503", next_attempt_at: at(-4), first_attempted_at: at(3), last_attempted_at: at(1) }),
        now,
      ),
    ).toEqual({ tone: "warning", label: "Escalation retrying (2 of 8, last 503)", detail: "next in 4 min · last attempt 1 min ago", recovery: null });
  });

  it("a stale in-flight claim reads as stuck; Retry is offered once the lease has lapsed", () => {
    expect(escalationStatus(job({ state: "sending", attempts: 3, claimed_until: at(5), first_attempted_at: at(30), last_attempted_at: at(7) }), now)).toEqual({
      tone: "warning",
      label: "Escalation stuck (3 of 8)",
      detail: "the worker's lease lapsed 5 min ago — the sweep will pick it up; Retry sends it now under the same key",
      recovery: "retry",
    });
  });

  it("accepted by the provider — and that is the word, not delivered", () => {
    expect(escalationStatus(job({ state: "accepted", attempts: 1, accepted_at: at(13), first_attempted_at: at(13), last_attempted_at: at(13) }), now)).toEqual({
      tone: "success",
      label: "Escalation accepted by the provider",
      detail: "13 min ago — accepted for sending, not a delivery receipt",
      recovery: null,
    });
  });

  it("failed for good with the last word: Retry, under the same key, while the key is safe", () => {
    expect(
      escalationStatus(job({ state: "failed", attempts: 8, last_category: "transient", last_result: "503", first_attempted_at: at(130), last_attempted_at: at(30) }), now),
    ).toEqual({
      tone: "danger",
      label: "Escalation FAILED after 8 attempts (503)",
      detail: "last attempt 30 min ago — Retry sends it again under the same key, which cannot send a second copy",
      recovery: "retry",
    });
    expect(
      escalationStatus(job({ state: "failed", attempts: 1, last_category: "permanent", last_result: "validation_error", first_attempted_at: at(2), last_attempted_at: at(2) }), now),
    ).toMatchObject({ tone: "danger", label: "Escalation FAILED (validation_error)", recovery: "retry" });
    expect(
      escalationStatus(job({ state: "failed", attempts: 8, last_category: "timeout", last_result: "lease_expired", first_attempted_at: at(90), last_attempted_at: at(20) }), now),
    ).toMatchObject({ label: "Escalation FAILED after 8 attempts (lease_expired)", recovery: "retry" });
  });

  it("a conflict needs a decision: the provider holds an earlier version and may already have sent it", () => {
    expect(
      escalationStatus(
        job({ state: "failed", attempts: 2, last_category: "conflict", last_result: "invalid_idempotent_request", first_attempted_at: at(20), last_attempted_at: at(18) }),
        now,
      ),
    ).toEqual({
      tone: "danger",
      label: "Escalation needs a decision",
      detail:
        "the provider holds an earlier version of this e-mail under its key and may already have sent it (last attempt 18 min ago) — review, then resend under a new key",
      recovery: "resend",
    });
  });

  it("the two review words need a decision too — an earlier attempt may have reached the recipients", () => {
    expect(
      escalationStatus(job({ state: "failed", attempts: 3, last_category: "timeout", last_result: "key_window_expired", first_attempted_at: at(21 * 60), last_attempted_at: at(19 * 60) }), now),
    ).toEqual({
      tone: "danger",
      label: "Escalation needs a decision",
      detail:
        "an earlier attempt may have reached the recipients and the provider key has expired (last attempt 19 h ago) — review, then resend under a new key",
      recovery: "resend",
    });
    expect(
      escalationStatus(job({ state: "failed", attempts: 2, last_category: "transient", last_result: "retry_beyond_window", first_attempted_at: at(60), last_attempted_at: at(5) }), now),
    ).toEqual({
      tone: "danger",
      label: "Escalation needs a decision",
      detail: "the provider asked to wait longer than the key stays safe (last attempt 5 min ago) — review, then resend under a new key",
      recovery: "resend",
    });
  });

  it("a plain failure whose key is older than the window is a decision too, by the clock alone", () => {
    expect(
      escalationStatus(job({ state: "failed", attempts: 8, last_category: "transient", last_result: "503", first_attempted_at: at(21 * 60), last_attempted_at: at(18 * 60) }), now),
    ).toEqual({
      tone: "danger",
      label: "Escalation FAILED after 8 attempts (503)",
      detail:
        "last attempt 18 h ago — the provider key has expired, so an earlier attempt may have reached the recipients; review, then resend under a new key",
      recovery: "resend",
    });
  });

  it("cancelled because of the policy is recoverable once the policy is fixed", () => {
    expect(escalationStatus(job({ state: "cancelled", attempts: 1, last_result: "escalation_disabled", first_attempted_at: at(9), last_attempted_at: at(9) }), now)).toEqual({
      tone: "neutral",
      label: "Escalation cancelled",
      detail: "lead escalation was switched off at send time — switch it on under Settings → Lead escalation, then Retry",
      recovery: "retry",
    });
    expect(escalationStatus(job({ state: "cancelled", attempts: 1, last_result: "no_recipient", first_attempted_at: at(9), last_attempted_at: at(9) }), now)).toEqual({
      tone: "neutral",
      label: "Escalation cancelled",
      detail: "nobody eligible to receive it — check the recipients under Settings → Lead escalation, then Retry",
      recovery: "retry",
    });
  });

  it("a policy cancellation whose key has since expired needs a decision, like any expired key", () => {
    expect(
      escalationStatus(job({ state: "cancelled", attempts: 2, last_result: "escalation_disabled", first_attempted_at: at(21 * 60), last_attempted_at: at(20 * 60) }), now),
    ).toEqual({
      tone: "neutral",
      label: "Escalation cancelled",
      detail:
        "lead escalation was switched off at send time — switch it on under Settings → Lead escalation — the provider key has since expired; review, then resend under a new key",
      recovery: "resend",
    });
  });

  it("cancelled because the enquiry was no longer eligible is final, in words", () => {
    const final = (result: string, detail: string) =>
      expect(escalationStatus(job({ state: "cancelled", attempts: 1, last_result: result, first_attempted_at: at(9), last_attempted_at: at(9) }), now)).toEqual({
        tone: "neutral",
        label: "Escalation cancelled",
        detail,
        recovery: null,
      });
    final("lead_answered", "the enquiry was answered first");
    final("lead_closed", "the lead was closed");
    final("lead_redacted", "the enquiry was redacted");
    final("lead_unreadable", "the enquiry could not be read");
    final("org_mismatch", "org_mismatch");
  });
});
