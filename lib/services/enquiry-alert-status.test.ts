import { describe, expect, it } from "vitest";
import { deskAlertStatus, outboxTechnicalDetail, ownWord, type DeskAlertJob } from "./enquiry-alert-status";

/**
 * What the inbox says about a website lead's desk alert (0101, reviewed
 * 0102), from the `notification_jobs` row. Pure, so the wording — the one
 * place a person learns that nobody was told, or that a decision is theirs —
 * is pinned without rendering anything.
 *
 * A08 (review 2026-10-18) re-pinned every label on purpose: the chip is on
 * every website lead card and every role reads it, so the label is business
 * words and the outbox's codes and counters moved to `detail`, which the
 * chip renders behind "Technical details". Nothing compares these labels —
 * the retry offer is `canRetry`, and the database decides for real.
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

/**
 * The outbox's vocabulary, which a label must never carry: a result code (any
 * snake_case word, an HTTP status), the attempt counter, the old shouted
 * FAILED, and the machinery's own nouns.
 */
const JARGON = /[a-z]_[a-z]|\b\d{3}\b|\d+ of \d+|FAILED|outbox|worker|sweep|lease|provider|\bkey\b|\bhttp/i;

describe("deskAlertStatus", () => {
  it("a lead the outbox predates says nothing", () => {
    expect(deskAlertStatus(null, now)).toBeNull();
    expect(deskAlertStatus(undefined, now)).toBeNull();
  });

  it("queued, before the first attempt — nothing technical to add", () => {
    expect(deskAlertStatus(job(), now)).toEqual({ tone: "neutral", label: "Desk alert queued", detail: null, canRetry: false });
  });

  it("in flight", () => {
    expect(deskAlertStatus(job({ state: "sending", attempts: 1, claimed_until: "2026-09-21T10:01:00Z" }), now)).toEqual({
      tone: "neutral",
      label: "Desk alert sending…",
      detail: null,
      canRetry: false,
    });
  });

  it("backing off after a failed attempt says when it tries again; the code and counter are details", () => {
    expect(
      deskAlertStatus(
        job({ attempts: 2, last_category: "transient", last_result: "503", next_attempt_at: "2026-09-21T10:04:00Z" }),
        now,
      ),
    ).toEqual({
      tone: "warning",
      label: "Desk alert delayed — trying again in 4 min",
      detail: "state pending · attempt 2 of 8 · last result 503 (transient)",
      canRetry: false,
    });
    expect(deskAlertStatus(job({ attempts: 1, last_result: "timeout", next_attempt_at: "2026-09-21T09:59:00Z" }), now)?.label).toBe(
      "Desk alert delayed — trying again now",
    );
  });

  it("accepted by the provider — and the word is alerted, not delivered", () => {
    expect(deskAlertStatus(job({ state: "accepted", attempts: 1, accepted_at: "2026-09-21T09:59:00Z" }), now)).toEqual({
      tone: "success",
      label: "Desk alerted",
      detail: null,
      canRetry: false,
    });
  });

  it("accepted because the old route had already told the desk (the rollout closure) — the route is a detail", () => {
    expect(
      deskAlertStatus(job({ state: "accepted", attempts: 0, last_result: "legacy_sender", accepted_at: "2026-09-21T09:59:00Z" }), now),
    ).toEqual({
      tone: "success",
      label: "Desk alerted",
      detail: "state accepted · attempt 0 of 8 · last result legacy_sender · sent by the route used before the outbox (0102)",
      canRetry: false,
    });
  });

  it("failed for good: refused when the mail service said so, otherwise after how many tries — the retry offered", () => {
    expect(
      deskAlertStatus(job({ state: "failed", attempts: 8, last_category: "transient", last_result: "503" }), now),
    ).toEqual({
      tone: "danger",
      label: "Desk alert not sent after 8 tries",
      detail: "state failed · attempt 8 of 8 · last result 503 (transient)",
      canRetry: true,
    });
    expect(
      deskAlertStatus(job({ state: "failed", attempts: 1, last_category: "permanent", last_result: "validation_error" }), now),
    ).toEqual({
      tone: "danger",
      label: "Desk alert not sent — the mail service refused it",
      detail: "state failed · attempt 1 of 8 · last result validation_error (permanent)",
      canRetry: true,
    });
    expect(deskAlertStatus(job({ state: "failed", attempts: 1, last_category: "timeout", last_result: "timeout" }), now)?.label).toBe(
      "Desk alert not sent",
    );
  });

  it("needs a decision when the provider may have sent it and the key has expired (review A)", () => {
    expect(
      deskAlertStatus(job({ state: "failed", attempts: 3, last_category: "timeout", last_result: "key_window_expired" }), now),
    ).toEqual({
      tone: "danger",
      label: "Desk alert needs a decision — it may already have reached the desk; Retry sends it again",
      detail:
        "state failed · attempt 3 of 8 · last result key_window_expired (timeout) · the provider key expired before the outcome of an earlier attempt was known",
      canRetry: true,
    });
  });

  it("needs a decision on a conflict too — the provider holds an earlier version and may have sent it", () => {
    expect(
      deskAlertStatus(job({ state: "failed", attempts: 2, last_category: "conflict", last_result: "invalid_idempotent_request" }), now),
    ).toMatchObject({
      tone: "danger",
      label: "Desk alert needs a decision — it may already have reached the desk; Retry sends it again",
      detail: expect.stringContaining("invalid_idempotent_request (conflict) · the provider holds an earlier version"),
      canRetry: true,
    });
  });

  it("needs a decision when the provider asked for a wait the key cannot survive (review A)", () => {
    expect(
      deskAlertStatus(job({ state: "failed", attempts: 2, last_category: "transient", last_result: "retry_beyond_window" }), now),
    ).toEqual({
      tone: "danger",
      label: "Desk alert needs a decision — the mail service asked to wait too long; Retry sends it again",
      detail:
        "state failed · attempt 2 of 8 · last result retry_beyond_window (transient) · the provider's Retry-After outlasts the key's safe window, so the worker stopped",
      canRetry: true,
    });
  });

  it("cancelled because the enquiry no longer needs it says why in words — nothing to retry", () => {
    expect(deskAlertStatus(job({ state: "cancelled", last_result: "lead_redacted" }), now)).toEqual({
      tone: "neutral",
      label: "Desk alert cancelled — the enquiry was redacted",
      detail: "state cancelled · attempt 0 of 8 · last result lead_redacted",
      canRetry: false,
    });
    expect(deskAlertStatus(job({ state: "cancelled", last_result: "lead_missing" }), now)?.label).toBe(
      "Desk alert cancelled — the lead no longer exists",
    );
    expect(deskAlertStatus(job({ state: "cancelled", last_result: "lead_unreadable" }), now)?.label).toBe(
      "Desk alert cancelled — the enquiry could not be read",
    );
  });

  it("a cancellation code with no words stays a detail — and an inherited name is not a word", () => {
    expect(deskAlertStatus(job({ state: "cancelled", last_result: "org_mismatch" }), now)).toEqual({
      tone: "neutral",
      label: "Desk alert cancelled",
      detail: "state cancelled · attempt 0 of 8 · last result org_mismatch",
      canRetry: false,
    });
    expect(deskAlertStatus(job({ state: "cancelled", last_result: "toString" }), now)?.label).toBe("Desk alert cancelled");
    expect(deskAlertStatus(job({ state: "cancelled" }), now)?.detail).toBeNull();
  });

  it("a stale in-flight claim reads as stuck, and the retry is offered once the lease has lapsed", () => {
    expect(
      deskAlertStatus(job({ state: "sending", attempts: 3, claimed_until: "2026-09-21T09:00:00Z" }), now),
    ).toEqual({
      tone: "warning",
      label: "Desk alert stuck — it will be retried",
      detail: "state sending · attempt 3 of 8 · the worker's claim lapsed; the next sweep picks it up",
      canRetry: true,
    });
  });

  it("no label, in any state the outbox can hold, carries a code, a counter or the machinery's words", () => {
    const results = [null, "503", "validation_error", "key_window_expired", "retry_beyond_window", "invalid_idempotent_request",
      "legacy_sender", "lead_redacted", "lead_missing", "org_mismatch", "sender_threw", "http_429", "timeout"];
    const categories = [null, "transient", "permanent", "timeout", "conflict"];
    let seen = 0;
    for (const state of ["pending", "sending", "accepted", "failed", "cancelled", "something_new"]) {
      for (const last_result of results) {
        for (const last_category of categories) {
          for (const attempts of [0, 1, 3, 8]) {
            for (const claimed_until of [null, "2026-09-21T09:00:00Z", "2026-09-21T10:05:00Z"]) {
              const s = deskAlertStatus(job({ state, last_result, last_category, attempts, claimed_until }), now)!;
              expect(s.label, `${state}/${last_result}/${last_category}`).not.toMatch(JARGON);
              // a code the label does not word is never lost: it is in the details
              if (last_result && s.detail === null) {
                expect(["accepted"], `${state}/${last_result} dropped its code`).toContain(state);
              }
              seen += 1;
            }
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(1000);
  });
});

describe("outboxTechnicalDetail / ownWord", () => {
  it("states the row in the outbox's own words, then what the caller adds, skipping nothing it was given", () => {
    expect(outboxTechnicalDetail(job({ attempts: 2, last_category: "transient" }), null, "x", undefined)).toBe(
      "state pending · attempt 2 of 8 · last category transient · x",
    );
  });

  it("reads only a map's own entries", () => {
    expect(ownWord({ a: "A" }, "a")).toBe("A");
    expect(ownWord({ a: "A" }, "constructor")).toBeUndefined();
    expect(ownWord({ a: "A" }, null)).toBeUndefined();
  });
});
