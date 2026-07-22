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
});

describe("describeEvent registry (T3.5) — English parity", () => {
  it("renders stage changes with from → to", () => {
    expect(describeEvent(ev("stage_changed", { from: "New", to: "Qualified" }), t)).toBe(
      "Stage New → Qualified",
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

  it("falls back to the spaced event type for unregistered events", () => {
    expect(describeEvent(ev("future_event_type"), t)).toBe("future event type");
  });

  it("tolerates malformed payloads", () => {
    expect(describeEvent(ev("lost", null), t)).toBe("Marked lost");
    expect(describeEvent(ev("stage_changed", [1, 2]), t)).toBe("Stage");
  });
});
