import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { buildMergeBackfill, mergeNoteMarker } from "./merge-backfill";

type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];

let seq = 0;
function contact(overrides: Partial<ContactRow> = {}): ContactRow {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-0000000000${String(seq).padStart(2, "0")}`,
    org_id: "00000000-0000-0000-0000-000000000001",
    contact_kind: "person",
    first_name: "Test",
    last_name: `Contact${seq}`,
    company_name: null,
    display_name: `Test Contact${seq}`,
    phone_e164: null,
    phone_raw: null,
    additional_phones: [],
    email: null,
    telegram_username: null,
    has_whatsapp: false,
    languages: ["en"],
    nationality: null,
    contact_types: [],
    temperature: "warm",
    source: null,
    source_detail: null,
    assigned_agent_id: null,
    preferred_channel: null,
    psychology: null,
    preferences: {},
    kyc: {},
    banking_readiness: {},
    consent_marketing: false,
    consent_at: null,
    gdpr_notes: null,
    notes: null,
    is_archived: false,
    merged_into_id: null,
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as ContactRow;
}

describe("buildMergeBackfill", () => {
  it("inherits the duplicate's phone when the primary has none", () => {
    const { updates } = buildMergeBackfill(
      contact({ phone_e164: null }),
      contact({ phone_e164: "+35799111111", phone_raw: "99 111111" }),
    );
    expect(updates.phone_e164).toBe("+35799111111");
    expect(updates.phone_raw).toBe("99 111111");
    expect(updates.additional_phones).toBeUndefined();
  });

  it("parks a conflicting duplicate phone in additional_phones", () => {
    const { updates } = buildMergeBackfill(
      contact({ phone_e164: "+35799222222" }),
      contact({ phone_e164: "+35799111111", additional_phones: ["+35799333333"] }),
    );
    expect(updates.phone_e164).toBeUndefined();
    expect(updates.additional_phones).toEqual(["+35799111111", "+35799333333"]);
  });

  it("never lists the primary's own number as additional", () => {
    const { updates } = buildMergeBackfill(
      contact({ phone_e164: null, additional_phones: [] }),
      contact({ phone_e164: "+35799111111", additional_phones: ["+35799111111"] }),
    );
    expect(updates.phone_e164).toBe("+35799111111");
    expect(updates.additional_phones).toBeUndefined();
  });

  it("backfills empty email but records a conflicting one as dropped", () => {
    const empty = buildMergeBackfill(contact(), contact({ email: "dup@x.com" }));
    expect(empty.updates.email).toBe("dup@x.com");
    expect(empty.dropped.email).toBeUndefined();

    const conflict = buildMergeBackfill(
      contact({ email: "primary@x.com" }),
      contact({ email: "dup@x.com" }),
    );
    expect(conflict.updates.email).toBeUndefined();
    expect(conflict.dropped.email).toBe("dup@x.com");
  });

  it("unions types and languages sorted, skipping same-set no-ops", () => {
    const grow = buildMergeBackfill(
      contact({ contact_types: ["seller"], languages: ["en"] }),
      contact({ contact_types: ["buyer"], languages: ["ru", "en"] }),
    );
    expect(grow.updates.contact_types).toEqual(["buyer", "seller"]);
    expect(grow.updates.languages).toEqual(["en", "ru"]);

    const same = buildMergeBackfill(
      contact({ contact_types: ["buyer", "seller"] }),
      contact({ contact_types: ["seller", "buyer"] }),
    );
    expect(same.updates.contact_types).toBeUndefined();
  });

  it("moves checklists wholesale only into an empty primary", () => {
    const kyc = { passport_id: { done: true } };
    const filled = buildMergeBackfill(
      contact({ kyc: { proof_of_address: { done: true } } }),
      contact({ kyc }),
    );
    expect(filled.updates.kyc).toBeUndefined();

    const empty = buildMergeBackfill(contact({ kyc: {} }), contact({ kyc }));
    expect(empty.updates.kyc).toEqual(kyc);
  });

  it("backfills assignment and psychology when the primary has none", () => {
    const { updates } = buildMergeBackfill(
      contact(),
      contact({
        assigned_agent_id: "00000000-0000-0000-0000-0000000000aa",
        psychology: "investor",
        source: "referral",
        source_detail: "friend of Maria",
      }),
    );
    expect(updates.assigned_agent_id).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(updates.psychology).toBe("investor");
    expect(updates.source).toBe("referral");
    expect(updates.source_detail).toBe("friend of Maria");
  });

  it("appends notes exactly once — a resumed merge must not double-append", () => {
    const dup = contact({ notes: "prefers seafront" });
    const first = buildMergeBackfill(contact({ notes: "existing" }), dup);
    const marker = mergeNoteMarker(dup);
    expect(first.updates.notes).toBe(`existing\n${marker}: prefers seafront`);

    const resumed = buildMergeBackfill(
      contact({ notes: first.updates.notes as string }),
      dup,
    );
    expect(resumed.updates.notes).toBeUndefined();
  });

  it("returns no updates for two blank contacts", () => {
    const { updates, dropped } = buildMergeBackfill(contact(), contact());
    expect(Object.keys(updates)).toHaveLength(0);
    expect(Object.keys(dropped)).toHaveLength(0);
  });
});
