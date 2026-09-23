import { describe, expect, it } from "vitest";
import { changesForChain, contactShapeOnly, isNoteField } from "./event-changes";

describe("changesForChain", () => {
  const everything = () => true;
  const nothing = () => false;

  it("passes a field the caller keeps through unchanged", () => {
    const changed = { status: { from: "available", to: "sold" } };
    expect(changesForChain(changed, nothing)).toEqual(changed);
  });

  it("replaces a shape-only field's values with whether each side held one", () => {
    expect(
      changesForChain(
        {
          replaced: { from: "old words", to: "new words" },
          added: { from: null, to: "new words" },
          removed: { from: "old words", to: null },
        },
        everything,
      ),
    ).toEqual({
      replaced: { from_set: true, to_set: true },
      added: { from_set: false, to_set: true },
      removed: { from_set: true, to_set: false },
    });
  });

  it("counts blank text, an empty list and an empty object as not set", () => {
    expect(changesForChain({ a: { from: "", to: [] } }, everything)).toEqual({
      a: { from_set: false, to_set: false },
    });
    expect(changesForChain({ a: { from: {}, to: ["en"] } }, everything)).toEqual({
      a: { from_set: false, to_set: true, keys: [] },
    });
  });

  it("names the sub-fields of an object that moved — the column's own words, never a value", () => {
    const out = changesForChain(
      {
        kyc: {
          from: { passport_id: { done: false }, pep_declaration: { done: true } },
          to: {
            passport_id: { done: true, note: "Passport K123" },
            pep_declaration: { done: true },
            sof_evidence: { done: false, doc_link: "https://x.example/a.pdf" },
          },
        },
      },
      everything,
    );
    expect(out).toEqual({
      kyc: { from_set: true, to_set: true, keys: ["passport_id", "sof_evidence"] },
    });
    expect(JSON.stringify(out)).not.toMatch(/K123|x\.example/);
  });

  it("treats a stored value and its form twin as unchanged inside an object (jsonb key order)", () => {
    const out = changesForChain(
      { title: { from: { el: "Α", en: "A" }, to: { en: "A", el: "Α", ru: "Б" } } },
      everything,
    );
    expect(out.title).toEqual({ from_set: true, to_set: true, keys: ["ru"] });
  });

  it("decides per field", () => {
    const out = changesForChain(
      { notes: { from: "a", to: "b" }, price: { from: 1, to: 2 } },
      (field) => field === "notes",
    );
    expect(out).toEqual({ notes: { from_set: true, to_set: true }, price: { from: 1, to: 2 } });
  });
});

describe("isNoteField", () => {
  it.each(["notes", "internal_notes", "commission_split_notes", "gdpr_notes"])("%s is a note", (f) => {
    expect(isNoteField(f)).toBe(true);
  });
  it.each(["status", "notes_count", "title", "annotation"])("%s is not", (f) => {
    expect(isNoteField(f)).toBe(false);
  });
});

describe("contactShapeOnly — an allow-list, so a new contact column fails closed", () => {
  it.each([
    "contact_kind",
    "contact_types",
    "temperature",
    "source",
    "preferred_channel",
    "has_whatsapp",
    "consent_marketing",
    "consent_at",
    "assigned_agent_id",
  ])("%s keeps its values", (f) => {
    expect(contactShapeOnly(f)).toBe(false);
  });

  it.each([
    "first_name",
    "last_name",
    "company_name",
    "phone_e164",
    "phone_raw",
    "email",
    "telegram_username",
    "languages",
    "nationality",
    "source_detail",
    "psychology",
    "gdpr_notes",
    "notes",
    "kyc",
    "banking_readiness",
    "a_column_added_next_year",
  ])("%s records shape only", (f) => {
    expect(contactShapeOnly(f)).toBe(true);
  });
});
