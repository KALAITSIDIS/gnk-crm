import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import { describeEvent, type EventTranslator } from "./events";

const ev = (event_type: string, payload: unknown = {}, entity_type = "deal") => ({
  entity_type,
  event_type,
  payload: payload as never,
});

// Real English translator over the events namespace — the parity assertions
// below therefore also prove every key resolves and interpolates in English.
const en_t = createTranslator({ locale: "en", messages: en, namespace: "events" });
const t = ((key, values) => en_t(key as never, values as never)) as EventTranslator;

describe("describeEvent routes through the translator", () => {
  it("uses the supplied translator for the line (i18n)", () => {
    // a fake translator echoes the key — proves the string comes from t(), not
    // a hardcoded English literal
    const fake: EventTranslator = (key) => `KEY:${key}`;
    expect(describeEvent(ev("spam"), fake)).toBe("KEY:spam");
    expect(describeEvent(ev("stage_changed", { from: "New", to: "Qualified" }), fake)).toBe(
      "KEY:stageChange",
    );
  });

  it("keeps the entity prefix (offer feeds inside a deal timeline)", () => {
    const fake: EventTranslator = (key) => `KEY:${key}`;
    // offerPrefix resolves via t() too, then composes with ": "
    expect(describeEvent(ev("claimed", {}, "offer"), fake)).toBe("KEY:offerPrefix: KEY:claimed");
  });

  it("routes a bulk export event through the translator", () => {
    const fake: EventTranslator = (key) => `KEY:${key}`;
    expect(
      describeEvent(ev("exported", { list: "contacts", count: 3 }, "export"), fake),
    ).toBe("KEY:exported");
  });
});

describe("describeEvent registry (T3.5) — English parity", () => {
  it("renders stage changes with from → to", () => {
    expect(describeEvent(ev("stage_changed", { from: "New", to: "Qualified" }), t)).toBe(
      "Stage New → Qualified",
    );
  });

  it("renders a bulk export with an ICU-pluralised row count and the list slug", () => {
    expect(describeEvent(ev("exported", { list: "contacts", count: 1 }, "export"), t)).toBe(
      "Exported 1 record from contacts to CSV",
    );
    expect(describeEvent(ev("exported", { list: "contacts", count: 42 }, "export"), t)).toBe(
      "Exported 42 records from contacts to CSV",
    );
  });

  it("renders offer status changes with entity prefix and amount", () => {
    const eur = new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    }).format(240000);
    expect(
      describeEvent(
        ev("status_changed", { from: "submitted", to: "accepted", amount: 240000 }, "offer"),
        t,
      ),
    ).toBe(`Offer: Status submitted → accepted (${eur})`);
  });

  it("renders won with and without override", () => {
    expect(describeEvent(ev("won", { override: false }), t)).toBe("Marked won");
    expect(describeEvent(ev("won", { override: true }), t)).toBe("Marked won — admin override");
  });

  it("renders lost with its reason", () => {
    expect(describeEvent(ev("lost", { reason: "budget fell through" }), t)).toBe(
      "Marked lost — budget fell through",
    );
  });

  it("renders merged with the source contact name", () => {
    expect(describeEvent(ev("merged", { merged_contact_name: "M. Testides" }, "contact"), t)).toBe(
      "Merged in M. Testides",
    );
  });

  it("renders section updates", () => {
    expect(describeEvent(ev("updated", { section: "kyc_banking" }, "contact"), t)).toBe(
      "Updated — kyc banking",
    );
  });

  it("renders photo deletes with the recovered filename, bare without", () => {
    expect(
      describeEvent(ev("media_deleted", { media_id: "x", file: "images (4).jpg" }, "property"), t),
    ).toBe("Photo deleted — images (4).jpg");
    expect(describeEvent(ev("media_deleted", { media_id: "x" }, "property"), t)).toBe(
      "Photo deleted",
    );
  });

  it("renders the corrected lead combinations", () => {
    expect(describeEvent(ev("corrected", {}, "lead"), t)).toBe("Lead corrected");
    expect(describeEvent(ev("corrected", { reopened: true }, "lead"), t)).toBe(
      "Lead corrected — reopened",
    );
    expect(
      describeEvent(ev("corrected", { reopened: true, reset_response: true }, "lead"), t),
    ).toBe("Lead corrected — reopened, first-response reset");
  });

  it("renders key movements with code and holder", () => {
    expect(
      describeEvent(ev("key_checkout", { key_code: "K12", holder: "A. Agent" }, "key"), t),
    ).toBe("Key K12 checked out to A. Agent");
    expect(describeEvent(ev("key_lost", { key_code: "K12" }, "key"), t)).toBe("Key K12 marked lost");
  });

  it("renders the evidence-generated line with plural and chain state", () => {
    expect(
      describeEvent(ev("evidence_report_generated", { rows: 1, chain_ok: true }, "contact"), t),
    ).toBe("Commission evidence report generated (1 event, chain verified)");
    expect(
      describeEvent(ev("evidence_report_generated", { rows: 4, chain_ok: false }, "contact"), t),
    ).toBe("Commission evidence report generated (4 events, chain FAILED)");
  });

  // Two share-link kinds share the `opened` event type. Neither had a test
  // before 2026-08-23, which is how the availability line went out reading
  // "Proposal link opened — 0 properties" for a link that was working.
  it("renders an availability link's open by units, not by properties (0041)", () => {
    // 0041 writes kind/unit_count/available_count and NO property_count.
    expect(
      describeEvent(
        ev(
          "opened",
          { kind: "availability", locale: "en", unit_count: 19, available_count: 7 },
          "share_link",
        ),
        t,
      ),
    ).toBe("Availability link opened — 7 of 19 units available");
    // singular unit, and zero available is a real state worth reading
    expect(
      describeEvent(
        ev(
          "opened",
          { kind: "availability", locale: "en", unit_count: 1, available_count: 0 },
          "share_link",
        ),
        t,
      ),
    ).toBe("Availability link opened — 0 of 1 unit available");
  });

  it("leaves the proposal open line untouched (0023)", () => {
    // A proposal payload (0023) has no `kind`, so absence must route to the
    // proposal string — the regression guard for the branch above.
    expect(describeEvent(ev("opened", { locale: "en", property_count: 3 }, "share_link"), t)).toBe(
      "Proposal link opened — 3 properties",
    );
    expect(describeEvent(ev("opened", { locale: "en", property_count: 1 }, "share_link"), t)).toBe(
      "Proposal link opened — 1 property",
    );
  });

  it("renders the day-route line with pluralized stops", () => {
    expect(describeEvent(ev("route_updated", { stops: 1, route_date: "2026-07-20" }, "viewing"), t)).toBe(
      "Day route updated — 1 stop (2026-07-20)",
    );
    expect(describeEvent(ev("route_updated", { stops: 3 }, "viewing"), t)).toBe(
      "Day route updated — 3 stops",
    );
  });

  it("renders the GDPR erasure line with and without retention", () => {
    expect(describeEvent(ev("erased", { retention_until: "2031-07-21" }, "contact"), t)).toBe(
      "Personal data erased (GDPR Art.17) — KYC records retained until 2031-07-21",
    );
    expect(describeEvent(ev("erased", {}, "contact"), t)).toBe(
      "Personal data erased (GDPR Art.17)",
    );
  });

  it("renders both follow-up nudge lines from payload.kind (B7)", () => {
    expect(
      describeEvent(ev("followup_task_created", { kind: "deal_no_contact", days: 14 }), t),
    ).toBe("Follow-up task created — no contact for 14 days");
    expect(
      describeEvent(ev("followup_task_created", { kind: "deal_no_contact", days: 1 }), t),
    ).toBe("Follow-up task created — no contact for 1 day");
    expect(
      describeEvent(
        ev("followup_task_created", { kind: "viewing_feedback", hours: 48 }, "viewing"),
        t,
      ),
    ).toBe("Follow-up task created — viewing feedback still missing after 48 hours");
    // an unknown kind still reads as a nudge rather than raw text
    expect(describeEvent(ev("followup_task_created", { kind: "future_rule" }), t)).toBe(
      "Follow-up task created",
    );
  });

  it("renders supersede reasons, including 0012's, which was never registered", () => {
    expect(
      describeEvent(ev("superseded", { reason: "deal_contacted_or_closed" }, "task"), t),
    ).toBe("Follow-up task closed — the deal was contacted or closed");
    expect(
      describeEvent(
        ev("superseded", { reason: "feedback_logged_or_viewing_reopened" }, "task"),
        t,
      ),
    ).toBe("Follow-up task closed — viewing feedback was logged");
    // written by expire_mandates since 0012 — and by its backfill, which uses a
    // different reason but always carries mandate_id
    expect(
      describeEvent(
        ev("superseded", { reason: "mandate_renewed_or_inactive", mandate_id: "m1" }, "task"),
        t,
      ),
    ).toBe("Renewal task superseded — the mandate was renewed or is no longer active");
    expect(describeEvent(ev("superseded", {}, "task"), t)).toBe("Task superseded");
  });

  it("falls back to the spaced event type for unregistered events", () => {
    expect(describeEvent(ev("future_event_type"), t)).toBe("future event type");
  });

  it("tolerates malformed payloads", () => {
    expect(describeEvent(ev("lost", null), t)).toBe("Marked lost");
    expect(describeEvent(ev("stage_changed", [1, 2]), t)).toBe("Stage");
  });
});

describe("instalment reminders (0051) — the sign of `days` picks the string", () => {
  // remind_due_installments() writes a SIGNED `days`: negative means the line is
  // already overdue. The renderer splits on the sign, so the message always
  // states a positive number of days and never says "due in -10 days".
  it("renders a line still coming due", () => {
    expect(
      describeEvent(
        ev("installment_due_soon", { label: "Deposit", days: 3 }, "property"),
        t,
      ),
    ).toBe("Instalment due in 3 days — Deposit");
    expect(
      describeEvent(
        ev("installment_due_soon", { label: "Deposit", days: 1 }, "property"),
        t,
      ),
    ).toBe("Instalment due in 1 day — Deposit");
  });

  it("says `today` rather than `in 0 days`", () => {
    expect(
      describeEvent(
        ev("installment_due_soon", { label: "Contract", days: 0 }, "property"),
        t,
      ),
    ).toBe("Instalment due today — Contract");
  });

  it("flips to overdue on a negative day count, stated positively", () => {
    expect(
      describeEvent(
        ev("installment_due_soon", { label: "Stage 2", days: -10 }, "property"),
        t,
      ),
    ).toBe("Instalment overdue by 10 days — Stage 2");
    expect(
      describeEvent(
        ev("installment_due_soon", { label: "Stage 2", days: -1 }, "property"),
        t,
      ),
    ).toBe("Instalment overdue by 1 day — Stage 2");
  });

  it("survives a payload with no usable day count", () => {
    // `numeric`/`date` arithmetic reaching the client as something unparseable
    // must not render "in NaN days" — the bug formatResponseMinutes was written
    // for, in a different corner of the same problem.
    expect(
      describeEvent(
        ev("installment_due_soon", { label: "Deposit", days: null }, "property"),
        t,
      ),
    ).toBe("Instalment due today — Deposit");
    expect(String(describeEvent(ev("installment_due_soon", {}, "property"), t))).not.toMatch(
      /NaN/,
    );
  });

  it("disambiguates a superseded reason that 0047 and 0051 SHARE", () => {
    // `reservation_no_longer_live` is written by BOTH sweeps. Without the kind,
    // an instalment chase closed by a released sale would read as a hold-expiry
    // warning — same string, wrong sentence.
    expect(
      describeEvent(
        ev(
          "superseded",
          { kind: "installment_due", reason: "reservation_no_longer_live" },
          "task",
        ),
        t,
      ),
    ).toBe("Instalment reminder closed — the reservation is no longer active");
    expect(
      describeEvent(
        ev(
          "superseded",
          { kind: "reservation_expiring", reason: "reservation_no_longer_live" },
          "task",
        ),
        t,
      ),
    ).toBe("Reservation reminder closed — the hold is no longer live");
  });

  it("renders the two reasons unique to the instalment sweep", () => {
    expect(
      describeEvent(
        ev("superseded", { kind: "installment_due", reason: "installment_paid" }, "task"),
        t,
      ),
    ).toBe("Instalment reminder closed — the payment was recorded");
    expect(
      describeEvent(
        ev(
          "superseded",
          { kind: "installment_due", reason: "installment_rescheduled" },
          "task",
        ),
        t,
      ),
    ).toBe("Instalment reminder closed — the due date changed");
  });
});

describe("key recall (0053)", () => {
  it("states how many keys are still held", () => {
    expect(
      describeEvent(ev("key_recall_task_created", { keys: 2 }, "mandate"), t),
    ).toBe("Mandate ended — 2 keys still held, recall task created");
    expect(
      describeEvent(ev("key_recall_task_created", { keys: 1 }, "mandate"), t),
    ).toBe("Mandate ended — 1 key still held, recall task created");
  });

  it("survives a payload with no usable count", () => {
    expect(String(describeEvent(ev("key_recall_task_created", {}, "mandate"), t))).not.toMatch(
      /NaN|\{/,
    );
  });

  it("closes with its own reason, not a renewal one", () => {
    // `keys_returned` is written only by raise_key_recall_tasks; the renewal
    // sweep's `mandate_renewed_or_inactive` must still render as before
    expect(
      describeEvent(
        ev("superseded", { kind: "key_recall", reason: "keys_returned" }, "task"),
        t,
      ),
    ).toBe("Key recall closed — nothing is held any more");
    expect(
      describeEvent(
        ev("superseded", { reason: "mandate_renewed_or_inactive", mandate_id: "m1" }, "task"),
        t,
      ),
    ).toBe("Renewal task superseded — the mandate was renewed or is no longer active");
  });
});

/**
 * A written event type with no registry entry still renders — as its raw verb
 * ("mfa reset"). The evidence is recorded either way, but the timeline is the
 * surface this product is sold on, so the verbs it prints have to read like
 * evidence. These four were written by the security, mandate and unit-type
 * work and never registered (found 2026-09-02 by diffing every `eventType:`
 * written in lib/ against the registry).
 */
describe("event types that reached the log before the registry", () => {
  it("names the admin 2FA reset, with the factor count when it carries one", () => {
    expect(describeEvent(ev("mfa_reset", { factors_removed: 2 }, "profile"), t)).toContain(
      "2 factor(s) removed",
    );
    // and degrades to the plain sentence when the payload predates the count
    expect(describeEvent(ev("mfa_reset", {}, "profile"), t)).toContain(
      "Two-factor authentication reset",
    );
  });

  it("names a password change", () => {
    expect(describeEvent(ev("password_changed", {}, "profile"), t)).toContain("Password changed");
  });

  it("shows the mandate's NEW window, which is the fact a renewal adds", () => {
    const line = describeEvent(
      ev(
        "renewed",
        {
          previous_window: { start: "2026-01-01", expiry: "2026-06-30" },
          new_window: { start: "2026-07-01", expiry: "2027-06-30" },
        },
        "mandate",
      ),
      t,
    );
    expect(line).toContain("2026-07-01");
    expect(line).toContain("2027-06-30");
    // the OLD window is in the payload but not in the line — a renewal is
    // read for what it grants, and the previous row is directly above it
    expect(line).not.toContain("2026-01-01");
  });

  it("names the unit type by its code", () => {
    expect(describeEvent(ev("unit_type_created", { code: "A2" }, "property"), t)).toContain(
      "A2",
    );
  });

  it("still falls back to the raw verb for a type nobody has registered", () => {
    expect(describeEvent(ev("something_nobody_registered", {}, "deal"), t)).toContain(
      "something nobody registered",
    );
  });
});

