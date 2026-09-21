import { describe, expect, it } from "vitest";
import { deskAlertStatus, type DeskAlertJob } from "./enquiry-alert-status";

/**
 * What the inbox says about a website lead's desk alert (0101), from the
 * `notification_jobs` row. Pure, so the wording — the one place a person
 * learns that nobody was told — is pinned without rendering anything.
 */
const now = new Date("2026-09-21T10:00:00Z");

const job = (over: Partial<DeskAlertJob> = {}): DeskAlertJob => ({
  state: "pending",
  attempts: 0,
  max_attempts: 8,
  next_attempt_at: "2026-09-21T10:00:00Z",
  claimed_until: null,
  last_category: null,
  last_result: null,
  accepted_at: null,
  ...over,
});

describe("deskAlertStatus", () => {
  it("a lead the outbox predates says nothing", () => {
    expect(deskAlertStatus(null, now)).toBeNull();
  });

  it("queued, before the first attempt", () => {
    expect(deskAlertStatus(job(), now)).toEqual({ tone: "neutral", label: "Desk alert queued", canRetry: false });
  });

  it("in flight", () => {
    expect(deskAlertStatus(job({ state: "sending", attempts: 1, claimed_until: "2026-09-21T10:01:00Z" }), now)).toEqual({
      tone: "neutral",
      label: "Desk alert sending…",
      canRetry: false,
    });
  });

  it("backing off after a failed attempt, saying when it will try again", () => {
    expect(
      deskAlertStatus(
        job({ attempts: 2, last_category: "transient", last_result: "503", next_attempt_at: "2026-09-21T10:04:00Z" }),
        now,
      ),
    ).toEqual({ tone: "warning", label: "Desk alert retrying (2 of 8, last 503) — next in 4 min", canRetry: false });
  });

  it("accepted by the provider — and that is the word, not delivered", () => {
    expect(deskAlertStatus(job({ state: "accepted", attempts: 1, accepted_at: "2026-09-21T09:59:00Z" }), now)).toEqual({
      tone: "success",
      label: "Desk alerted",
      canRetry: false,
    });
  });

  it("failed for good, with the last word and the retry offered", () => {
    expect(
      deskAlertStatus(job({ state: "failed", attempts: 8, last_category: "transient", last_result: "503" }), now),
    ).toEqual({ tone: "danger", label: "Desk alert FAILED after 8 attempts (503)", canRetry: true });
    expect(
      deskAlertStatus(job({ state: "failed", attempts: 1, last_category: "permanent", last_result: "validation_error" }), now),
    ).toEqual({ tone: "danger", label: "Desk alert FAILED (validation_error)", canRetry: true });
  });

  it("cancelled because the enquiry was redacted — nothing to retry", () => {
    expect(deskAlertStatus(job({ state: "cancelled", last_result: "lead_redacted" }), now)).toEqual({
      tone: "neutral",
      label: "Desk alert cancelled (enquiry redacted)",
      canRetry: false,
    });
  });

  it("a stale in-flight claim reads as stuck, and the retry is offered once the lease has lapsed", () => {
    expect(
      deskAlertStatus(job({ state: "sending", attempts: 3, claimed_until: "2026-09-21T09:00:00Z" }), now),
    ).toEqual({ tone: "warning", label: "Desk alert stuck (3 of 8) — will be picked up", canRetry: true });
  });
});
