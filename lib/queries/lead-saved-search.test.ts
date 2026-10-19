import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_SEARCH_FILTER,
  LEAD_CONTACT_EMBED,
  SEARCH_EMBED_TABLE,
  savedSearchOffer,
  savedSearchState,
} from "./lead-saved-search";
import { LEAD_MESSAGE_REDACTED } from "@/lib/services/erasure";

/**
 * The inbox row's saved-search state (A04). "Unknown" is never drawn as
 * "none", a seller's enquiry is not nagged for a buyer's search, and "Save
 * brief as search" is offered only where saveSearchFromEnquiry can succeed.
 * The embed's PostgREST shape is proven against the real stack in
 * supabase/tests/match-workflow.test.ts.
 */

const BUYER = { looking_to: "buy", budget: "300_500k" };
const SELLER = { district: "Paphos", property_type: "villa" };
const lead = (over: Record<string, unknown> = {}) => ({
  source: "website",
  message: "Website enquiry",
  criteria: BUYER,
  contact_id: "c1",
  ...over,
});
const live = { is_archived: false, erased_at: null };

describe("savedSearchState", () => {
  it("has / none from the embedded array, unknown from anything else", () => {
    expect(savedSearchState({ buyer_requirements: [{ id: "r1" }] })).toBe("has");
    expect(savedSearchState({ buyer_requirements: [] })).toBe("none");
    expect(savedSearchState({ buyer_requirements: null })).toBe("unknown");
    expect(savedSearchState({})).toBe("unknown");
    expect(savedSearchState(null)).toBe("unknown");
  });
});

describe("savedSearchOffer", () => {
  it("a linked website buyer with no search: shown, add one, and Save brief as search", () => {
    expect(savedSearchOffer({ lead: lead(), contact: live, state: "none", role: "agent" })).toEqual({
      show: true,
      canAdd: true,
      canSaveBrief: true,
    });
  });

  it("a listing manager may too — the 0043 policies are org-wide", () => {
    expect(savedSearchOffer({ lead: lead(), contact: live, state: "none", role: "listing_manager" }).canSaveBrief).toBe(true);
  });

  it("a search already there: shown as such, nothing to add", () => {
    expect(savedSearchOffer({ lead: lead(), contact: live, state: "has", role: "agent" })).toEqual({
      show: true,
      canAdd: false,
      canSaveBrief: false,
    });
  });

  it("unknown: shown as unknown, nothing offered that it cannot vouch for", () => {
    expect(savedSearchOffer({ lead: lead(), contact: live, state: "unknown", role: "agent" })).toEqual({
      show: true,
      canAdd: false,
      canSaveBrief: false,
    });
  });

  it("an unlinked lead shows nothing — a search belongs to a contact", () => {
    expect(savedSearchOffer({ lead: lead({ contact_id: null }), contact: null, state: "unknown", role: "agent" }).show).toBe(false);
  });

  it("a seller's enquiry is not asked for a buyer's search", () => {
    expect(savedSearchOffer({ lead: lead({ criteria: SELLER }), contact: live, state: "none", role: "agent" }).show).toBe(false);
    // but a seller who also has a search still shows it
    expect(savedSearchOffer({ lead: lead({ criteria: SELLER }), contact: live, state: "has", role: "agent" }).show).toBe(true);
  });

  it("a phone lead: add one, but no brief to save", () => {
    expect(savedSearchOffer({ lead: lead({ source: "phone", criteria: null }), contact: live, state: "none", role: "agent" })).toEqual({
      show: true,
      canAdd: true,
      canSaveBrief: false,
    });
  });

  it("a redacted enquiry offers no brief to save", () => {
    expect(
      savedSearchOffer({ lead: lead({ message: LEAD_MESSAGE_REDACTED }), contact: live, state: "none", role: "agent" }).canSaveBrief,
    ).toBe(false);
  });

  it("an archived or erased contact with no search: nothing to show or add", () => {
    for (const contact of [{ is_archived: true, erased_at: null }, { is_archived: true, erased_at: "2026-10-01" }]) {
      expect(savedSearchOffer({ lead: lead(), contact, state: "none", role: "admin" }).show).toBe(false);
      expect(savedSearchOffer({ lead: lead(), contact, state: "has", role: "admin" })).toEqual({
        show: true,
        canAdd: false,
        canSaveBrief: false,
      });
    }
  });
});

describe("the inbox read uses exactly these pieces", () => {
  it("the embed asks for the lifecycle and the searches, and both narrowings target the embedded searches", () => {
    expect(LEAD_CONTACT_EMBED).toMatch(/^contacts\(.*\bis_archived\b.*\berased_at\b.*buyer_requirements\(id\)\)$/);
    expect(ACTIVE_SEARCH_FILTER).toEqual(["contacts.buyer_requirements.is_active", true]);
    expect(SEARCH_EMBED_TABLE).toBe("contacts.buyer_requirements");
  });

  it("the leads page applies them (read as source: a page cannot be imported without a request)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const src = readFileSync(join(root, "app", "(app)", "leads", "page.tsx"), "utf-8");
    expect(src).toContain("${LEAD_CONTACT_EMBED}");
    expect(src).toMatch(/\.eq\(\.\.\.ACTIVE_SEARCH_FILTER\)/);
    expect(src).toMatch(/\.limit\(1, \{ referencedTable: SEARCH_EMBED_TABLE \}\)/);
  });
});
