import { describe, expect, it } from "vitest";
import { describeEvent } from "./events";

const ev = (event_type: string, payload: unknown = {}, entity_type = "deal") => ({
  entity_type,
  event_type,
  payload: payload as never,
});

describe("describeEvent registry (T3.5)", () => {
  it("renders stage changes with from → to", () => {
    expect(describeEvent(ev("stage_changed", { from: "New", to: "Qualified" }))).toBe(
      "Stage New → Qualified",
    );
  });

  it("renders offer status changes with entity prefix and amount", () => {
    // build the amount with the same Intl formatter — it uses a non-breaking
    // space before € that a literal in this file would silently mismatch
    const eur = new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    }).format(240000);
    expect(
      describeEvent(ev("status_changed", { from: "submitted", to: "accepted", amount: 240000 }, "offer")),
    ).toBe(`Offer: Status submitted → accepted (${eur})`);
  });

  it("renders won with and without override", () => {
    expect(describeEvent(ev("won", { override: false }))).toBe("Marked won");
    expect(describeEvent(ev("won", { override: true }))).toBe("Marked won — admin override");
  });

  it("renders lost with its reason", () => {
    expect(describeEvent(ev("lost", { reason: "budget fell through" }))).toBe(
      "Marked lost — budget fell through",
    );
  });

  it("renders merged with the source contact name", () => {
    expect(
      describeEvent(ev("merged", { merged_contact_name: "M. Testides" }, "contact")),
    ).toBe("Merged in M. Testides");
  });

  it("renders section updates", () => {
    expect(describeEvent(ev("updated", { section: "kyc_banking" }, "contact"))).toBe(
      "Updated — kyc banking",
    );
  });

  it("renders photo deletes with the recovered filename, bare without", () => {
    expect(describeEvent(ev("media_deleted", { media_id: "x", file: "images (4).jpg" }, "property"))).toBe(
      "Photo deleted — images (4).jpg",
    );
    // pre-2026-07-16 events never logged a filename — must stay renderable
    expect(describeEvent(ev("media_deleted", { media_id: "x" }, "property"))).toBe("Photo deleted");
  });

  it("falls back to spaced event type for unregistered events", () => {
    expect(describeEvent(ev("future_event_type"))).toBe("future event type");
  });

  it("tolerates malformed payloads", () => {
    expect(describeEvent(ev("lost", null))).toBe("Marked lost");
    expect(describeEvent(ev("stage_changed", [1, 2]))).toBe("Stage");
  });
});
