import { describe, expect, it } from "vitest";
import { escalationStatus, type EscalationJob } from "./lead-escalation-status";

/**
 * What the inbox says about a website lead's escalation (0107, recovery
 * 0111), from its `notification_jobs` row. Pure, so the wording — the one
 * place a colleague learns that nobody else was told either, or that a
 * decision is an admin's — is pinned without rendering anything. The
 * recovery offered here is the one the database would admit for the same
 * row (request_lead_escalation_recovery); the function refuses the other.
 *
 * A08 (review 2026-10-18) re-pinned every label on purpose: business words
 * on the row, and the outbox's codes, counters, lease and key in `detail`
 * (behind "Technical details"). The recovery predictions did not move — the
 * chip acts on `recovery`, never on a label.
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

/** The outbox's vocabulary, which a label must never carry (as in enquiry-alert-status.test.ts). */
const JARGON = /[a-z]_[a-z]|\b\d{3}\b|\d+ of \d+|FAILED|outbox|worker|sweep|lease|provider|\bkey\b|\bhttp/i;

const NEEDS_DECISION = "Escalation needs a decision — an earlier try may already have reached colleagues";
const SAME_KEY = "Retry presents the same provider key, which cannot send a second copy";
const KEY_EXPIRED = "the provider key's safe window has passed, so a new send needs a new key";

describe("escalationStatus", () => {
  it("a lead with no escalation row says nothing — nothing was due, or the outbox predates it", () => {
    expect(escalationStatus(null, now)).toBeNull();
    expect(escalationStatus(undefined, now)).toBeNull();
  });

  it("queued, before the first attempt", () => {
    expect(escalationStatus(job(), now)).toEqual({ tone: "neutral", label: "Escalation queued", detail: null, recovery: null });
  });

  it("re-queued after a recovery keeps the earlier result as a detail, not in the label", () => {
    expect(escalationStatus(job({ last_result: "validation_error", last_category: "permanent" }), now)).toEqual({
      tone: "neutral",
      label: "Escalation queued",
      detail: "state pending · attempt 0 of 8 · last result validation_error (permanent)",
      recovery: null,
    });
  });

  it("in flight under a live lease", () => {
    expect(escalationStatus(job({ state: "sending", attempts: 1, claimed_until: at(-1), first_attempted_at: at(0), last_attempted_at: at(0) }), now)).toEqual({
      tone: "neutral",
      label: "Escalation sending…",
      detail: null,
      recovery: null,
    });
  });

  it("backing off after a failed attempt says when it tries again, and offers nothing — the worker owns it", () => {
    expect(
      escalationStatus(
        job({ attempts: 2, last_category: "transient", last_result: "503", next_attempt_at: at(-4), first_attempted_at: at(3), last_attempted_at: at(1) }),
        now,
      ),
    ).toEqual({
      tone: "warning",
      label: "Escalation delayed — trying again in 4 min",
      detail: "state pending · attempt 2 of 8 · last result 503 (transient) · last attempt 1 min ago",
      recovery: null,
    });
  });

  it("a stale in-flight claim reads as stuck; Retry is offered once the lease has lapsed", () => {
    expect(escalationStatus(job({ state: "sending", attempts: 3, claimed_until: at(5), first_attempted_at: at(30), last_attempted_at: at(7) }), now)).toEqual({
      tone: "warning",
      label: "Escalation stuck — it will be retried",
      detail: `state sending · attempt 3 of 8 · last attempt 7 min ago · the worker's lease lapsed 5 min ago · the next sweep picks it up; ${SAME_KEY}`,
      recovery: "retry",
    });
  });

  it("a stale claim whose key has expired needs a decision — resend, never retry", () => {
    expect(
      escalationStatus(job({ state: "sending", attempts: 3, claimed_until: at(30), first_attempted_at: at(21 * 60), last_attempted_at: at(40) }), now),
    ).toEqual({
      tone: "warning",
      label: NEEDS_DECISION,
      detail: `state sending · attempt 3 of 8 · last attempt 40 min ago · the worker's lease lapsed 30 min ago · ${KEY_EXPIRED}`,
      recovery: "resend",
    });
  });

  it("accepted by the provider reads as sent, with when — never delivered; the receipt caveat is a detail", () => {
    const s = escalationStatus(job({ state: "accepted", attempts: 1, last_result: "accepted", accepted_at: at(13), first_attempted_at: at(13), last_attempted_at: at(13) }), now);
    expect(s).toEqual({
      tone: "success",
      label: "Escalation sent 13 min ago",
      detail: "state accepted · attempt 1 of 8 · last result accepted · accepted by the provider for sending — not a delivery receipt",
      recovery: null,
    });
    expect(s!.label).not.toMatch(/deliver/i);
    expect(escalationStatus(job({ state: "accepted", attempts: 1 }), now)?.label).toBe("Escalation sent");
  });

  it("failed for good: refused, or after how many tries — Retry, under the same key, while the key is safe", () => {
    expect(
      escalationStatus(job({ state: "failed", attempts: 8, last_category: "transient", last_result: "503", first_attempted_at: at(130), last_attempted_at: at(30) }), now),
    ).toEqual({
      tone: "danger",
      label: "Escalation not sent after 8 tries",
      detail: `state failed · attempt 8 of 8 · last result 503 (transient) · last attempt 30 min ago · ${SAME_KEY}`,
      recovery: "retry",
    });
    expect(
      escalationStatus(job({ state: "failed", attempts: 1, last_category: "permanent", last_result: "validation_error", first_attempted_at: at(2), last_attempted_at: at(2) }), now),
    ).toMatchObject({
      tone: "danger",
      label: "Escalation not sent — the mail service refused it",
      detail: expect.stringContaining("last result validation_error (permanent)"),
      recovery: "retry",
    });
    expect(
      escalationStatus(job({ state: "failed", attempts: 8, last_category: "timeout", last_result: "lease_expired", first_attempted_at: at(90), last_attempted_at: at(20) }), now),
    ).toMatchObject({ label: "Escalation not sent after 8 tries", detail: expect.stringContaining("lease_expired (timeout)"), recovery: "retry" });
    expect(escalationStatus(job({ state: "failed", attempts: 1, last_category: "timeout", last_result: "timeout" }), now)?.label).toBe("Escalation not sent");
  });

  it("a conflict needs a decision: the provider holds an earlier version and may already have sent it", () => {
    expect(
      escalationStatus(
        job({ state: "failed", attempts: 2, last_category: "conflict", last_result: "invalid_idempotent_request", first_attempted_at: at(20), last_attempted_at: at(18) }),
        now,
      ),
    ).toEqual({
      tone: "danger",
      label: "Escalation needs a decision — the first e-mail may already have reached colleagues",
      detail:
        "state failed · attempt 2 of 8 · last result invalid_idempotent_request (conflict) · last attempt 18 min ago · the provider holds an earlier version of this e-mail under its key",
      recovery: "resend",
    });
  });

  it("the two review words need a decision too", () => {
    expect(
      escalationStatus(job({ state: "failed", attempts: 3, last_category: "timeout", last_result: "key_window_expired", first_attempted_at: at(21 * 60), last_attempted_at: at(19 * 60) }), now),
    ).toEqual({
      tone: "danger",
      label: "Escalation needs a decision — the first e-mail may already have reached colleagues",
      detail:
        "state failed · attempt 3 of 8 · last result key_window_expired (timeout) · last attempt 19 h ago · the provider key expired before the outcome of an earlier attempt was known",
      recovery: "resend",
    });
    expect(
      escalationStatus(job({ state: "failed", attempts: 2, last_category: "transient", last_result: "retry_beyond_window", first_attempted_at: at(60), last_attempted_at: at(5) }), now),
    ).toEqual({
      tone: "danger",
      label: "Escalation needs a decision — the mail service asked to wait too long",
      detail:
        "state failed · attempt 2 of 8 · last result retry_beyond_window (transient) · last attempt 5 min ago · the provider's Retry-After outlasts the key's safe window, so the worker stopped",
      recovery: "resend",
    });
  });

  it("a plain failure whose key is older than the window is a decision too, by the clock alone", () => {
    expect(
      escalationStatus(job({ state: "failed", attempts: 8, last_category: "transient", last_result: "503", first_attempted_at: at(21 * 60), last_attempted_at: at(18 * 60) }), now),
    ).toEqual({
      tone: "danger",
      label: NEEDS_DECISION,
      detail: `state failed · attempt 8 of 8 · last result 503 (transient) · last attempt 18 h ago · ${KEY_EXPIRED}`,
      recovery: "resend",
    });
  });

  it("cancelled because of the policy is recoverable once the policy is fixed, and says where", () => {
    expect(escalationStatus(job({ state: "cancelled", attempts: 1, last_result: "escalation_disabled", first_attempted_at: at(9), last_attempted_at: at(9) }), now)).toEqual({
      tone: "neutral",
      label:
        "Escalation cancelled — lead escalation was switched off when it was due. Switch it on under Settings → Lead escalation, then Retry.",
      detail: `state cancelled · attempt 1 of 8 · last result escalation_disabled · last attempt 9 min ago · ${SAME_KEY}`,
      recovery: "retry",
    });
    expect(escalationStatus(job({ state: "cancelled", attempts: 1, last_result: "no_recipient", first_attempted_at: at(9), last_attempted_at: at(9) }), now)).toMatchObject({
      tone: "neutral",
      label:
        "Escalation cancelled — nobody eligible was set to receive it. Check the recipients under Settings → Lead escalation, then Retry.",
      recovery: "retry",
    });
  });

  it("a policy cancellation whose key has since expired needs a decision, like any expired key", () => {
    expect(
      escalationStatus(job({ state: "cancelled", attempts: 2, last_result: "escalation_disabled", first_attempted_at: at(21 * 60), last_attempted_at: at(20 * 60) }), now),
    ).toEqual({
      tone: "neutral",
      label:
        "Escalation cancelled — lead escalation was switched off when it was due. Switch it on under Settings → Lead escalation, then review and send a new copy.",
      detail: `state cancelled · attempt 2 of 8 · last result escalation_disabled · last attempt 20 h ago · ${KEY_EXPIRED}`,
      recovery: "resend",
    });
  });

  it("cancelled because the enquiry was no longer eligible is final, in words; an unworded code is a detail", () => {
    const final = (result: string, label: string) =>
      expect(escalationStatus(job({ state: "cancelled", attempts: 1, last_result: result, first_attempted_at: at(9), last_attempted_at: at(9) }), now)).toEqual({
        tone: "neutral",
        label,
        detail: `state cancelled · attempt 1 of 8 · last result ${result} · last attempt 9 min ago`,
        recovery: null,
      });
    final("lead_answered", "Escalation cancelled — the enquiry was answered first");
    final("lead_closed", "Escalation cancelled — the lead was closed");
    final("lead_redacted", "Escalation cancelled — the enquiry was redacted");
    final("lead_unreadable", "Escalation cancelled — the enquiry could not be read");
    final("lead_missing", "Escalation cancelled — the lead no longer exists");
    final("org_mismatch", "Escalation cancelled");
    // an inherited name is neither a policy nor a word
    expect(escalationStatus(job({ state: "cancelled", attempts: 1, last_result: "toString" }), now)).toMatchObject({
      label: "Escalation cancelled",
      recovery: null,
    });
  });

  it("no label, in any state the outbox can hold, carries a code, a counter or the machinery's words — and no code is dropped", () => {
    const results = [null, "503", "validation_error", "key_window_expired", "retry_beyond_window", "invalid_idempotent_request",
      "escalation_disabled", "no_recipient", "lead_answered", "org_mismatch", "lease_expired", "config_read_failed", "timeout"];
    const categories = [null, "transient", "permanent", "timeout", "conflict"];
    let seen = 0;
    for (const state of ["pending", "sending", "accepted", "failed", "cancelled", "something_new"]) {
      for (const last_result of results) {
        for (const last_category of categories) {
          for (const attempts of [0, 1, 8]) {
            for (const first of [null, at(30), at(21 * 60)]) {
              for (const claimed_until of [null, at(5), at(-5)]) {
                const s = escalationStatus(
                  job({ state, last_result, last_category, attempts, first_attempted_at: first, last_attempted_at: first, claimed_until }),
                  now,
                )!;
                expect(s.label, `${state}/${last_result}/${last_category}`).not.toMatch(JARGON);
                if (last_result) expect(s.detail, `${state}/${last_result} dropped its code`).toContain(last_result);
                seen += 1;
              }
            }
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(5000);
  });
});
