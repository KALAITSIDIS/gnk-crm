import { describe, expect, it } from "vitest";
import {
  PREVIEW_LIMIT,
  RECIPIENT_REASON_COPY,
  VERDICT_COPY,
  leadExclusionReason,
  previewFormSnapshot,
  readLeadEscalationPreview,
  type LeadEscalationPreview,
  type PreviewLead,
} from "@/lib/services/lead-escalation-preview";

/**
 * The reader of `preview_lead_escalation`'s document (0112). The database
 * writes the document and supabase/tests/lead-escalation-preview.test.ts
 * proves its content; this file pins the CLIENT'S side — a document in the
 * expected shape passes through unchanged, anything off is null rather than
 * a card rendering nonsense, and the words the card uses for a verdict or a
 * recipient's reason exist for every value the database can send.
 */
const lead = (over: Partial<PreviewLead> = {}): PreviewLead => ({
  lead_id: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  received_at: "2026-09-25T19:00:00+00:00",
  due_at: "2026-09-28T06:15:00+00:00",
  verdict: "due",
  status: "new",
  assignee_id: null,
  assignee_name: null,
  property_ref: null,
  recipients_eligible: 1,
  only_recipient_is_assignee: false,
  job_state: null,
  ...over,
});

const doc = (): Record<string, unknown> => ({
  evaluated_at: "2026-09-28T06:20:00+00:00",
  evaluated_as_enabled: true,
  stored_enabled: false,
  policy: { enabled: true, after_minutes: 15, max_age_hours: 48, recipients: [], working_hours: null, timezone: "Asia/Nicosia" },
  recipients: [
    { id: "11111111-1111-1111-1111-111111111111", full_name: "A", role: "admin", is_active: true, has_email: true, eligible: true, reason: "ok" },
    { id: "22222222-2222-2222-2222-222222222222", full_name: null, role: null, is_active: null, has_email: null, eligible: false, reason: "not_in_organisation" },
  ],
  eligible_recipient_count: 1,
  counts: { considered: 1, due: 1, would_send: 1, no_recipient: 0, only_recipient_is_assignee: 0, not_yet_due: 0, past_cutoff: 0, already_escalated: 0 },
  leads: [lead()],
  truncated: false,
  limit: 50,
});

describe("readLeadEscalationPreview", () => {
  it("passes a well-formed document through, with the policy read by the sweep's own reader", () => {
    const out = readLeadEscalationPreview(doc());
    expect(out).not.toBeNull();
    expect(out!.counts.due).toBe(1);
    expect(out!.leads[0]).toEqual(lead());
    expect(out!.recipients[1]!.reason).toBe("not_in_organisation");
    expect(out!.policy).toEqual({ enabled: true, after_minutes: 15, max_age_hours: 48, recipients: [], working_hours: null, timezone: "Asia/Nicosia" });
    expect(out!.stored_enabled).toBe(false);
  });

  it("is null for anything that is not the document: a string, an array, a missing block, a count that is not a number", () => {
    expect(readLeadEscalationPreview("ok")).toBeNull();
    expect(readLeadEscalationPreview([])).toBeNull();
    expect(readLeadEscalationPreview(null)).toBeNull();
    const noCounts = doc();
    delete noCounts.counts;
    expect(readLeadEscalationPreview(noCounts)).toBeNull();
    expect(readLeadEscalationPreview({ ...doc(), counts: { ...(doc().counts as object), due: "1" } })).toBeNull();
    expect(readLeadEscalationPreview({ ...doc(), truncated: "no" })).toBeNull();
  });

  it("is null for a verdict or a reason the card has no words for", () => {
    expect(readLeadEscalationPreview({ ...doc(), leads: [lead({ verdict: "maybe" as never })] })).toBeNull();
    const r = (doc().recipients as Array<Record<string, unknown>>)[0]!;
    expect(readLeadEscalationPreview({ ...doc(), recipients: [{ ...r, reason: "sulking" }] })).toBeNull();
  });

  it("has words for every verdict and every reason", () => {
    for (const v of ["due", "not_yet_due", "past_cutoff", "already_escalated"] as const) expect(VERDICT_COPY[v]).toBeTruthy();
    for (const r of ["ok", "not_in_organisation", "inactive", "not_admin_or_agent", "no_email"] as const) expect(RECIPIENT_REASON_COPY[r]).toBeTruthy();
  });

  it("asks for at most the bounded page the database allows", () => {
    expect(PREVIEW_LIMIT).toBeGreaterThanOrEqual(1);
    expect(PREVIEW_LIMIT).toBeLessThanOrEqual(200);
  });
});

describe("leadExclusionReason — why this enquiry would NOT be e-mailed", () => {
  const out = (over: Partial<PreviewLead>) => leadExclusionReason(lead(over));

  it("a due enquiry with somebody to tell has no exclusion", () => {
    expect(out({ verdict: "due", recipients_eligible: 2 })).toBeNull();
  });
  it("a due enquiry whose only eligible recipient is its assignee says so — the assignee is never told", () => {
    expect(out({ verdict: "due", recipients_eligible: 0, only_recipient_is_assignee: true })).toMatch(/assign/i);
  });
  it("a due enquiry with nobody eligible says so", () => {
    expect(out({ verdict: "due", recipients_eligible: 0 })).toMatch(/nobody/i);
  });
  it("the other verdicts explain themselves, and a queued job names its state", () => {
    expect(out({ verdict: "not_yet_due" })).toMatch(/not yet/i);
    expect(out({ verdict: "past_cutoff" })).toMatch(/cutoff|ago/i);
    expect(out({ verdict: "already_escalated", job_state: "accepted" })).toMatch(/already.*accepted/i);
  });
});

// the type is exported for the panel; a compile-time check that the reader returns it
const _typed: LeadEscalationPreview | null = readLeadEscalationPreview(doc());
void _typed;

/**
 * Audit 2026-09-22 (late): the panel compares the form with what a preview
 * SENT. The comparison is by value, and recipients and days are sets to the
 * server — a refresh that reorders the ticked colleagues changes nothing.
 */
describe("previewFormSnapshot", () => {
  function fd(entries: Array<[string, string]>): FormData {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  }

  it("is equal for the same values, whatever order the multi-value fields come in", () => {
    const a = fd([["enabled", "on"], ["after_minutes", "15"], ["recipients", "A"], ["recipients", "B"], ["days", "1"], ["days", "5"]]);
    const b = fd([["recipients", "B"], ["enabled", "on"], ["days", "5"], ["recipients", "A"], ["after_minutes", "15"], ["days", "1"]]);
    expect(previewFormSnapshot(a)).toBe(previewFormSnapshot(b));
  });

  it("differs when any value, or the presence of a field, differs", () => {
    const base: Array<[string, string]> = [["enabled", "on"], ["after_minutes", "15"], ["recipients", "A"]];
    const s = previewFormSnapshot(fd(base));
    expect(previewFormSnapshot(fd([["enabled", "on"], ["after_minutes", "30"], ["recipients", "A"]]))).not.toBe(s);
    expect(previewFormSnapshot(fd([["after_minutes", "15"], ["recipients", "A"]])), "a box unticked").not.toBe(s);
    expect(previewFormSnapshot(fd([...base, ["recipients", "B"]])), "one more recipient").not.toBe(s);
  });

  it("cannot be fooled by a value that looks like another field", () => {
    expect(previewFormSnapshot(fd([["a", "b=c"]]))).not.toBe(previewFormSnapshot(fd([["a=b", "c"]])));
  });
});
